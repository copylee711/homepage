<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { fetchJson } from '../../content'
import { formatSize, formatTime, query } from '../../drive'
import type { DriveEntry } from '../../drive'
import '../../styles/drive.css'
import DriveTopBar from './DriveTopBar.vue'
import PreviewDialog from './PreviewDialog.vue'
import { kindIcons, kindOf, previewable } from './fileKinds'

type Info = { id: string; name: string; mode: 'read' | 'upload'; expires_at: number; needs_password: boolean; unlocked: boolean; single_dir?: boolean }
const shareId = location.pathname.split('/').filter(Boolean)[1] ?? ''
const base = `/api/s/${encodeURIComponent(shareId)}`
const info = ref<Info>()
const path = ref('/')
const items = ref<DriveEntry[]>([])
const password = ref('')
const loading = ref(true), busy = ref(false), error = ref(''), notice = ref('')
const preview = ref<DriveEntry>()
const uploads = ref<{ name: string; size: number; sent: number; state: 'uploading' | 'done' | 'error'; error?: string }[]>([])

const crumbs = computed(() => {
  const parts = path.value.split('/').filter(Boolean)
  return [{ name: info.value?.name ?? '分享', path: '/' }, ...parts.map((name, i) => ({ name, path: '/' + parts.slice(0, i + 1).join('/') }))]
})
const fileUrl = (target: string, inline = false) => `${base}/download?${query({ path: target, ...(inline ? { inline: '1' } : {}) })}`
const date = (seconds: number) => formatTime(seconds)

async function loadInfo() {
  info.value = await fetchJson<Info>(base, { credentials: 'same-origin' })
  document.title = `${info.value.name} · Copy Lee Cloud`
}
async function open(target = path.value) {
  error.value = ''
  try {
    const data = await fetchJson<{ path: string; items: DriveEntry[] }>(`${base}/list?${query({ path: target })}`, { credentials: 'same-origin' })
    path.value = data.path; items.value = data.items
  } catch (err) { error.value = err instanceof Error ? err.message : '读取失败' }
}
async function unlock() {
  if (busy.value) return
  busy.value = true; error.value = ''
  try {
    await fetchJson(`${base}/unlock`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: password.value }) })
    await loadInfo()
    if (info.value?.mode === 'read') await open('/')
  } catch (err) { error.value = err instanceof Error ? err.message : '密码错误' }
  finally { busy.value = false }
}
function activate(entry: DriveEntry) {
  if (entry.dir) void open(entry.path)
  else if (previewable(kindOf(entry.name))) preview.value = entry
  else location.href = fileUrl(entry.path)
}

function send(file: File) {
  const task = { name: file.name, size: file.size, sent: 0, state: 'uploading' as const }
  uploads.value.unshift(task)
  const current = uploads.value[0]!
  return new Promise<void>(resolve => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', `${base}/upload?${query({ name: file.name })}`)
    xhr.upload.onprogress = event => { current.sent = event.loaded }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { current.state = 'done'; current.sent = file.size }
      else {
        current.state = 'error'
        try { current.error = JSON.parse(xhr.responseText).detail } catch { current.error = `上传失败 (${xhr.status})` }
      }
      resolve()
    }
    xhr.onerror = () => { current.state = 'error'; current.error = '网络中断'; resolve() }
    xhr.send(file)
  })
}
async function pick(event: Event) {
  const input = event.target as HTMLInputElement
  const files = [...input.files ?? []]
  input.value = ''
  for (const file of files) await send(file)
  if (uploads.value.some(item => item.state === 'done')) notice.value = '上传完成，谢谢！'
}

onMounted(async () => {
  try {
    await loadInfo()
    if (info.value?.unlocked && info.value.mode === 'read') await open('/')
  } catch (err) { error.value = err instanceof Error ? err.message : '分享不存在' }
  finally { loading.value = false }
})
</script>

<template>
  <DriveTopBar />
  <section class="share-page">
    <div class="container">
      <p v-if="loading" class="d-muted">正在打开分享…</p>
      <div v-else-if="!info" class="card center"><h1>链接无效</h1><p class="d-muted">{{ error || '分享不存在、已过期或已被取消。' }}</p></div>
      <div v-else-if="!info.unlocked" class="card center narrow">
        <p class="eyebrow">Shared with you</p><h1>{{ info.name }}</h1>
        <p class="d-muted">这个分享需要提取密码。</p>
        <form @submit.prevent="unlock"><input v-model="password" class="d-input" type="password" autocomplete="off" required placeholder="提取密码" aria-label="提取密码"><button class="d-btn primary wide" type="submit" :disabled="busy">{{ busy ? '验证中…' : '打开' }}</button></form>
        <p v-if="error" class="d-note error" role="alert">{{ error }}</p>
      </div>
      <div v-else-if="info.mode === 'upload'" class="card center narrow">
        <p class="eyebrow">Upload</p><h1>{{ info.name }}</h1>
        <p class="d-muted">你可以向这个文件夹上传文件，但看不到其中已有的内容。{{ info.expires_at ? `链接有效期至 ${date(info.expires_at)}。` : '' }}</p>
        <label class="d-btn primary wide picker">选择文件上传<input type="file" multiple @change="pick"></label>
        <p v-if="notice" class="d-note ok" role="status">{{ notice }}</p>
        <ul class="uploads">
          <li v-for="(item, i) in uploads" :key="i" :class="item.state"><span>{{ item.name }}</span><small>{{ item.state === 'error' ? item.error : item.state === 'done' ? '已上传' : `${formatSize(item.sent)} / ${formatSize(item.size)}` }}</small></li>
        </ul>
      </div>
      <div v-else class="browser">
        <header>
          <div><p class="eyebrow">Shared with you</p><h1>{{ info.name }}</h1><p v-if="info.expires_at" class="d-muted">有效期至 {{ date(info.expires_at) }}</p></div>
          <a v-if="path === '/' && items.length === 1 && !items[0]!.dir" class="d-btn primary" :href="fileUrl(items[0]!.path)">下载</a>
          <a v-else class="d-btn primary" :href="`${base}/zip?${query({ path: path })}`">{{ path === '/' ? '全部打包下载' : '打包下载此目录' }}</a>
        </header>
        <nav class="crumbs" aria-label="当前位置"><template v-for="(crumb, i) in crumbs" :key="crumb.path"><span v-if="i" aria-hidden="true">/</span><button type="button" @click="open(crumb.path)">{{ crumb.name }}</button></template></nav>
        <p v-if="error" class="d-note error" role="alert">{{ error }}</p>
        <ul class="list">
          <li v-for="item in items" :key="item.path">
            <button type="button" class="name" @click="activate(item)"><svg class="icon" :class="kindOf(item.name, item.dir)" viewBox="0 0 24 24" aria-hidden="true"><path :d="kindIcons[kindOf(item.name, item.dir)]" /></svg><span>{{ item.name }}</span></button>
            <span class="size">{{ item.dir ? '—' : formatSize(item.size) }}</span>
            <a v-if="!item.dir" class="d-btn" :href="fileUrl(item.path)">下载</a><span v-else />
          </li>
        </ul>
        <p v-if="!items.length && !error" class="d-muted empty">这里是空的。</p>
      </div>
    </div>
    <PreviewDialog v-if="preview" :entry="preview" :siblings="items" :url="inline => fileUrl(preview!.path, inline)" @close="preview = undefined" @open="entry => preview = entry" />
  </section>
</template>

<style scoped>
.share-page { min-height:70vh; padding:48px 0 72px; }
.card { padding:36px; border:1px solid var(--line); border-radius:var(--radius); background:var(--surface); box-shadow:0 30px 60px -40px rgba(17,24,39,.35); }
.center { max-width:640px; margin:0 auto; text-align:center; }
.narrow { max-width:440px; }
.eyebrow { margin:0; font-size:11px; color:var(--faint); letter-spacing:.14em; text-transform:uppercase; }
h1 { margin-top:6px; font-size:28px; letter-spacing:-.02em; overflow-wrap:anywhere; }
.card .d-muted { margin-top:10px; line-height:1.7; }
form { display:grid; gap:12px; margin-top:22px; }
.wide { width:100%; }
.picker { position:relative; overflow:hidden; margin-top:22px; padding:12px; }
.picker input { position:absolute; inset:0; opacity:0; cursor:pointer; }
.uploads { list-style:none; margin:18px 0 0; padding:0; text-align:left; }
.uploads li { display:flex; justify-content:space-between; gap:12px; padding:8px 0; border-top:1px solid var(--line); font-size:13px; }
.uploads span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.uploads small { flex:none; color:var(--faint); font:12px var(--font-mono); }
.uploads li.done small { color:#2fa36b; }
.uploads li.error small { color:#d15c5c; font-family:var(--font); }
.browser header { display:flex; align-items:flex-end; justify-content:space-between; gap:16px; flex-wrap:wrap; }
.crumbs { display:flex; flex-wrap:wrap; align-items:center; gap:4px; margin-top:24px; color:var(--faint); font-size:14px; }
.crumbs button { padding:3px 6px; border:0; border-radius:6px; background:none; color:var(--text-2); font:inherit; cursor:pointer; }
.crumbs button:hover { background:var(--bg-tint); }
.list { list-style:none; margin:12px 0 0; padding:0; border-top:1px solid var(--line); }
.list li { display:grid; grid-template-columns:minmax(0,1fr) 100px 80px; align-items:center; gap:12px; min-height:54px; border-bottom:1px solid var(--line); }
.name { display:flex; align-items:center; gap:12px; min-width:0; padding:8px 4px; border:0; background:none; color:var(--text); font:14px var(--font); text-align:left; cursor:pointer; }
.name span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.name:hover span { color:var(--accent); }
.size { text-align:right; color:var(--muted); font:12px var(--font-mono); }
.icon { flex:none; width:22px; height:22px; fill:none; stroke:var(--muted); stroke-width:1.5; stroke-linejoin:round; stroke-linecap:round; }
.icon.folder { fill:var(--accent-soft); stroke:var(--accent); }
.empty { padding:32px 0; }
@media (max-width:600px) { .list li { grid-template-columns:minmax(0,1fr) 80px; } .list li > :last-child { display:none; } .card { padding:28px 20px; } }
</style>

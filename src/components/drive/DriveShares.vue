<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { driveApi, formatTime } from '../../drive'
import type { DriveShare } from '../../drive'

const items = ref<DriveShare[]>([])
const loading = ref(true), error = ref(''), notice = ref('')
const time = (seconds: number) => formatTime(seconds)
const expired = (share: DriveShare) => (share.expires_at && share.expires_at * 1000 < Date.now()) || (share.max_uses > 0 && share.used >= share.max_uses)

async function load() {
  loading.value = true; error.value = ''
  try { items.value = (await driveApi<{ items: DriveShare[] }>('/shares')).items }
  catch (err) { error.value = err instanceof Error ? err.message : '读取失败' }
  finally { loading.value = false }
}
async function copy(share: DriveShare) {
  try { await navigator.clipboard.writeText(share.url); notice.value = '链接已复制' } catch { error.value = '复制失败，请手动复制' }
}
async function remove(share: DriveShare) {
  if (!confirm(`取消分享「${share.name}」？链接会立即失效。`)) return
  try { await driveApi(`/shares/${share.id}/remove`, 'POST'); items.value = items.value.filter(item => item !== share); notice.value = '已取消分享' }
  catch (err) { error.value = err instanceof Error ? err.message : '操作失败' }
}
onMounted(load)
</script>

<template>
  <section class="shares">
    <header><div><h2>我的分享</h2><p class="d-muted">在文件列表中选中文件或文件夹，点击“分享”即可创建链接。</p></div><button class="d-btn" type="button" @click="load">刷新</button></header>
    <p v-if="error" class="d-note error" role="alert">{{ error }}</p>
    <p v-if="notice" class="d-note ok" role="status">{{ notice }}</p>
    <p v-if="!loading && !items.length" class="d-muted empty">还没有分享。</p>
    <ul>
      <li v-for="share in items" :key="share.id" :class="{ expired: expired(share) }">
        <div class="info">
          <strong>{{ share.name }}<span class="tag">{{ share.mode === 'upload' ? '仅上传' : '查看下载' }}</span><span v-if="share.has_password" class="tag">有密码</span><span v-if="expired(share)" class="tag warn">已失效</span></strong>
          <span>{{ share.paths.join('、') }}</span>
          <small>创建于 {{ time(share.created_at) }} · {{ share.expires_at ? `有效期至 ${time(share.expires_at)}` : '长期有效' }} · 已使用 {{ share.used }}{{ share.max_uses ? ` / ${share.max_uses}` : '' }} 次{{ share.last_used ? ` · 最近 ${time(share.last_used)}` : '' }}</small>
        </div>
        <div class="buttons"><button class="d-btn" type="button" @click="copy(share)">复制链接</button><a class="d-btn" :href="share.url" target="_blank" rel="noopener">打开</a><button class="d-btn danger" type="button" @click="remove(share)">取消分享</button></div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
header { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
h2 { font-size:20px; }
header p { margin-top:4px; }
ul { list-style:none; margin:16px 0 0; padding:0; border-top:1px solid var(--line); }
li { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:16px 4px; border-bottom:1px solid var(--line); }
li.expired .info { opacity:.55; }
.info { display:flex; flex-direction:column; gap:4px; min-width:0; }
.info strong { font-weight:500; overflow-wrap:anywhere; }
.info span { color:var(--muted); font-size:13px; overflow-wrap:anywhere; }
.info small { color:var(--faint); font:12px var(--font-mono); }
.tag { margin-left:8px; padding:1px 8px; border:1px solid var(--line); border-radius:999px; color:var(--muted); font-size:11px; font-weight:400; }
.tag.warn { border-color:rgba(209,92,92,.4); color:#d15c5c; }
.buttons { display:flex; flex-wrap:wrap; gap:8px; flex:none; }
.empty { padding:32px 0; }
@media (max-width:760px) {
  h2 { font-size:22px; }
  ul { border-top:0; }
  li { flex-direction:column; align-items:stretch; gap:12px; margin-top:12px; padding:16px; border:1px solid var(--line); border-radius:16px; background:var(--surface); }
  .info small { font-family:var(--font); line-height:1.6; }
  .buttons { display:grid; grid-template-columns:repeat(3,1fr); }
  .buttons .d-btn { padding:9px 4px; }
}
</style>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { account, accountChecked, loadAccount } from '../../account'
import { accountUrl } from '../../drive'
import '../../styles/drive.css'
import { confirmDialog, promptDialog } from '../../composables/useConfirm'
import { docUrl, docsApi, roleName, timeAgo } from '../../docs'
import type { DocItem } from '../../docs'
import ImageSettings from './ImageSettings.vue'

const owned = ref<DocItem[]>([])
const shared = ref<DocItem[]>([])
const canCreate = ref(false)
const loading = ref(true), error = ref('')
const tab = ref<'owned' | 'shared'>('owned')
const imageSettings = ref(false)
const items = computed(() => tab.value === 'owned' ? owned.value : shared.value)

async function load() {
  await loadAccount()
  if (!account.value) { loading.value = false; return }
  loading.value = true; error.value = ''
  try {
    const data = await docsApi<{ can_create: boolean; owned: DocItem[]; shared: DocItem[] }>('')
    owned.value = data.owned; shared.value = data.shared; canCreate.value = data.can_create
    if (!owned.value.length && shared.value.length) tab.value = 'shared'
  } catch (err) { error.value = err instanceof Error ? err.message : '读取失败' }
  finally { loading.value = false }
}

async function create() {
  const title = await promptDialog({ title: '新建文档', value: '', input: { placeholder: '文档标题' }, confirmText: '创建' })
  if (title === null) return
  try { location.href = docUrl((await docsApi<DocItem>('', 'POST', { title })).id) }
  catch (err) { error.value = err instanceof Error ? err.message : '创建失败' }
}

async function rename(doc: DocItem) {
  const title = await promptDialog({ title: '重命名', value: doc.title, confirmText: '保存' })
  if (!title) return
  try { Object.assign(doc, await docsApi<DocItem>(`/${doc.id}`, 'PATCH', { title })) }
  catch (err) { error.value = err instanceof Error ? err.message : '重命名失败' }
}

async function remove(doc: DocItem) {
  if (!await confirmDialog({ title: `删除「${doc.title}」？`, message: '文档、版本历史与所有分享会一起删除，无法恢复。', confirmText: '删除', danger: true })) return
  try { await docsApi(`/${doc.id}`, 'DELETE'); owned.value = owned.value.filter(item => item !== doc) }
  catch (err) { error.value = err instanceof Error ? err.message : '删除失败' }
}

onMounted(load)
</script>

<template>
  <section v-if="accountChecked && !account" class="docs signin">
    <h2>文档</h2>
    <p class="d-muted">登录后查看你的文档和别人与你共享的文档。</p>
    <a class="d-btn primary" :href="accountUrl()">登录</a>
  </section>
  <section v-else class="docs">
    <header>
      <div><h2>文档</h2><p class="d-muted">支持 Markdown 的在线文档，可以邀请他人实时协作。</p></div>
      <div class="head-actions">
        <button class="d-btn" type="button" @click="imageSettings = true">图片存储</button>
        <button v-if="canCreate" class="d-btn primary" type="button" @click="create">＋ 新建文档</button>
      </div>
    </header>
    <div class="tabs" role="tablist">
      <button type="button" role="tab" :aria-selected="tab === 'owned'" :class="{ on: tab === 'owned' }" @click="tab = 'owned'">我的文档<span>{{ owned.length }}</span></button>
      <button type="button" role="tab" :aria-selected="tab === 'shared'" :class="{ on: tab === 'shared' }" @click="tab = 'shared'">与我共享<span>{{ shared.length }}</span></button>
    </div>
    <p v-if="error" class="d-note error" role="alert">{{ error }}</p>
    <p v-if="loading" class="d-muted empty">正在读取…</p>
    <div v-else-if="!items.length" class="empty-state">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20V3.5ZM14 3.5V8h4M10 12h5M10 15.5h5" /></svg>
      <p v-if="tab === 'owned'">{{ canCreate ? '还没有文档，新建一篇开始写作。' : '文档功能随云盘开通。别人分享给你的文档会出现在“与我共享”。' }}</p>
      <p v-else>还没有人与你共享文档。</p>
    </div>
    <ul v-else>
      <li v-for="doc in items" :key="doc.id">
        <a class="main" :href="docUrl(doc.id)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20V3.5ZM14 3.5V8h4M10 12h5M10 15.5h5" /></svg>
          <span class="text">
            <strong>{{ doc.title }}</strong>
            <small>
              <template v-if="tab === 'shared'">{{ doc.owner?.name }} · {{ roleName[doc.role] }} · </template>
              <template v-if="doc.team">团队 {{ doc.team.name }} · </template>{{ timeAgo(doc.updated_at) }}更新<template v-if="doc.updated_by && doc.updated_by.id !== doc.owner?.id"> · {{ doc.updated_by.name }}</template>
              <template v-if="doc.link && doc.link.role !== 'none'"> · 链接{{ roleName[doc.link.role] }}</template>
            </small>
          </span>
        </a>
        <div v-if="doc.role === 'owner'" class="buttons">
          <button class="d-btn" type="button" @click="rename(doc)">重命名</button>
          <button class="d-btn danger" type="button" @click="remove(doc)">删除</button>
        </div>
      </li>
    </ul>
    <ImageSettings v-if="imageSettings" @close="imageSettings = false" />
  </section>
</template>

<style scoped>
.head-actions { display:flex; gap:8px; flex:none; }
.signin { display:grid; justify-items:start; gap:12px; }
header { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
h2 { font-size:20px; }
header p { margin-top:4px; }
.tabs { display:flex; gap:6px; margin-top:18px; }
.tabs button { display:flex; align-items:center; gap:6px; padding:7px 14px; border:1px solid var(--line); border-radius:999px; background:none; color:var(--text-2); font:13px var(--font); cursor:pointer; transition:all .2s; }
.tabs button span { color:var(--faint); font-size:12px; }
.tabs button.on { border-color:var(--accent); background:var(--accent-soft); color:var(--accent); }
.tabs button.on span { color:inherit; }
ul { list-style:none; margin:16px 0 0; padding:0; border-top:1px solid var(--line); }
li { display:flex; align-items:center; justify-content:space-between; gap:16px; border-bottom:1px solid var(--line); }
.main { flex:1; display:flex; align-items:center; gap:14px; min-width:0; padding:14px 4px; border-radius:10px; transition:background .2s; }
.main:hover strong { color:var(--accent); }
.main svg, .empty-state svg { flex:none; width:26px; height:26px; fill:none; stroke:var(--accent); stroke-width:1.5; stroke-linecap:round; stroke-linejoin:round; }
.text { display:flex; flex-direction:column; gap:3px; min-width:0; }
.text strong { font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; transition:color .2s; }
.text small { color:var(--faint); font-size:12.5px; }
.buttons { display:flex; gap:8px; flex:none; opacity:.0; transition:opacity .2s; }
li:hover .buttons, li:focus-within .buttons { opacity:1; }
.empty { padding:32px 0; }
.empty-state { display:grid; justify-items:center; gap:12px; padding:56px 16px; color:var(--muted); font-size:14px; text-align:center; }
.empty-state svg { width:40px; height:40px; stroke:var(--faint); }
@media (hover:none) { .buttons { opacity:1; } }
@media (max-width:760px) {
  h2 { font-size:22px; }
  li { flex-direction:column; align-items:stretch; gap:0; }
  .buttons { padding:0 4px 12px 44px; }
}
</style>

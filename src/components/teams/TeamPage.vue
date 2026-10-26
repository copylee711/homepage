<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { account, accountChecked, loadAccount } from '../../account'
import { promptDialog } from '../../composables/useConfirm'
import { accountUrl, driveTeam, formatSize, joinPath, mainSite } from '../../drive'
import type { DriveEntry } from '../../drive'
import { docUrl } from '../../docs'
import '../../styles/drive.css'
import { roleLabel, teamsApi } from '../../teams'
import type { Team, TreeItem } from '../../teams'
import DriveFiles from '../drive/DriveFiles.vue'
import DriveTopBar from '../drive/DriveTopBar.vue'
import TeamAccess from './TeamAccess.vue'
import TeamMembers from './TeamMembers.vue'
import TeamSettings from './TeamSettings.vue'
import TeamTree from './TeamTree.vue'
import TextEditor from './TextEditor.vue'

// 团队工作区：左侧文件树，右侧是当前文件夹的文件管理（复用云盘组件，接口带上团队代号）。
const id = /^\/t\/([a-z0-9]+)\/?$/.exec(location.pathname)?.[1] ?? ''
driveTeam.value = id

const team = ref<Team>()
const tree = ref<TreeItem[]>([])
const state = ref<'loading' | 'ready' | 'gone'>('loading'), error = ref('')
const current = ref('/')
const files = ref<InstanceType<typeof DriveFiles>>()
const dialog = ref<'members' | 'access' | 'settings' | null>(null)
const editing = ref<{ path: string; create?: boolean } | null>(null)
const canEdit = computed(() => team.value?.role === 'owner' || team.value?.role === 'edit')
const percent = computed(() => team.value?.quota ? Math.min(100, team.value.used / team.value.quota * 100) : 0)
const listUrl = `${mainSite}/teams`

async function load() {
  await loadAccount()
  if (!account.value) return
  try {
    team.value = await teamsApi<Team>(`/${id}`)
    document.title = `${team.value.name} · 团队 · Copy Lee`
    state.value = 'ready'
    await loadTree()
  } catch (err) {
    error.value = err instanceof Error ? err.message : '读取失败'
    state.value = 'gone'
  }
}

async function loadTree() {
  try { tree.value = (await teamsApi<{ items: TreeItem[] }>(`/${id}/tree`)).items }
  catch (err) { error.value = err instanceof Error ? err.message : '文件树读取失败' }
}
async function changed() {
  await loadTree()
  try { team.value = await teamsApi<Team>(`/${id}`) } catch { /* 用量稍后刷新 */ }
}

function select(item: TreeItem | null) {
  if (!item) { void files.value?.open('/'); return }
  if (item.dir) { void files.value?.open(item.path); return }
  if (item.doc) { location.href = docUrl(item.doc); return }
  const parent = item.path.slice(0, item.path.lastIndexOf('/')) || '/'
  if (parent !== current.value) void files.value?.open(parent)
  files.value?.activate(item as DriveEntry)
}

async function newDoc(folder: string) {
  const title = await promptDialog({ title: '新建文档', value: '', input: { placeholder: '文档标题' }, confirmText: '创建' })
  if (title === null) return
  try { location.href = docUrl((await teamsApi<{ id: string }>(`/${id}/docs`, 'POST', { title, folder })).id) }
  catch (err) { error.value = err instanceof Error ? err.message : '创建失败' }
}

async function newText(folder: string) {
  const name = await promptDialog({ title: '新建文本文件', value: '', input: { placeholder: '例如 main.py、README.md、.gitignore' }, confirmText: '创建' })
  if (!name?.trim()) return
  if (name.includes('/')) { error.value = '文件名不能包含 /'; return }
  editing.value = { path: joinPath(folder, name.trim()), create: true }
}

const openText = (entry: DriveEntry) => { editing.value = { path: entry.path } }
const goDoc = (doc: string) => { location.href = docUrl(doc) }
const goList = () => { location.href = listUrl }

onMounted(load)
</script>

<template>
  <div class="drive-shell team-shell">
    <DriveTopBar />
    <main v-if="!accountChecked || (account && state === 'loading')" class="state"><p class="d-muted">正在打开团队…</p></main>
    <main v-else-if="!account" class="state">
      <div class="state-card"><h1>登录后查看团队</h1><p>团队只对成员开放。</p><a class="d-btn primary" :href="accountUrl()">登录</a></div>
    </main>
    <main v-else-if="state === 'gone' || !team" class="state">
      <div class="state-card"><h1>打不开这个团队</h1><p>{{ error || '团队不存在，或者你不是它的成员。' }}</p><a class="d-btn" :href="listUrl">我的团队</a></div>
    </main>
    <div v-else class="layout">
      <aside class="side">
        <a class="back" :href="listUrl">‹ 全部团队</a>
        <TeamTree :items="tree" :name="team.name" :current="current" @select="select" />
        <div class="usage" :title="`团队空间：已用 ${formatSize(team.used)}，共 ${formatSize(team.quota)}`">
          <div class="bar" role="progressbar" :aria-valuenow="Math.round(percent)" aria-valuemin="0" aria-valuemax="100"><span :style="{ width: `${percent}%` }" /></div>
          <p><strong>{{ formatSize(team.used) }}</strong> / {{ formatSize(team.quota) }}</p>
        </div>
      </aside>
      <main class="content">
        <header class="team-head">
          <div class="title">
            <h1>{{ team.name }}</h1>
            <p class="d-muted">{{ roleLabel[team.role] }} · {{ team.members }} 位成员<template v-if="team.description"> · {{ team.description }}</template></p>
          </div>
          <div class="head-actions">
            <button class="d-btn" type="button" @click="dialog = 'members'">成员</button>
            <button class="d-btn" type="button" @click="dialog = 'access'">映射到本地</button>
            <button v-if="team.role === 'owner'" class="d-btn" type="button" @click="dialog = 'settings'">设置</button>
          </div>
        </header>
        <p v-if="error" class="d-note error" role="alert">{{ error }}<button class="dismiss" type="button" aria-label="关闭" @click="error = ''">×</button></p>
        <DriveFiles ref="files" team @changed="changed" @navigate="path => current = path" @open-doc="goDoc" @edit-text="openText">
          <template #tools="{ path, readOnly }">
            <button v-if="canEdit" class="d-btn" type="button" :disabled="readOnly" @click="newText(path)">新建文本</button>
            <button v-if="canEdit" class="d-btn" type="button" :disabled="readOnly" @click="newDoc(path)">新建文档</button>
          </template>
          <template #tiles="{ path, close }">
            <button v-if="canEdit" class="m-tile" type="button" @click="close(); newDoc(path)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20V3.5ZM14 3.5V8h4M10 12h5M10 15.5h5" /></svg>新建文档</button>
            <button v-if="canEdit" class="m-tile" type="button" @click="close(); newText(path)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h9l4 4v14H6Zm9 0v4h4M9 11h6m-6 3h6m-6 3h3" /></svg>新建文本</button>
          </template>
        </DriveFiles>
      </main>
    </div>
    <TeamMembers v-if="dialog === 'members' && team" :team="team" @close="dialog = null" @changed="changed" @left="goList" />
    <TeamAccess v-if="dialog === 'access' && team" :team="team" @close="dialog = null" />
    <TeamSettings v-if="dialog === 'settings' && team" :team="{ ...team }" @close="dialog = null" @saved="value => team = { ...team, ...value }" @deleted="goList" />
    <TextEditor v-if="editing && team" :team="team.id" :path="editing.path" :create="editing.create" :read-only="!canEdit" @close="editing = null" @saved="() => { files?.reload(); changed() }" />
  </div>
</template>

<style scoped>
.drive-shell { min-height:calc(100vh - 120px); }
.state { display:grid; place-items:center; min-height:60vh; padding:24px; }
.state-card { max-width:440px; padding:36px; border:1px solid var(--line); border-radius:var(--radius); background:var(--surface); text-align:center; box-shadow:0 30px 60px -40px rgba(17,24,39,.35); }
.state-card h1 { font-size:26px; letter-spacing:-.02em; }
.state-card p { margin:10px 0 22px; color:var(--muted); font-size:14px; line-height:1.7; }
.layout { display:grid; grid-template-columns:260px minmax(0,1fr); max-width:1480px; margin:0 auto; }
.side { position:sticky; top:var(--header-h); align-self:start; display:flex; flex-direction:column; gap:14px; height:calc(100vh - var(--header-h)); padding:20px 12px; border-right:1px solid var(--line); overflow:auto; }
.back { padding:0 8px; color:var(--muted); font-size:13px; }
.back:hover { color:var(--accent); }
.side :deep(.tree) { flex:1; align-content:start; }
.usage { margin:0 8px; font-size:13px; }
.usage .bar { height:6px; border-radius:999px; background:var(--bg-tint); overflow:hidden; }
.usage .bar span { display:block; height:100%; background:var(--accent); border-radius:inherit; }
.usage p { margin-top:8px; }
.content { min-width:0; padding:24px clamp(16px,3vw,40px) 64px; }
.team-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:18px; }
.team-head h1 { font-size:24px; letter-spacing:-.02em; }
.team-head p { margin-top:4px; font-size:13px; }
.head-actions { display:flex; gap:8px; flex:none; }
@media (max-width:860px) {
  .layout { grid-template-columns:1fr; }
  .side { display:none; }
  .team-head { flex-direction:column; }
  .content { padding:16px 16px 96px; }
}
</style>

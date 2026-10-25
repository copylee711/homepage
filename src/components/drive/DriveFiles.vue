<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { baseName, downloadUrl, driveApi, formatSize, isMobile, joinPath, parentPath, upload, viewportWidth, zipUrl } from '../../drive'
import type { DriveEntry, DriveListing, UploadTask } from '../../drive'
import DriveDialog from './DriveDialog.vue'
import InfoDialog from './InfoDialog.vue'
import PreviewDialog from './PreviewDialog.vue'
import ShareDialog from './ShareDialog.vue'
import TransferDialog from './TransferDialog.vue'
import { kindIcons, kindOf, middleTrim, previewable, splitName } from './fileKinds'

const emit = defineEmits<{ changed: [] }>()

const initial = new URLSearchParams(location.search).get('path') || '/'
const path = ref(initial)
const listing = ref<DriveListing>()
const loading = ref(false), error = ref(''), notice = ref('')
const selected = ref(new Set<string>())
const filter = ref('')
const sortKey = ref<'name' | 'size' | 'mtime'>('name'), sortDesc = ref(false)
const view = ref<'list' | 'grid'>((() => { try { return localStorage.getItem('copylee-drive-view') === 'grid' ? 'grid' : 'list' } catch { return 'list' } })())
const dragging = ref(false)
const tasks = reactive<UploadTask[]>([])
const queueOpen = ref(true)
let dragDepth = 0
let noticeTimer: ReturnType<typeof setTimeout> | undefined

type Dialog = { kind: 'mkdir' | 'rename'; value: string; entry?: DriveEntry } | { kind: 'transfer'; mode: 'move' | 'copy'; paths: string[] }
  | { kind: 'share'; paths: string[]; folder: boolean } | { kind: 'preview'; entry: DriveEntry } | { kind: 'info'; path: string } | null
const dialog = ref<Dialog>(null)
const dialogBusy = ref(false), dialogError = ref('')
// 移动端：搜索框默认收起，“+”与“⋯”打开底部面板。
const searchOpen = ref(false)
const sheet = ref<'add' | 'more' | null>(null)
const crumbsEl = ref<HTMLElement>()
const sortLabels = { name: '名称', size: '大小', mtime: '修改时间' } as const

const crumbs = computed(() => {
  const parts = path.value.split('/').filter(Boolean)
  return [{ name: '全部文件', path: '/' }, ...parts.map((name, i) => ({ name, path: '/' + parts.slice(0, i + 1).join('/') }))]
})
const items = computed(() => {
  const words = filter.value.trim().toLowerCase()
  const list = (listing.value?.items ?? []).filter(item => !words || item.name.toLowerCase().includes(words))
  const direction = sortDesc.value ? -1 : 1
  return [...list].sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1
    if (sortKey.value === 'name') return a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) * direction
    return ((a[sortKey.value] - b[sortKey.value]) || a.name.localeCompare(b.name)) * direction
  })
})
const chosen = computed(() => items.value.filter(item => selected.value.has(item.path)))
const allChosen = computed(() => items.value.length > 0 && chosen.value.length === items.value.length)
const readOnly = computed(() => !!listing.value?.read_only)
const selecting = computed(() => chosen.value.length > 0)
// 移动端列表文件名最多两行：按可用宽度估算可容纳的半角字符数，超出时从中间省略并保留扩展名。
const nameBudget = computed(() => Math.max(16, Math.floor((viewportWidth.value - 140) / 8.4) * 2 - 2))
const title = computed(() => baseName(path.value) || '全部文件')
const shareTarget = () => ({ kind: 'share' as const, paths: chosen.value.map(item => item.path), folder: chosen.value.length === 1 && chosen.value[0]!.dir })
const activeTasks = computed(() => tasks.filter(task => task.state === 'uploading' || task.state === 'waiting').length)
const totalProgress = computed(() => {
  const size = tasks.reduce((sum, task) => sum + task.size, 0)
  return size ? Math.round(tasks.reduce((sum, task) => sum + Math.min(task.sent, task.size), 0) / size * 100) : 0
})

function flash(text: string) {
  notice.value = text
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => { notice.value = '' }, 3500)
}
const describe = (err: unknown) => err instanceof Error ? err.message : '操作失败'
const date = (seconds: number) => seconds ? new Date(seconds * 1000).toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'

async function load(target = path.value, push = false) {
  loading.value = true; error.value = ''
  try {
    const data = await driveApi<DriveListing>(`/list?path=${encodeURIComponent(target)}`)
    listing.value = data; path.value = data.path; selected.value = new Set(); filter.value = ''
    const url = data.path === '/' ? location.pathname : `${location.pathname}?path=${encodeURIComponent(data.path)}`
    if (push) history.pushState({ path: data.path }, '', url)
    else history.replaceState({ path: data.path }, '', url)
  } catch (err) {
    error.value = describe(err)
    if ((err as { status?: number }).status === 404 && target !== '/') await load('/')
  } finally { loading.value = false }
}
const onPop = () => { void load(new URLSearchParams(location.search).get('path') || '/') }

function toggle(entry: DriveEntry, event?: MouseEvent) {
  const next = new Set(selected.value)
  // Shift 连选：从上一次选中的项到当前项。
  if (event?.shiftKey && lastPicked && next.size) {
    const list = items.value.map(item => item.path)
    const [a, b] = [list.indexOf(lastPicked), list.indexOf(entry.path)].sort((x, y) => x - y)
    for (const item of list.slice(a, b + 1)) next.add(item)
  } else if (next.has(entry.path)) next.delete(entry.path)
  else next.add(entry.path)
  lastPicked = entry.path
  selected.value = next
}
let lastPicked = ''
// 移动端：长按进入多选；多选时轻点切换选中，否则打开。
let pressTimer: ReturnType<typeof setTimeout> | undefined
let pressed = false
function pressStart(entry: DriveEntry) {
  pressed = false
  clearTimeout(pressTimer)
  pressTimer = setTimeout(() => { pressed = true; toggle(entry); navigator.vibrate?.(12) }, 450)
}
function pressEnd() { clearTimeout(pressTimer) }
function tap(entry: DriveEntry) {
  if (pressed) { pressed = false; return }
  if (selecting.value) toggle(entry)
  else activate(entry)
}
function toggleAll() { selected.value = allChosen.value ? new Set() : new Set(items.value.map(item => item.path)) }
function sortBy(key: typeof sortKey.value) {
  if (sortKey.value === key) sortDesc.value = !sortDesc.value
  else { sortKey.value = key; sortDesc.value = key !== 'name' }
}

function activate(entry: DriveEntry) {
  if (entry.dir) { void load(entry.path, true); return }
  if (previewable(kindOf(entry.name))) dialog.value = { kind: 'preview', entry }
  else location.href = downloadUrl(entry.path)
}
function download() {
  const files = chosen.value
  if (files.length === 1 && !files[0]!.dir) { location.href = downloadUrl(files[0]!.path); return }
  location.href = zipUrl(files.map(item => item.path))
}

async function act(work: () => Promise<void>, success?: string) {
  error.value = ''
  try { await work(); if (success) flash(success) } catch (err) { error.value = describe(err) }
}
const remove = () => act(async () => {
  const names = chosen.value.map(item => item.name)
  if (!confirm(`确定删除 ${names.length > 3 ? `${names.slice(0, 3).join('、')} 等 ${names.length} 项` : names.join('、')}？删除后无法恢复。`)) return
  await driveApi('/delete', 'POST', { paths: chosen.value.map(item => item.path) })
  await load(); emit('changed')
}, '已删除')

async function submitDialog() {
  const current = dialog.value
  if (!current || (current.kind !== 'mkdir' && current.kind !== 'rename') || dialogBusy.value) return
  dialogBusy.value = true; dialogError.value = ''
  try {
    const name = current.value.trim()
    if (!name) throw new Error('请输入名称')
    if (current.kind === 'mkdir') await driveApi('/mkdir', 'POST', { path: joinPath(path.value, name) })
    else if (name !== current.entry!.name) await driveApi('/rename', 'POST', { path: current.entry!.path, name })
    dialog.value = null
    await load()
    flash(current.kind === 'mkdir' ? '文件夹已创建' : '已重命名')
  } catch (err) { dialogError.value = describe(err) }
  finally { dialogBusy.value = false }
}
function openDialog(next: Dialog) { dialogError.value = ''; dialog.value = next }
async function transferred() { dialog.value = null; await load(); emit('changed'); flash('操作完成') }

// —— 上传 ——

function enqueue(files: { file: File; relative: string }[]) {
  if (readOnly.value) { error.value = '该目录只读，不能上传'; return }
  if (!files.length) return
  const base = path.value
  const existing = new Set((listing.value?.items ?? []).map(item => item.name))
  const clashes = files.filter(item => !item.relative.includes('/') && existing.has(item.relative)).length
  if (clashes && !confirm(`有 ${clashes} 个文件与当前目录中的同名文件重复，继续上传将覆盖它们。`)) return
  for (const { file, relative } of files) {
    tasks.push({ id: crypto.randomUUID(), name: relative, target: joinPath(base, relative), size: file.size, sent: 0, state: 'waiting', file })
  }
  queueOpen.value = true
  void pump()
}
let pumping = false
async function pump() {
  if (pumping) return
  pumping = true
  try {
    let next: UploadTask | undefined
    while ((next = tasks.find(task => task.state === 'waiting'))) {
      const task = next
      const folder = parentPath(task.target)
      if (folder !== '/') await driveApi('/mkdir', 'POST', { path: folder, parents: true }).catch(() => {})
      // task 取自响应式数组，修改其字段即会刷新进度显示。
      await upload(task, () => {})
      if (parentPath(task.target) === path.value || task.target.startsWith(path.value === '/' ? '/' : path.value + '/')) await load().catch(() => {})
    }
    emit('changed')
  } finally { pumping = false }
}
function retry(task: UploadTask) { task.state = 'waiting'; void pump() }
function cancel(task: UploadTask) {
  if (task.state === 'waiting') task.state = 'cancelled'
  else task.abort?.()
}
function clearFinished() {
  for (let i = tasks.length - 1; i >= 0; i--) if (['done', 'cancelled'].includes(tasks[i]!.state)) tasks.splice(i, 1)
}
function pickFiles(event: Event) {
  sheet.value = null
  const input = event.target as HTMLInputElement
  const files = [...input.files ?? []].map(file => ({ file, relative: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name }))
  input.value = ''
  enqueue(files)
}
// 拖入文件夹时递归读取其中的文件，保留目录结构。
async function readEntry(entry: FileSystemEntry, prefix: string, out: { file: File; relative: string }[]) {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))
    out.push({ file, relative: prefix + entry.name })
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    let batch: FileSystemEntry[]
    do {
      batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
      for (const child of batch) await readEntry(child, `${prefix}${entry.name}/`, out)
    } while (batch.length)
  }
}
async function onDrop(event: DragEvent) {
  dragDepth = 0; dragging.value = false
  const items = [...event.dataTransfer?.items ?? []]
  const entries = items.map(item => item.webkitGetAsEntry?.()).filter((entry): entry is FileSystemEntry => !!entry)
  const files: { file: File; relative: string }[] = []
  if (entries.length) for (const entry of entries) await readEntry(entry, '', files).catch(() => {})
  else for (const file of event.dataTransfer?.files ?? []) files.push({ file, relative: file.name })
  enqueue(files)
}
function onDragEnter(event: DragEvent) {
  if (!event.dataTransfer?.types.includes('Files')) return
  dragDepth++; dragging.value = true
}
function onDragLeave() { if (--dragDepth <= 0) { dragDepth = 0; dragging.value = false } }
function beforeUnload(event: BeforeUnloadEvent) { if (activeTasks.value) { event.preventDefault(); event.returnValue = '' } }

watch(path, () => { searchOpen.value = false; void nextTick(() => { if (crumbsEl.value) crumbsEl.value.scrollLeft = crumbsEl.value.scrollWidth }) })
watch(view, value => { try { localStorage.setItem('copylee-drive-view', value) } catch { /* 不支持存储时只在本次生效 */ } })
onMounted(() => {
  void load(initial)
  addEventListener('popstate', onPop)
  addEventListener('beforeunload', beforeUnload)
})
onBeforeUnmount(() => {
  removeEventListener('popstate', onPop)
  removeEventListener('beforeunload', beforeUnload)
  clearTimeout(noticeTimer)
  clearTimeout(pressTimer)
})
defineExpose({ reload: () => load() })
</script>

<template>
  <section class="files" :class="{ dragging, mobile: isMobile }" @dragenter.prevent="onDragEnter" @dragover.prevent @dragleave="onDragLeave" @drop.prevent="onDrop">
    <header v-if="isMobile" class="m-head">
      <template v-if="!selecting">
        <nav v-show="path !== '/'" ref="crumbsEl" class="m-crumbs" aria-label="当前位置">
          <template v-for="(crumb, i) in crumbs" :key="crumb.path"><span v-if="i" class="sep" aria-hidden="true">›</span><button type="button" :aria-current="i === crumbs.length - 1 ? 'page' : undefined" @click="load(crumb.path, true)">{{ crumb.name }}</button></template>
        </nav>
        <div class="m-title" :class="{ below: path !== '/' }">
          <button v-if="path !== '/'" class="m-icon" type="button" aria-label="返回上一级" @click="load(parentPath(path), true)"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg></button>
          <h1>{{ title }}</h1><span v-if="readOnly" class="badge">只读</span>
          <button class="m-icon" type="button" aria-label="搜索" :aria-pressed="searchOpen" @click="searchOpen = !searchOpen"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14Zm9 2-4.2-4.2" /></svg></button>
          <button class="m-icon" type="button" aria-label="排序与视图" @click="sheet = 'more'"><svg class="dots" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h.01M12 12h.01M19 12h.01" /></svg></button>
        </div>
        <input v-if="searchOpen || filter" v-model="filter" class="d-input m-search" type="search" placeholder="筛选当前目录" aria-label="筛选当前目录" autofocus>
        <p class="m-sub">{{ items.length }} 项 · 按{{ sortLabels[sortKey] }}{{ sortDesc ? '降序' : '升序' }}</p>
      </template>
      <div v-else class="m-select-head">
        <button type="button" @click="selected = new Set()">取消</button>
        <strong>已选 {{ chosen.length }} 项</strong>
        <button type="button" @click="toggleAll">{{ allChosen ? '全不选' : '全选' }}</button>
      </div>
    </header>
    <div v-else class="toolbar">
      <nav class="crumbs" aria-label="当前位置">
        <template v-for="(crumb, i) in crumbs" :key="crumb.path"><span v-if="i" class="sep" aria-hidden="true">/</span><button type="button" :aria-current="i === crumbs.length - 1 ? 'page' : undefined" @click="load(crumb.path, true)">{{ crumb.name }}</button></template>
        <span v-if="readOnly" class="badge">只读</span>
      </nav>
      <div class="tools">
        <input v-model="filter" class="d-input search" type="search" placeholder="筛选当前目录…" aria-label="筛选当前目录">
        <button class="d-btn quiet" type="button" :aria-label="view === 'list' ? '网格视图' : '列表视图'" :title="view === 'list' ? '网格视图' : '列表视图'" @click="view = view === 'list' ? 'grid' : 'list'"><svg viewBox="0 0 24 24" aria-hidden="true"><path :d="view === 'list' ? 'M4 4h7v7H4Zm9 0h7v7h-7ZM4 13h7v7H4Zm9 0h7v7h-7Z' : 'M4 6h16M4 12h16M4 18h16'" /></svg></button>
        <button class="d-btn quiet" type="button" aria-label="刷新" title="刷新" @click="load()"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" /></svg></button>
        <button class="d-btn" type="button" :disabled="readOnly" @click="openDialog({ kind: 'mkdir', value: '' })"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5a1 1 0 0 1 1-1h4.6l2 2h8.4a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1ZM12 10v6m-3-3h6" /></svg>新建文件夹</button>
        <label class="d-btn primary upload" :class="{ disabled: readOnly }"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m-5 5 5-5 5 5M4 16v4h16v-4" /></svg>上传<input type="file" multiple :disabled="readOnly" @change="pickFiles"></label>
        <label class="d-btn" :class="{ disabled: readOnly }" title="上传整个文件夹">文件夹<input type="file" webkitdirectory :disabled="readOnly" @change="pickFiles"></label>
      </div>
    </div>

    <Transition name="bar">
      <div v-if="chosen.length && !isMobile" class="selection" role="toolbar" aria-label="已选项目操作">
        <span>已选 {{ chosen.length }} 项</span>
        <button class="d-btn" type="button" @click="download">{{ chosen.length === 1 && !chosen[0]!.dir ? '下载' : '打包下载' }}</button>
        <button class="d-btn" type="button" @click="openDialog({ kind: 'share', paths: chosen.map(item => item.path), folder: chosen.length === 1 && chosen[0]!.dir })">分享</button>
        <button v-if="chosen.length === 1" class="d-btn" type="button" :disabled="readOnly" @click="openDialog({ kind: 'rename', value: chosen[0]!.name, entry: chosen[0] })">重命名</button>
        <button class="d-btn" type="button" :disabled="readOnly" @click="openDialog({ kind: 'transfer', mode: 'move', paths: chosen.map(item => item.path) })">移动</button>
        <button class="d-btn" type="button" @click="openDialog({ kind: 'transfer', mode: 'copy', paths: chosen.map(item => item.path) })">复制</button>
        <button v-if="chosen.length === 1" class="d-btn" type="button" @click="openDialog({ kind: 'info', path: chosen[0]!.path })">属性</button>
        <button class="d-btn danger" type="button" :disabled="readOnly" @click="remove">删除</button>
        <button class="d-btn quiet" type="button" @click="selected = new Set()">取消选择</button>
      </div>
    </Transition>

    <p v-if="error" class="d-note error" role="alert">{{ error }}<button class="dismiss" type="button" aria-label="关闭" @click="error = ''">×</button></p>
    <p v-if="notice" class="d-note ok" role="status">{{ notice }}</p>

    <div v-if="view === 'list' && !isMobile" class="table" role="grid" :aria-busy="loading">
      <div class="row head" role="row">
        <span role="columnheader"><input type="checkbox" :checked="allChosen" :indeterminate="chosen.length > 0 && !allChosen" aria-label="全选" @change="toggleAll"></span>
        <button role="columnheader" type="button" @click="sortBy('name')">名称<i v-if="sortKey === 'name'">{{ sortDesc ? '↓' : '↑' }}</i></button>
        <button role="columnheader" type="button" class="num" @click="sortBy('size')">大小<i v-if="sortKey === 'size'">{{ sortDesc ? '↓' : '↑' }}</i></button>
        <button role="columnheader" type="button" class="time" @click="sortBy('mtime')">修改时间<i v-if="sortKey === 'mtime'">{{ sortDesc ? '↓' : '↑' }}</i></button>
      </div>
      <div v-if="path !== '/'" class="row" role="row" @dblclick="load(parentPath(path), true)">
        <span />
        <button class="name" type="button" @click="load(parentPath(path), true)"><svg class="icon folder" viewBox="0 0 24 24" aria-hidden="true"><path :d="kindIcons.folder" /></svg>..</button>
        <span /><span />
      </div>
      <div v-for="item in items" :key="item.path" class="row" :class="{ chosen: selected.has(item.path) }" role="row" @dblclick="activate(item)">
        <span><input type="checkbox" :checked="selected.has(item.path)" :aria-label="`选择 ${item.name}`" @click.stop="toggle(item, $event)"></span>
        <button class="name" type="button" :title="item.name" @click="activate(item)"><svg class="icon" :class="kindOf(item.name, item.dir)" viewBox="0 0 24 24" aria-hidden="true"><path :d="kindIcons[kindOf(item.name, item.dir)]" /></svg><span class="fname"><span class="stem">{{ item.dir ? item.name : splitName(item.name)[0] }}</span><span v-if="!item.dir" class="ext">{{ splitName(item.name)[1] }}</span></span></button>
        <span class="num">{{ item.dir ? '—' : formatSize(item.size) }}</span>
        <span class="time">{{ date(item.mtime) }}</span>
      </div>
    </div>
    <ul v-else-if="view === 'list'" class="m-list" :aria-busy="loading">
      <li v-for="item in items" :key="item.path" :class="{ chosen: selected.has(item.path) }">
        <button class="m-row" type="button" @click="tap(item)" @pointerdown="pressStart(item)" @pointerup="pressEnd" @pointerleave="pressEnd" @pointercancel="pressEnd" @contextmenu.prevent>
          <span class="m-thumb"><img v-if="kindOf(item.name, item.dir) === 'image' && item.size < 3 * 1024 * 1024" :src="downloadUrl(item.path, true)" alt="" loading="lazy"><svg v-else class="icon" :class="kindOf(item.name, item.dir)" viewBox="0 0 24 24" aria-hidden="true"><path :d="kindIcons[kindOf(item.name, item.dir)]" /></svg></span>
          <span class="m-info"><span class="m-name" :title="item.name">{{ middleTrim(item.name, nameBudget) }}</span><span class="m-meta">{{ item.mtime ? date(item.mtime) : item.dir ? '文件夹' : '' }}<template v-if="!item.dir"> · {{ formatSize(item.size) }}</template></span></span>
        </button>
        <button class="m-pick" type="button" role="checkbox" :aria-checked="selected.has(item.path)" :aria-label="`选择 ${item.name}`" @click="toggle(item)"><span /></button>
      </li>
    </ul>
    <ul v-else class="grid" :aria-busy="loading">
      <li v-for="item in items" :key="item.path" :class="{ chosen: selected.has(item.path) }" @dblclick="activate(item)">
        <input type="checkbox" :checked="selected.has(item.path)" :aria-label="`选择 ${item.name}`" @click.stop="toggle(item, $event)">
        <button type="button" :title="item.name" @click="isMobile ? tap(item) : activate(item)" @pointerdown="isMobile && pressStart(item)" @pointerup="pressEnd" @pointerleave="pressEnd" @pointercancel="pressEnd" @contextmenu="event => isMobile && event.preventDefault()">
          <img v-if="kindOf(item.name, item.dir) === 'image' && item.size < 8 * 1024 * 1024" :src="downloadUrl(item.path, true)" alt="" loading="lazy">
          <svg v-else class="icon" :class="kindOf(item.name, item.dir)" viewBox="0 0 24 24" aria-hidden="true"><path :d="kindIcons[kindOf(item.name, item.dir)]" /></svg>
          <span class="fname"><span class="stem">{{ item.dir ? item.name : splitName(item.name)[0] }}</span><span v-if="!item.dir" class="ext">{{ splitName(item.name)[1] }}</span></span><small>{{ item.dir ? '文件夹' : formatSize(item.size) }}</small>
        </button>
      </li>
    </ul>
    <div v-if="listing && !items.length && !loading" class="empty">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="kindIcons.folder" /></svg>
      <p>{{ filter ? '没有匹配的文件' : readOnly ? '这个目录是空的' : isMobile ? '这个目录是空的，点右下角 ＋ 上传文件' : '这个目录是空的，把文件拖到这里即可上传' }}</p>
    </div>
    <div v-if="dragging" class="drop-hint" aria-hidden="true"><p>松开即可上传到「{{ baseName(path) || '全部文件' }}」</p></div>

    <aside v-if="tasks.length" class="queue" :class="{ collapsed: !queueOpen }" aria-label="上传队列">
      <header><button type="button" class="queue-title" @click="queueOpen = !queueOpen">{{ activeTasks ? `正在上传 ${activeTasks} 个 · ${totalProgress}%` : '上传完成' }}<span aria-hidden="true">{{ queueOpen ? '▾' : '▴' }}</span></button><button v-if="!activeTasks" class="d-btn quiet" type="button" @click="clearFinished">清除</button></header>
      <ul v-if="queueOpen">
        <li v-for="task in tasks" :key="task.id" :class="task.state">
          <div class="task-name"><span :title="task.target">{{ task.name }}</span><small>{{ task.state === 'error' ? task.error : task.state === 'done' ? formatSize(task.size) : task.state === 'cancelled' ? '已取消' : `${formatSize(task.sent)} / ${formatSize(task.size)}` }}</small></div>
          <div class="progress"><span :style="{ width: `${task.size ? Math.min(100, task.sent / task.size * 100) : 100}%` }" /></div>
          <button v-if="task.state === 'uploading' || task.state === 'waiting'" class="mini" type="button" aria-label="取消上传" @click="cancel(task)">×</button>
          <button v-else-if="task.state === 'error'" class="mini" type="button" aria-label="重试" @click="retry(task)">↻</button>
        </li>
      </ul>
    </aside>


    <Transition name="dock">
      <nav v-if="isMobile && selecting" class="m-actions" aria-label="已选项目操作">
        <button type="button" @click="download"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m-5-5 5 5 5-5M4 20h16" /></svg>{{ chosen.length === 1 && !chosen[0]!.dir ? '下载' : '打包' }}</button>
        <button type="button" @click="openDialog(shareTarget())"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 13.5 15.5 17.5M15.5 6.5l-7 4M18 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM6 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Zm12 6.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" /></svg>分享</button>
        <button type="button" :disabled="readOnly" @click="openDialog({ kind: 'transfer', mode: 'move', paths: chosen.map(item => item.path) })"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5a1 1 0 0 1 1-1h4.6l2 2h8.4a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1ZM10 13h6m-2-2 2 2-2 2" /></svg>移动</button>
        <button type="button" @click="openDialog({ kind: 'transfer', mode: 'copy', paths: chosen.map(item => item.path) })"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 9h10v10H9ZM5 15V5h10" /></svg>复制</button>
        <button type="button" :disabled="readOnly || chosen.length !== 1" @click="openDialog({ kind: 'rename', value: chosen[0]!.name, entry: chosen[0] })"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16Zm9-13 4 4" /></svg>重命名</button>
        <button type="button" :disabled="chosen.length !== 1" @click="openDialog({ kind: 'info', path: chosen[0]!.path })"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Zm0-10v5m0-8h.01" /></svg>属性</button>
        <button type="button" class="danger" :disabled="readOnly" @click="remove"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>删除</button>
      </nav>
    </Transition>
    <button v-if="isMobile && !selecting && !readOnly" class="m-fab" type="button" aria-label="上传或新建" @click="sheet = 'add'"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg></button>
    <DriveDialog v-if="sheet === 'add'" :title="`上传到「${title}」`" @close="sheet = null">
      <div class="m-tiles">
        <label class="m-tile"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h9l4 4v14H6Zm9 0v4h4M12 17v-6m-3 3 3-3 3 3" /></svg>选择文件<input type="file" multiple @change="pickFiles"></label>
        <label class="m-tile"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4Zm0 11 4.5-4.5 4 4 2.5-2.5L20 18M15 9.5h.01" /></svg>图片和视频<input type="file" multiple accept="image/*,video/*" @change="pickFiles"></label>
        <button class="m-tile" type="button" @click="sheet = null; openDialog({ kind: 'mkdir', value: '' })"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5a1 1 0 0 1 1-1h4.6l2 2h8.4a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1ZM12 10v6m-3-3h6" /></svg>新建文件夹</button>
      </div>
    </DriveDialog>
    <DriveDialog v-if="sheet === 'more'" title="排序与视图" @close="sheet = null">
      <p class="m-group">排序方式</p>
      <div class="m-options">
        <button v-for="key in (['name', 'mtime', 'size'] as const)" :key="key" type="button" :class="{ active: sortKey === key }" @click="sortBy(key)">{{ sortLabels[key] }}<span v-if="sortKey === key">{{ sortDesc ? '↓ 降序' : '↑ 升序' }}</span></button>
      </div>
      <p class="m-group">显示方式</p>
      <div class="m-options two">
        <button type="button" :class="{ active: view === 'list' }" @click="view = 'list'">列表</button>
        <button type="button" :class="{ active: view === 'grid' }" @click="view = 'grid'">网格</button>
      </div>
      <p class="m-tip">长按文件或点右侧圆圈即可多选。</p>
      <div class="d-actions"><button class="d-btn" type="button" @click="sheet = null; openDialog({ kind: 'info', path })">当前文件夹属性</button><button class="d-btn" type="button" @click="sheet = null; load()">刷新</button><button class="d-btn primary" type="button" @click="sheet = null">完成</button></div>
    </DriveDialog>
    <DriveDialog v-if="dialog && (dialog.kind === 'mkdir' || dialog.kind === 'rename')" :title="dialog.kind === 'mkdir' ? '新建文件夹' : '重命名'" @close="dialog = null">
      <form @submit.prevent="submitDialog">
        <label class="d-field">名称<input v-model="dialog.value" class="d-input" maxlength="255" required></label>
        <p v-if="dialogError" class="d-note error" role="alert">{{ dialogError }}</p>
        <div class="d-actions"><button class="d-btn" type="button" @click="dialog = null">取消</button><button class="d-btn primary" type="submit" :disabled="dialogBusy">{{ dialogBusy ? '处理中…' : '确定' }}</button></div>
      </form>
    </DriveDialog>
    <InfoDialog v-else-if="dialog?.kind === 'info'" :path="dialog.path" @close="dialog = null" @notify="flash" />
    <TransferDialog v-else-if="dialog?.kind === 'transfer'" :mode="dialog.mode" :paths="dialog.paths" :start="path" @close="dialog = null" @done="transferred" />
    <ShareDialog v-else-if="dialog?.kind === 'share'" :paths="dialog.paths" :folder="dialog.folder" @close="dialog = null" />
    <PreviewDialog v-else-if="dialog?.kind === 'preview'" :entry="dialog.entry" :siblings="items" :url="inline => downloadUrl((dialog as { entry: DriveEntry }).entry.path, inline)" @close="dialog = null" @open="entry => dialog = { kind: 'preview', entry }" />
  </section>
</template>

<style scoped>
.files { position:relative; min-width:0; }
.toolbar { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px 16px; }
.crumbs { display:flex; flex-wrap:wrap; align-items:center; gap:2px; min-width:0; font-size:15px; }
.crumbs button { padding:4px 6px; border:0; border-radius:8px; background:none; color:var(--muted); font:inherit; cursor:pointer; max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.crumbs button:hover { background:var(--bg-tint); color:var(--text); }
.crumbs button[aria-current] { color:var(--text); font-weight:600; }
.sep { color:var(--faint); }
.badge { margin-left:8px; padding:2px 8px; border:1px solid var(--line); border-radius:999px; color:var(--muted); font-size:12px; }
.tools { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.search { width:200px; min-height:36px; padding:7px 12px; }
.upload { position:relative; overflow:hidden; }
label.d-btn { position:relative; overflow:hidden; }
label.d-btn input { position:absolute; inset:0; opacity:0; cursor:pointer; }
label.d-btn.disabled { opacity:.45; pointer-events:none; }
.selection { position:sticky; top:calc(var(--header-h) + 8px); z-index:5; display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-top:16px; padding:10px 12px; border:1px solid color-mix(in srgb,var(--accent) 35%,transparent); border-radius:12px; background:color-mix(in srgb,var(--surface) 92%,var(--accent)); box-shadow:0 12px 30px -20px rgba(17,24,39,.35); }
.selection > span { margin-right:6px; color:var(--accent); font-size:13px; font-weight:600; }
.bar-enter-active,.bar-leave-active { transition:opacity .2s,transform .25s var(--ease); }
.bar-enter-from,.bar-leave-to { opacity:0; transform:translateY(-6px); }
.d-note { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.dismiss { border:0; background:none; color:inherit; font-size:18px; cursor:pointer; opacity:.6; }
.table { margin-top:16px; border-top:1px solid var(--line); }
.row { display:grid; grid-template-columns:40px minmax(0,1fr) 110px 170px; align-items:center; min-height:50px; padding:0 8px; border-bottom:1px solid var(--line); transition:background .15s; }
.row:not(.head):hover { background:color-mix(in srgb,var(--text) 3%,transparent); }
.row.chosen { background:var(--accent-soft); }
.row.head { min-height:40px; color:var(--muted); font-size:12px; }
.row.head button { justify-self:start; padding:0; border:0; background:none; color:inherit; font:inherit; cursor:pointer; }
.row.head button.num { justify-self:end; }
.row.head i { margin-left:4px; font-style:normal; color:var(--accent); }
.row input[type=checkbox],.grid input[type=checkbox] { width:16px; height:16px; accent-color:var(--accent); cursor:pointer; }
.name { display:flex; align-items:center; gap:12px; min-width:0; padding:8px 0; border:0; background:none; color:var(--text); font:14px var(--font); text-align:left; cursor:pointer; }
.name span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
/* 单行显示时文件名主体省略，扩展名始终可见 */
.fname { display:flex; min-width:0; max-width:100%; }
.fname .ext { flex:none; overflow:visible; }
.name:hover span { color:var(--accent); }
.num { text-align:right; color:var(--muted); font:12px var(--font-mono); }
.time { padding-left:24px; color:var(--faint); font:12px var(--font-mono); }
.icon { flex:none; width:22px; height:22px; fill:none; stroke:var(--muted); stroke-width:1.5; stroke-linejoin:round; stroke-linecap:round; }
.icon.folder { fill:var(--accent-soft); stroke:var(--accent); }
.icon.image { stroke:#3aa17e; } .icon.video { stroke:#c0792f; } .icon.audio { stroke:#8b6fd6; } .icon.pdf { stroke:#d15c5c; } .icon.archive { stroke:#b38a2e; } .icon.doc { stroke:#3b6ef5; }
.grid { list-style:none; display:grid; grid-template-columns:repeat(auto-fill,minmax(140px,1fr)); gap:12px; margin:16px 0 0; padding:0; }
.grid li { position:relative; border:1px solid var(--line); border-radius:14px; background:var(--surface); transition:border-color .2s,box-shadow .2s; }
.grid li:hover { border-color:var(--line-strong); box-shadow:0 10px 24px -18px rgba(17,24,39,.35); }
.grid li.chosen { border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); }
.grid input { position:absolute; top:10px; left:10px; z-index:1; }
.grid button { display:flex; flex-direction:column; align-items:center; gap:6px; width:100%; padding:18px 12px 14px; border:0; background:none; color:var(--text); font:13px var(--font); cursor:pointer; }
.grid img { width:100%; aspect-ratio:4/3; object-fit:cover; border-radius:8px; background:var(--bg-tint); }
.grid .icon { width:48px; height:48px; margin:12px 0 6px; stroke-width:1.2; }
.grid span { max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.grid small { color:var(--faint); font:11px var(--font-mono); }
.empty { display:grid; place-items:center; gap:10px; padding:64px 20px; color:var(--muted); font-size:14px; text-align:center; }
.empty svg { width:56px; height:56px; fill:var(--accent-soft); stroke:var(--accent); stroke-width:1.2; opacity:.7; }
.drop-hint { position:absolute; inset:-8px; z-index:8; display:grid; place-items:center; border:2px dashed var(--accent); border-radius:16px; background:color-mix(in srgb,var(--bg) 82%,var(--accent)); pointer-events:none; }
.drop-hint p { padding:12px 20px; border-radius:12px; background:var(--surface); color:var(--accent); font-weight:600; box-shadow:0 12px 30px -16px rgba(17,24,39,.35); }
.queue { position:fixed; right:20px; bottom:20px; z-index:30; width:min(380px,calc(100vw - 32px)); border:1px solid var(--line); border-radius:14px; background:var(--surface); box-shadow:0 24px 50px -24px rgba(17,24,39,.45); overflow:hidden; }
.queue header { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 8px 8px 14px; border-bottom:1px solid var(--line); }
.queue.collapsed header { border-bottom:0; }
.queue-title { display:flex; align-items:center; gap:8px; border:0; background:none; color:var(--text); font:600 13px var(--font); cursor:pointer; }
.queue ul { list-style:none; margin:0; padding:6px 0; max-height:280px; overflow:auto; }
.queue li { display:grid; grid-template-columns:1fr 24px; grid-template-rows:auto 4px; gap:4px 8px; align-items:center; padding:8px 14px; }
.task-name { display:flex; justify-content:space-between; gap:8px; min-width:0; font-size:13px; }
.task-name span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.task-name small { flex:none; color:var(--faint); font:11px var(--font-mono); }
.queue li.error small { color:#d15c5c; font-family:var(--font); white-space:normal; text-align:right; }
.progress { grid-column:1; height:4px; border-radius:999px; background:var(--bg-tint); overflow:hidden; }
.progress span { display:block; height:100%; background:var(--accent); transition:width .3s; }
.queue li.done .progress span { background:#2fa36b; }
.queue li.error .progress span { background:#d15c5c; }
.mini { grid-row:1 / 3; grid-column:2; width:24px; height:24px; border:0; border-radius:6px; background:none; color:var(--muted); cursor:pointer; }
.mini:hover { background:var(--bg-tint); color:var(--text); }
/* —— 移动端：两行列表、右侧选择圈、底部操作栏与悬浮上传按钮 —— */
.m-head { margin:-8px 0 0; }
.m-crumbs { display:flex; align-items:center; gap:2px; padding:6px 8px; border:1px solid var(--line); border-radius:14px; background:var(--surface); box-shadow:0 8px 24px -20px rgba(17,24,39,.4); overflow-x:auto; scrollbar-width:none; white-space:nowrap; }
.m-crumbs::-webkit-scrollbar { display:none; }
.m-crumbs button { flex:none; max-width:44vw; padding:6px 6px; border:0; background:none; color:var(--muted); font:14px var(--font); overflow:hidden; text-overflow:ellipsis; }
.m-crumbs button[aria-current] { color:var(--text); font-weight:600; }
.m-title { display:flex; align-items:center; gap:4px; }
.m-title h1 { flex:1; min-width:0; margin:0; font-size:26px; letter-spacing:-.02em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.m-title .badge { flex:none; margin:0 4px 0 0; }
.m-icon { flex:none; display:grid; place-items:center; width:40px; height:40px; border:0; border-radius:50%; background:none; color:var(--text); cursor:pointer; }
.m-icon:active,.m-icon[aria-pressed=true] { background:var(--bg-tint); }
.m-icon svg { width:22px; height:22px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
.m-title .m-icon:first-child { margin-left:-10px; }
.m-icon svg.dots { stroke-width:3.2; }
.m-title.below { margin-top:16px; }
.m-search { margin-top:12px; }
.m-sub { margin:6px 0 0; color:var(--faint); font-size:12px; }
.m-select-head { display:flex; align-items:center; justify-content:space-between; min-height:56px; }
.m-select-head strong { font-size:17px; }
.m-select-head button { min-width:64px; padding:10px 4px; border:0; background:none; color:var(--accent); font:500 15px var(--font); cursor:pointer; }
.m-select-head button:last-child { text-align:right; }
.m-list { list-style:none; margin:8px -16px 0; padding:0; }
.m-list li { display:flex; align-items:center; transition:background .15s; }
.m-list li.chosen { background:var(--accent-soft); }
.m-row { flex:1; display:flex; align-items:center; gap:14px; min-width:0; padding:11px 0 11px 16px; border:0; background:none; color:var(--text); text-align:left; cursor:pointer; -webkit-tap-highlight-color:transparent; -webkit-touch-callout:none; user-select:none; }
.m-row:active { background:color-mix(in srgb,var(--text) 4%,transparent); }
.m-thumb { flex:none; display:grid; place-items:center; width:44px; height:44px; border-radius:10px; overflow:hidden; }
.m-thumb img { width:100%; height:100%; object-fit:cover; background:var(--bg-tint); }
.m-thumb .icon { width:36px; height:36px; stroke-width:1.3; }
.m-thumb .icon.folder { width:40px; height:40px; fill:color-mix(in srgb,var(--accent) 22%,transparent); }
.m-info { display:flex; flex-direction:column; gap:3px; min-width:0; }
.m-name { font-size:15px; line-height:1.35; overflow:hidden; text-overflow:ellipsis; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow-wrap:anywhere; }
.m-meta { color:var(--faint); font-size:12.5px; font-variant-numeric:tabular-nums; }
.m-pick { flex:none; display:grid; place-items:center; width:56px; height:56px; border:0; background:none; cursor:pointer; -webkit-tap-highlight-color:transparent; }
.m-pick span { width:20px; height:20px; border:1.5px solid var(--line-strong); border-radius:50%; transition:background .15s,border-color .15s; }
.m-pick[aria-checked=true] span { border-color:var(--accent); background:var(--accent) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 12 4 4 8-8'/%3E%3C/svg%3E") center/14px no-repeat; }
.m-fab { position:fixed; right:20px; bottom:calc(76px + env(safe-area-inset-bottom)); z-index:25; display:grid; place-items:center; width:56px; height:56px; border:0; border-radius:50%; background:var(--accent); color:#fff; box-shadow:0 14px 30px -10px color-mix(in srgb,var(--accent) 70%,transparent); cursor:pointer; transition:transform .2s var(--ease); }
.m-fab:active { transform:scale(.94); }
.m-fab svg { width:26px; height:26px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; }
.m-actions { position:fixed; left:0; right:0; bottom:0; z-index:45; display:grid; grid-template-columns:repeat(7,1fr); padding:6px 4px calc(6px + env(safe-area-inset-bottom)); border-top:1px solid var(--line); background:color-mix(in srgb,var(--bg) 94%,transparent); -webkit-backdrop-filter:blur(14px); backdrop-filter:blur(14px); }
.m-actions button { display:flex; flex-direction:column; align-items:center; gap:4px; padding:6px 0; border:0; background:none; color:var(--text); font:12px var(--font); cursor:pointer; }
.m-actions button:disabled { opacity:.35; }
.m-actions button.danger { color:#d15c5c; }
.m-actions svg { width:22px; height:22px; fill:none; stroke:currentColor; stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round; }
.dock-enter-active,.dock-leave-active { transition:transform .25s var(--ease),opacity .2s; }
.dock-enter-from,.dock-leave-to { transform:translateY(100%); opacity:0; }
.m-tiles { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-top:16px; }
.m-tile { position:relative; display:flex; flex-direction:column; align-items:center; gap:10px; padding:18px 6px 16px; border:0; border-radius:14px; background:var(--bg-tint); color:var(--text); font:14px var(--font); cursor:pointer; overflow:hidden; }
.m-tile svg { width:30px; height:30px; fill:none; stroke:currentColor; stroke-width:1.5; stroke-linecap:round; stroke-linejoin:round; }
.m-tile input { position:absolute; inset:0; opacity:0; }
.m-group { margin:18px 0 8px; color:var(--muted); font-size:13px; }
.m-options { display:grid; gap:8px; }
.m-options.two { grid-template-columns:1fr 1fr; }
.m-options button { display:flex; align-items:center; justify-content:space-between; padding:13px 16px; border:1px solid transparent; border-radius:12px; background:var(--bg-tint); color:var(--text); font:15px var(--font); cursor:pointer; }
.m-options.two button { justify-content:center; }
.m-options button.active { border-color:var(--accent); background:var(--accent-soft); color:var(--accent); font-weight:500; }
.m-options span { font-size:13px; }
.m-tip { margin:16px 0 0; color:var(--faint); font-size:12px; }
.mobile .grid { grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; }
.mobile .grid button { padding:12px 6px 10px; -webkit-touch-callout:none; user-select:none; }
.mobile .grid .icon { width:40px; height:40px; margin:8px 0 4px; }
.mobile .grid input { top:6px; left:6px; }
.mobile .empty { padding:56px 20px 120px; }
.mobile .queue { left:12px; right:12px; bottom:calc(76px + env(safe-area-inset-bottom)); width:auto; }
.mobile > .d-note { margin-top:12px; }
</style>

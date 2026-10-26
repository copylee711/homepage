<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { TreeItem } from '../../teams'
import { kindIcons, kindOf } from '../drive/fileKinds'

/**
 * 团队文件树：文件夹、文件与文档混排（文件夹在前），展开状态记在本页。
 * 选中文件夹时右侧文件管理跳到该目录；文档与文件交给页面打开。
 */
const props = defineProps<{ items: TreeItem[]; name: string; current?: string; activeDoc?: string }>()
const emit = defineEmits<{ select: [item: TreeItem | null] }>()

const DOC_ICON = 'M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20V3.5ZM14 3.5V8h4M10 12h5M10 15.5h5'
const open = ref(new Set<string>())

const children = computed(() => {
  const map = new Map<string, TreeItem[]>()
  for (const item of props.items) {
    const parent = item.path.slice(0, item.path.lastIndexOf('/')) || '/'
    if (!map.has(parent)) map.set(parent, [])
    map.get(parent)!.push(item)
  }
  for (const list of map.values()) list.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
  return map
})

interface Row { item: TreeItem; depth: number }
const rows = computed(() => {
  const result: Row[] = []
  const walk = (folder: string, depth: number) => {
    for (const item of children.value.get(folder) ?? []) {
      result.push({ item, depth })
      if (item.dir && open.value.has(item.path)) walk(item.path, depth + 1)
    }
  }
  walk('/', 0)
  return result
})

// 当前目录或当前文档所在的各级文件夹自动展开。
function reveal(path?: string) {
  if (!path || path === '/') return
  const parts = path.split('/').filter(Boolean)
  const next = new Set(open.value)
  for (let i = 1; i <= parts.length; i++) next.add('/' + parts.slice(0, i).join('/'))
  open.value = next
}
watch(() => props.current, value => reveal(value), { immediate: true })
watch(() => [props.activeDoc, props.items] as const, () => {
  const doc = props.items.find(item => item.doc && item.doc === props.activeDoc)
  if (doc) reveal(doc.path.slice(0, doc.path.lastIndexOf('/')))
}, { immediate: true })

function toggle(item: TreeItem) {
  const next = new Set(open.value)
  if (next.has(item.path)) next.delete(item.path)
  else next.add(item.path)
  open.value = next
}
function choose(item: TreeItem) {
  if (item.dir && !open.value.has(item.path)) toggle(item)
  emit('select', item)
}
const icon = (item: TreeItem) => item.doc ? DOC_ICON : kindIcons[kindOf(item.name, item.dir)]
const label = (item: TreeItem) => item.doc ? item.name.replace(/\.md$/i, '') : item.name
</script>

<template>
  <nav class="tree" aria-label="团队文件">
    <button type="button" class="tree-row root" :class="{ on: current === '/' && !activeDoc }" @click="emit('select', null)">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="kindIcons.folder" /></svg><span>{{ name }}</span>
    </button>
    <div v-for="{ item, depth } in rows" :key="item.path" class="tree-row" :class="{ on: item.doc ? item.doc === activeDoc : item.dir && item.path === current, doc: !!item.doc }" :style="{ paddingLeft: `${8 + depth * 14}px` }">
      <button v-if="item.dir" type="button" class="twisty" :aria-label="open.has(item.path) ? '收起' : '展开'" :aria-expanded="open.has(item.path)" @click="toggle(item)"><svg viewBox="0 0 24 24" aria-hidden="true" :class="{ open: open.has(item.path) }"><path d="m9 6 6 6-6 6" /></svg></button>
      <span v-else class="twisty" />
      <button type="button" class="node" :title="item.path" @click="choose(item)">
        <svg viewBox="0 0 24 24" aria-hidden="true" :class="kindOf(item.name, item.dir)"><path :d="icon(item)" /></svg><span>{{ label(item) }}</span>
      </button>
    </div>
    <p v-if="!items.length" class="empty">还没有文件</p>
  </nav>
</template>

<style scoped>
.tree { display:grid; gap:1px; font-size:13.5px; }
.tree-row { display:flex; align-items:center; min-width:0; border-radius:8px; color:var(--text-2); transition:background .15s,color .15s; }
.tree-row:hover { background:color-mix(in srgb,var(--text) 4%,transparent); color:var(--text); }
.tree-row.on { background:var(--accent-soft); color:var(--accent); }
.tree-row.root { gap:8px; padding:7px 8px; border:0; background:none; font:600 13.5px var(--font); text-align:left; cursor:pointer; }
.tree-row.root.on { background:var(--accent-soft); }
.twisty { flex:none; display:grid; place-items:center; width:18px; height:26px; padding:0; border:0; background:none; color:var(--faint); cursor:pointer; }
.twisty svg { width:12px; height:12px; transition:transform .15s; }
.twisty svg.open { transform:rotate(90deg); }
.node { flex:1; display:flex; align-items:center; gap:7px; min-width:0; padding:4px 6px 4px 2px; border:0; background:none; color:inherit; font:inherit; text-align:left; cursor:pointer; }
.node span, .root span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
svg { width:16px; height:16px; flex:none; fill:none; stroke:currentColor; stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round; }
.node svg.folder, .root svg { color:var(--accent); }
.tree-row.doc .node svg { color:var(--accent); }
.empty { padding:8px 10px; color:var(--faint); font-size:13px; }
</style>

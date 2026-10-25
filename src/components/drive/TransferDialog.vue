<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { confirmDialog } from '../../composables/useConfirm'
import { baseName, driveApi, joinPath, parentPath } from '../../drive'
import type { DriveListing } from '../../drive'
import DriveDialog from './DriveDialog.vue'

const props = defineProps<{ mode: 'move' | 'copy'; paths: string[]; start: string }>()
const emit = defineEmits<{ close: []; done: [] }>()
const current = ref(props.start)
const folders = ref<string[]>([])
const readOnly = ref(false)
const busy = ref(false), error = ref('')
const crumbs = computed(() => {
  const parts = current.value.split('/').filter(Boolean)
  return [{ name: '全部文件', path: '/' }, ...parts.map((name, i) => ({ name, path: '/' + parts.slice(0, i + 1).join('/') }))]
})
// 不能移动到自身或自己的子目录中。
const invalid = computed(() => props.paths.some(path => current.value === path || current.value.startsWith(path + '/'))
  || (props.mode === 'move' && props.paths.every(path => parentPath(path) === current.value)))

async function open(path: string) {
  error.value = ''
  try {
    const listing = await driveApi<DriveListing>(`/list?path=${encodeURIComponent(path)}`)
    current.value = listing.path; readOnly.value = listing.read_only
    folders.value = listing.items.filter(item => item.dir).map(item => item.name)
  } catch (err) { error.value = err instanceof Error ? err.message : '读取失败' }
}
async function submit() {
  if (busy.value) return
  busy.value = true; error.value = ''
  try {
    const targets = new Set(folders.value)
    const clash = props.paths.filter(path => targets.has(baseName(path)))
    const overwrite = clash.length > 0 && await confirmDialog({ title: '覆盖同名项目？', message: `目标目录中已有 ${clash.map(baseName).join('、')}。`, confirmText: '覆盖', danger: true })
    if (clash.length && !overwrite) return
    await driveApi(`/${props.mode}`, 'POST', { paths: props.paths, target: current.value, overwrite })
    emit('done')
  } catch (err) { error.value = err instanceof Error ? err.message : '操作失败' }
  finally { busy.value = false }
}
onMounted(() => open(props.start))
</script>

<template>
  <DriveDialog :title="mode === 'move' ? `移动 ${paths.length} 项到…` : `复制 ${paths.length} 项到…`" eyebrow="Choose a folder" @close="emit('close')">
    <nav class="crumbs" aria-label="目标位置"><template v-for="(crumb, i) in crumbs" :key="crumb.path"><span v-if="i" aria-hidden="true">/</span><button type="button" @click="open(crumb.path)">{{ crumb.name }}</button></template></nav>
    <ul class="folders">
      <li v-if="current !== '/'"><button type="button" @click="open(parentPath(current))">↑ 上一级</button></li>
      <li v-for="name in folders" :key="name"><button type="button" @click="open(joinPath(current, name))"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5a1 1 0 0 1 1-1h4.6l2 2h8.4a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1Z" /></svg>{{ name }}</button></li>
      <li v-if="!folders.length" class="d-muted empty">这里没有子目录</li>
    </ul>
    <p v-if="readOnly" class="d-note error">该目录只读，不能放入文件。</p>
    <p v-if="error" class="d-note error" role="alert">{{ error }}</p>
    <div class="d-actions"><button class="d-btn" type="button" @click="emit('close')">取消</button><button class="d-btn primary" type="button" :disabled="busy || invalid || readOnly" @click="submit">{{ busy ? '处理中…' : mode === 'move' ? '移动到这里' : '复制到这里' }}</button></div>
  </DriveDialog>
</template>

<style scoped>
.crumbs { display:flex; flex-wrap:wrap; align-items:center; gap:4px; margin-top:14px; color:var(--faint); font-size:13px; }
.crumbs button { border:0; background:none; color:var(--accent); font:inherit; cursor:pointer; padding:2px 4px; border-radius:6px; }
.crumbs button:hover { background:var(--accent-soft); }
.folders { list-style:none; margin:12px 0 0; padding:6px; max-height:300px; overflow:auto; border:1px solid var(--line); border-radius:12px; background:var(--surface); }
.folders button { display:flex; align-items:center; gap:10px; width:100%; padding:9px 10px; border:0; border-radius:8px; background:none; color:var(--text); font:14px var(--font); text-align:left; cursor:pointer; }
.folders button:hover { background:var(--bg-tint); }
.folders svg { width:18px; height:18px; flex:none; fill:var(--accent-soft); stroke:var(--accent); stroke-width:1.6; }
.empty { padding:16px 10px; }
</style>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { baseName, driveApi, formatSize, parentPath } from '../../drive'
import type { DriveEntry, DriveListing } from '../../drive'
import DriveDialog from '../drive/DriveDialog.vue'
import { kindIcons, kindOf } from '../drive/fileKinds'

/** 从自己的云盘里选一个文件发给好友。 */
const emit = defineEmits<{ close: []; pick: [entry: DriveEntry] }>()
const path = ref('/')
const items = ref<DriveEntry[]>([])
const loading = ref(false), error = ref('')

async function open(target: string) {
  loading.value = true; error.value = ''
  try {
    const data = await driveApi<DriveListing>(`/list?path=${encodeURIComponent(target)}`)
    path.value = data.path
    items.value = [...data.items].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, 'zh-CN'))
  } catch (err) { error.value = err instanceof Error ? err.message : '读取失败' }
  finally { loading.value = false }
}

function choose(entry: DriveEntry) {
  if (entry.dir) open(entry.path)
  else emit('pick', entry)
}

onMounted(() => open('/'))
</script>

<template>
  <DriveDialog title="发送云盘文件" eyebrow="只有对方能打开，不会生成公开链接" @close="emit('close')">
    <nav class="crumbs" aria-label="当前位置">
      <button type="button" :disabled="path === '/'" @click="open(parentPath(path))">上一级</button>
      <span>{{ path === '/' ? '全部文件' : baseName(path) }}</span>
    </nav>
    <p v-if="error" class="d-note error" role="alert">{{ error }}</p>
    <p v-else-if="loading" class="d-muted empty">正在读取…</p>
    <p v-else-if="!items.length" class="d-muted empty">这个文件夹是空的。</p>
    <ul v-else class="entries">
      <li v-for="entry in items" :key="entry.path">
        <button type="button" @click="choose(entry)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="kindIcons[kindOf(entry.name, entry.dir)]" /></svg>
          <span class="name">{{ entry.name }}</span>
          <small>{{ entry.dir ? '打开' : formatSize(entry.size) }}</small>
        </button>
      </li>
    </ul>
  </DriveDialog>
</template>

<style scoped>
.crumbs { display:flex; align-items:center; gap:10px; margin-top:12px; font-size:13px; color:var(--text-2); }
.crumbs button { padding:4px 10px; border:1px solid var(--line); border-radius:8px; background:var(--surface); color:var(--text-2); font:12.5px var(--font); cursor:pointer; }
.crumbs button:disabled { opacity:.45; cursor:default; }
.crumbs span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.empty { padding:28px 0; text-align:center; }
.entries { list-style:none; margin:12px 0 0; padding:0; max-height:50vh; overflow:auto; border-top:1px solid var(--line); }
.entries button { display:flex; align-items:center; gap:12px; width:100%; padding:10px 6px; border:0; border-bottom:1px solid var(--line); background:none; color:var(--text); font:14px var(--font); text-align:left; cursor:pointer; transition:background .15s; }
.entries button:hover { background:var(--bg-tint); }
.entries svg { flex:none; width:20px; height:20px; fill:none; stroke:var(--accent); stroke-width:1.5; stroke-linecap:round; stroke-linejoin:round; }
.name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.entries small { flex:none; color:var(--faint); font-size:12px; }
</style>

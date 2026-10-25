<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { driveApi, formatSize, formatTime } from '../../drive'
import DriveDialog from './DriveDialog.vue'
import { kindIcons, kindOf, splitName } from './fileKinds'

interface DriveInfo {
  name: string; path: string; parent: string; dir: boolean; size: number; mtime: number; shares: number
  mount: { path: string; kind: string; label: string; read_only: boolean }
  tree?: { size: number; files: number; folders: number; partial: boolean }
}

const props = defineProps<{ path: string }>()
const emit = defineEmits<{ close: []; notify: [text: string] }>()
const info = ref<DriveInfo>()
const error = ref('')
const kindNames = { folder: '文件夹', image: '图片', video: '视频', audio: '音频', pdf: 'PDF 文档', text: '文本', archive: '压缩包或安装包', doc: '办公文档', file: '文件' } as const
const kind = computed(() => info.value ? kindOf(info.value.name, info.value.dir) : 'file')
const type = computed(() => {
  if (!info.value) return ''
  const ext = splitName(info.value.name)[1].slice(1).toUpperCase()
  return info.value.dir ? '文件夹' : ext ? `${kindNames[kind.value]}（${ext}）` : kindNames[kind.value]
})
const exact = (bytes: number) => `${bytes.toLocaleString('zh-CN')} 字节`

onMounted(async () => {
  try { info.value = await driveApi<DriveInfo>(`/info?path=${encodeURIComponent(props.path)}`) }
  catch (err) { error.value = err instanceof Error ? err.message : '读取失败' }
})
async function copyPath() {
  try { await navigator.clipboard.writeText(props.path); emit('notify', '路径已复制') } catch { error.value = '复制失败，请手动复制' }
}
</script>

<template>
  <DriveDialog title="属性" @close="emit('close')">
    <p v-if="error" class="d-note error" role="alert">{{ error }}</p>
    <div v-else-if="info" class="info">
      <div class="head">
        <svg class="icon" :class="kind" viewBox="0 0 24 24" aria-hidden="true"><path :d="kindIcons[kind]" /></svg>
        <strong>{{ info.name }}</strong>
      </div>
      <dl>
        <dt>类型</dt><dd>{{ type }}</dd>
        <dt>位置</dt><dd>{{ info.parent || '—' }}</dd>
        <template v-if="info.tree">
          <dt>大小</dt><dd>{{ formatSize(info.tree.size) }}<small>{{ exact(info.tree.size) }}{{ info.tree.partial ? '，统计未完成' : '' }}</small></dd>
          <dt>包含</dt><dd>{{ info.tree.files }} 个文件，{{ info.tree.folders }} 个文件夹{{ info.tree.partial ? '（项目过多，只统计了一部分）' : '' }}</dd>
        </template>
        <template v-else><dt>大小</dt><dd>{{ formatSize(info.size) }}<small>{{ exact(info.size) }}</small></dd></template>
        <dt>修改时间</dt><dd>{{ info.mtime ? formatTime(info.mtime) : '—' }}</dd>
        <dt>存储于</dt><dd>{{ info.mount.label }}<template v-if="info.mount.path !== '/'">（挂载点 {{ info.mount.path }}）</template>{{ info.mount.read_only ? ' · 只读' : '' }}</dd>
        <dt>分享</dt><dd>{{ info.shares ? `${info.shares} 个分享链接` : '未分享' }}</dd>
      </dl>
    </div>
    <p v-else class="d-muted loading">正在统计…</p>
    <div class="d-actions"><button class="d-btn" type="button" @click="copyPath">复制路径</button><button class="d-btn primary" type="button" @click="emit('close')">完成</button></div>
  </DriveDialog>
</template>

<style scoped>
.head { display:flex; align-items:center; gap:12px; margin-top:14px; padding:14px; border-radius:12px; background:var(--bg-tint); }
.head strong { min-width:0; font-weight:500; font-size:15px; line-height:1.45; overflow-wrap:anywhere; }
.icon { flex:none; width:36px; height:36px; fill:none; stroke:var(--muted); stroke-width:1.3; stroke-linejoin:round; stroke-linecap:round; }
.icon.folder { fill:var(--accent-soft); stroke:var(--accent); }
.icon.image { stroke:#3aa17e; } .icon.video { stroke:#c0792f; } .icon.audio { stroke:#8b6fd6; } .icon.pdf { stroke:#d15c5c; } .icon.archive { stroke:#b38a2e; } .icon.doc { stroke:#3b6ef5; }
dl { display:grid; grid-template-columns:auto minmax(0,1fr); gap:12px 18px; margin:18px 0 0; font-size:14px; }
dt { color:var(--muted); }
dd { margin:0; overflow-wrap:anywhere; }
dd small { display:block; margin-top:2px; color:var(--faint); font-size:12px; font-variant-numeric:tabular-nums; }
.loading { padding:28px 0; text-align:center; }
</style>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { site } from '../content'
import { driveApi, formatSize } from '../drive'
import type { DriveOverview } from '../drive'

const overview = ref<DriveOverview>()
const error = ref('')
const storage = computed(() => overview.value?.storage)
const percent = computed(() => storage.value?.quota ? Math.min(100, storage.value.used / storage.value.quota * 100) : 0)
const separate = computed(() => (overview.value?.mounts ?? []).filter(mount => mount.quota > 0))
const driveUrl = computed(() => site.value?.cloud || '/drive')

onMounted(async () => {
  try { overview.value = await driveApi<DriveOverview>('') }
  catch (err) { error.value = err instanceof Error ? err.message : '读取失败' }
})
</script>

<template>
  <section class="summary" aria-label="云盘">
    <header>
      <div><h3>云盘</h3><p>网页、SFTP 与 WebDAV 访问同一份文件，图床图片也计入总空间。</p></div>
      <a class="open" :href="driveUrl">打开云盘 <span aria-hidden="true">↗</span></a>
    </header>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <template v-else-if="storage">
      <div class="usage-head"><strong>{{ formatSize(storage.used) }}</strong><span>/ {{ storage.quota ? formatSize(storage.quota) : '不限' }}</span></div>
      <div class="bar" role="progressbar" :aria-valuenow="Math.round(percent)" aria-valuemin="0" aria-valuemax="100"><span :style="{ width: `${percent}%` }" /></div>
      <ul class="split">
        <li><i class="dot drive" />云盘 {{ formatSize(storage.drive_used) }}</li>
        <li><i class="dot images" />图床 {{ formatSize(storage.images_used) }}</li>
        <li v-for="mount in separate" :key="mount.id"><i class="dot other" />{{ mount.path }} {{ formatSize(mount.used) }} / {{ formatSize(mount.quota) }}（单独计算）</li>
      </ul>
    </template>
    <p v-else class="muted">正在读取…</p>
  </section>
</template>

<style scoped>
.summary { margin-top:24px; padding:24px; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--surface); }
header { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
h3 { font-size:16px; }
header p { margin-top:6px; color:var(--muted); font-size:13px; }
.open { flex:none; padding:9px 16px; border:1px solid var(--line-strong); border-radius:10px; color:var(--text); font-size:13px; transition:border-color .25s,color .25s; }
.open:hover { border-color:var(--accent); color:var(--accent); }
.usage-head { display:flex; align-items:baseline; gap:8px; margin-top:20px; }
.usage-head strong { font-size:22px; }
.usage-head span { color:var(--muted); font-size:13px; }
.bar { height:8px; margin-top:10px; border-radius:999px; background:var(--bg-tint); overflow:hidden; }
.bar span { display:block; height:100%; border-radius:inherit; background:var(--accent); transition:width .6s var(--ease); }
.split { display:flex; flex-wrap:wrap; gap:8px 20px; list-style:none; margin:14px 0 0; padding:0; color:var(--muted); font-size:13px; }
.dot { display:inline-block; width:8px; height:8px; margin-right:6px; border-radius:2px; vertical-align:1px; }
.dot.drive { background:var(--accent); }
.dot.images { background:#7ea2ff; }
.dot.other { background:var(--line-strong); }
.error { margin-top:14px; color:#d15c5c; font-size:13px; }
.muted { margin-top:14px; color:var(--muted); font-size:13px; }
@media (max-width: 520px) { header { flex-direction:column; } }
</style>

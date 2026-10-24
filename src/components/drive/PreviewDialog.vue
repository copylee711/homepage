<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { formatSize } from '../../drive'
import type { DriveEntry } from '../../drive'
import DriveDialog from './DriveDialog.vue'
import { kindOf } from './fileKinds'

const props = defineProps<{ entry: DriveEntry; url: (inline: boolean) => string; siblings?: DriveEntry[] }>()
const emit = defineEmits<{ close: []; open: [entry: DriveEntry] }>()
const kind = computed(() => kindOf(props.entry.name))
const text = ref(''), error = ref(''), truncated = ref(false)
const TEXT_LIMIT = 512 * 1024
const index = computed(() => props.siblings?.findIndex(item => item.path === props.entry.path) ?? -1)
const neighbour = (step: number) => {
  const list = props.siblings ?? []
  for (let i = index.value + step; i >= 0 && i < list.length; i += step) if (!list[i]!.dir) return list[i]
  return undefined
}

onMounted(async () => {
  if (kind.value !== 'text') return
  try {
    // 只读取开头一段，避免大日志文件拖慢页面。
    const response = await fetch(props.url(false), { credentials: 'same-origin', headers: { Range: `bytes=0-${TEXT_LIMIT - 1}` } })
    if (!response.ok && response.status !== 206) throw new Error(`读取失败 (${response.status})`)
    text.value = new TextDecoder('utf-8').decode(await response.arrayBuffer())
    truncated.value = props.entry.size > TEXT_LIMIT
  } catch (err) { error.value = err instanceof Error ? err.message : '读取失败' }
})
</script>

<template>
  <DriveDialog :title="entry.name" :eyebrow="formatSize(entry.size)" wide @close="emit('close')">
    <div class="stage" :class="kind">
      <img v-if="kind === 'image'" :src="url(true)" :alt="entry.name">
      <video v-else-if="kind === 'video'" :src="url(true)" controls preload="metadata" />
      <audio v-else-if="kind === 'audio'" :src="url(true)" controls preload="metadata" />
      <iframe v-else-if="kind === 'pdf'" :src="url(true)" :title="entry.name" />
      <template v-else-if="kind === 'text'">
        <p v-if="error" class="d-note error">{{ error }}</p>
        <pre v-else>{{ text }}</pre>
        <p v-if="truncated" class="d-muted">文件较大，只显示开头 512 KiB。</p>
      </template>
      <p v-else class="d-muted unsupported">这种文件不能在线预览，请下载后打开。</p>
    </div>
    <div class="d-actions">
      <button v-if="siblings" class="d-btn" type="button" :disabled="!neighbour(-1)" @click="emit('open', neighbour(-1)!)">上一个</button>
      <button v-if="siblings" class="d-btn" type="button" :disabled="!neighbour(1)" @click="emit('open', neighbour(1)!)">下一个</button>
      <a class="d-btn primary" :href="url(false)" download>下载</a>
    </div>
  </DriveDialog>
</template>

<style scoped>
.stage { display:grid; place-items:center; min-height:200px; margin-top:16px; border-radius:12px; background:var(--bg-tint); overflow:hidden; }
.stage img,.stage video { max-width:100%; max-height:70vh; display:block; }
.stage audio { width:min(520px,90%); margin:48px 0; }
.stage iframe { width:100%; height:70vh; border:0; background:#fff; }
.stage.text { place-items:stretch; background:var(--surface); border:1px solid var(--line); }
.stage pre { margin:0; padding:18px; max-height:65vh; overflow:auto; font:13px/1.7 var(--font-mono); white-space:pre-wrap; overflow-wrap:anywhere; color:var(--text-2); }
.stage.text .d-muted { padding:0 18px 14px; }
.unsupported { padding:48px 20px; }
</style>

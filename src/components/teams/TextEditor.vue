<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { confirmDialog } from '../../composables/useConfirm'
import { baseName, formatSize } from '../../drive'
import { teamsApi } from '../../teams'
import DriveDialog from '../drive/DriveDialog.vue'

/**
 * 在线编辑团队里的文本文件。不做实时协作：保存时带上打开时的版本，
 * 期间被别人改过就提示冲突，由用户决定覆盖还是放弃自己的修改。
 */
const props = defineProps<{ team: string; path: string; readOnly?: boolean; create?: boolean }>()
const emit = defineEmits<{ close: []; saved: [] }>()

const content = ref(''), original = ref(''), version = ref('')
const loading = ref(!props.create), saving = ref(false), error = ref(''), notice = ref('')
const locked = ref(!!props.readOnly)
const dirty = computed(() => content.value !== original.value)
const lines = computed(() => content.value.split('\n').length)
const bytes = computed(() => new TextEncoder().encode(content.value).length)

async function load() {
  loading.value = true; error.value = ''
  try {
    const data = await teamsApi<{ content: string; version: string; read_only: boolean }>(`/${props.team}/text?path=${encodeURIComponent(props.path)}`)
    content.value = original.value = data.content
    version.value = data.version
    locked.value = locked.value || data.read_only
  } catch (err) { error.value = err instanceof Error ? err.message : '读取失败'; locked.value = true }
  finally { loading.value = false }
}

async function save(force = false) {
  if (locked.value || saving.value) return
  saving.value = true; error.value = ''
  try {
    const data = await teamsApi<{ version: string }>(`/${props.team}/text`, 'PUT', { path: props.path, content: content.value, version: version.value, force })
    version.value = data.version; original.value = content.value
    notice.value = '已保存'; setTimeout(() => { notice.value = '' }, 2000)
    emit('saved')
  } catch (err) {
    if ((err as { status?: number }).status === 409 && !force) {
      saving.value = false
      const overwrite = await confirmDialog({ title: '文件已被其他人修改', message: '你打开之后，有人保存了这个文件。覆盖会丢掉对方的修改；取消后可以先复制自己的内容，再重新打开。', confirmText: '覆盖保存', danger: true })
      if (overwrite) await save(true)
      return
    }
    error.value = err instanceof Error ? err.message : '保存失败'
  } finally { saving.value = false }
}

async function close() {
  if (dirty.value && !await confirmDialog({ title: '放弃未保存的修改？', message: '关闭后这些修改会丢失。', confirmText: '放弃修改', danger: true })) return
  emit('close')
}

// Ctrl/⌘+S 保存；Tab 插入两个空格而不是跳到下一个控件。
function onKey(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save() }
}
function onTab(event: KeyboardEvent) {
  if (event.key !== 'Tab' || locked.value) return
  event.preventDefault()
  const field = event.target as HTMLTextAreaElement
  const { selectionStart: start, selectionEnd: end } = field
  content.value = content.value.slice(0, start) + '  ' + content.value.slice(end)
  requestAnimationFrame(() => { field.selectionStart = field.selectionEnd = start + 2 })
}
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value) { event.preventDefault(); event.returnValue = '' } }

onMounted(() => {
  if (!props.create) void load()
  addEventListener('keydown', onKey)
  addEventListener('beforeunload', beforeUnload)
})
onBeforeUnmount(() => { removeEventListener('keydown', onKey); removeEventListener('beforeunload', beforeUnload) })
</script>

<template>
  <DriveDialog :title="baseName(path)" :eyebrow="`${formatSize(bytes)} · ${lines} 行`" wide @close="close">
    <p class="d-muted where">{{ path }}</p>
    <p v-if="error" class="d-note error" role="alert">{{ error }}</p>
    <p v-if="loading" class="d-muted">正在读取…</p>
    <textarea v-else v-model="content" class="text" spellcheck="false" :readonly="locked" :aria-label="`编辑 ${baseName(path)}`" @keydown="onTab" />
    <footer>
      <span class="d-muted">{{ locked ? '只读' : dirty ? '有未保存的修改 · Ctrl+S 保存' : notice || '没有修改' }}</span>
      <div class="actions">
        <button class="d-btn" type="button" @click="close">关闭</button>
        <button v-if="!locked" class="d-btn primary" type="button" :disabled="saving || (!dirty && !create)" @click="save()">{{ saving ? '正在保存…' : '保存' }}</button>
      </div>
    </footer>
  </DriveDialog>
</template>

<style scoped>
.where { margin:2px 0 0; font:12.5px var(--font-mono); overflow-wrap:anywhere; }
.text { display:block; width:100%; min-height:min(62vh,640px); margin-top:14px; padding:14px 16px; border:1px solid var(--line); border-radius:12px; background:var(--surface); color:var(--text); font:13.5px/1.7 var(--font-mono); white-space:pre; overflow:auto; resize:vertical; outline:none; tab-size:2; }
.text:focus { border-color:var(--field-focus-border); box-shadow:var(--field-focus-shadow); }
footer { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-top:14px; font-size:13px; }
.actions { display:flex; gap:8px; }
@media (max-width:760px) { .text { min-height:56vh; font-size:13px; } }
</style>

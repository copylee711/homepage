<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import * as Y from 'yjs'
import { confirmDialog, promptDialog } from '../../composables/useConfirm'
import { docsApi, timeAgo, withLink } from '../../docs'
import type { DocVersion } from '../../docs'
import MarkdownEditor from '../editor/MarkdownEditor.vue'

const props = defineProps<{ docId: string; link: string }>()
// restore 交给页面：把旧版本的内容作为一次新的编辑写入当前文档，其他协作者也会看到。
const emit = defineEmits<{ close: []; restore: [content: object] }>()

const versions = ref<DocVersion[]>([])
const selected = ref<DocVersion>()
const preview = shallowRef<Y.Doc>()
const viewer = ref<InstanceType<typeof MarkdownEditor>>()
const error = ref(''), loading = ref(true)

async function load() {
  loading.value = true; error.value = ''
  try { versions.value = (await docsApi<{ versions: DocVersion[] }>(withLink(`/${props.docId}/versions`, props.link))).versions }
  catch (err) { error.value = err instanceof Error ? err.message : '读取失败' }
  finally { loading.value = false }
}

async function open(version: DocVersion) {
  selected.value = version; error.value = ''
  try {
    const response = await fetch(`/api/docs${withLink(`/${props.docId}/versions/${version.id}`, props.link)}`, { credentials: 'same-origin' })
    if (!response.ok) throw new Error('读取版本失败')
    const doc = new Y.Doc()
    Y.applyUpdate(doc, new Uint8Array(await response.arrayBuffer()))
    preview.value?.destroy()
    preview.value = doc
  } catch (err) { error.value = err instanceof Error ? err.message : '读取版本失败' }
}

async function save() {
  const label = await promptDialog({ title: '保存当前版本', value: '', input: { placeholder: '版本说明（可选）' }, confirmText: '保存' })
  if (label === null) return
  try { versions.value.unshift(await docsApi<DocVersion>(withLink(`/${props.docId}/versions`, props.link), 'POST', { label })) }
  catch (err) { error.value = err instanceof Error ? err.message : '保存失败' }
}

async function restore() {
  const content = viewer.value?.getJSON()
  if (!content || !selected.value) return
  if (!await confirmDialog({ title: '恢复到这个版本？', message: '当前内容会被替换为所选版本，所有协作者都会看到。替换前的内容仍可在版本历史中找回。', confirmText: '恢复' })) return
  emit('restore', content)
}

const when = (version: DocVersion) => new Date(version.created_at * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
// 版本历史盖住整页，打开期间停用页面本身的滚动，只留列表与预览各自的滚动条。
// 根元素设置了 scrollbar-gutter: stable，隐藏滚动条不会让页面左右跳动。
onMounted(() => { document.documentElement.style.overflow = 'hidden'; void load() })
onBeforeUnmount(() => { document.documentElement.style.overflow = ''; preview.value?.destroy() })
</script>

<template>
  <div class="history">
    <aside class="list">
      <header><h3>版本历史</h3><button class="close" type="button" aria-label="关闭" @click="emit('close')">×</button></header>
      <button class="d-btn" type="button" @click="save">保存当前版本</button>
      <p class="d-muted hint">停顿后重新编辑或连续编辑 30 分钟时，自动保存编辑前的版本。</p>
      <p v-if="error" class="d-note error">{{ error }}</p>
      <p v-if="loading" class="d-muted">正在读取…</p>
      <p v-else-if="!versions.length" class="d-muted">还没有历史版本。</p>
      <ul>
        <li v-for="version in versions" :key="version.id">
          <button type="button" :class="{ on: selected?.id === version.id }" @click="open(version)">
            <strong>{{ version.auto ? when(version) : version.label }}</strong>
            <small>{{ version.auto ? '自动保存' : when(version) }} · {{ version.created_by?.name ?? '未知' }} · {{ timeAgo(version.created_at) }}</small>
          </button>
        </li>
      </ul>
    </aside>
    <section class="view">
      <template v-if="preview && selected">
        <div class="bar"><span>预览：{{ selected.auto ? when(selected) : selected.label }}</span><button class="d-btn primary" type="button" @click="restore">恢复此版本</button></div>
        <MarkdownEditor :key="selected.id" ref="viewer" :collab="{ doc: preview }" :editable="false" />
      </template>
      <p v-else class="d-muted pick">选择左侧的版本查看内容。</p>
    </section>
  </div>
</template>

<style scoped>
.history { position:fixed; inset:var(--header-h) 0 0; z-index:30; display:grid; grid-template-columns:300px minmax(0,1fr); background:var(--bg); }
.list { display:flex; flex-direction:column; gap:10px; padding:20px 16px; border-right:1px solid var(--line); overflow:auto; }
.list header { display:flex; align-items:center; justify-content:space-between; }
.list h3 { margin:0; font-size:17px; }
.close { border:0; background:none; color:var(--muted); font-size:24px; line-height:1; cursor:pointer; }
.hint { margin:0; font-size:12px; }
ul { list-style:none; margin:6px 0 0; padding:0; display:grid; gap:2px; }
li button { display:flex; flex-direction:column; gap:2px; width:100%; padding:10px 12px; border:0; border-radius:10px; background:none; color:var(--text); font:14px var(--font); text-align:left; cursor:pointer; }
li button:hover { background:color-mix(in srgb,var(--text) 4%,transparent); }
li button.on { background:var(--accent-soft); color:var(--accent); }
li small { color:var(--faint); font-size:12px; }
.view { min-width:0; padding:20px clamp(16px,4vw,48px) 40px; overflow:auto; }
.view :deep(.md-content) { max-width:820px; margin:0 auto; }
.bar { position:sticky; top:0; z-index:2; display:flex; align-items:center; justify-content:space-between; gap:12px; max-width:820px; margin:0 auto; padding:10px 0; background:var(--bg); color:var(--muted); font-size:13px; }
.pick { margin-top:40px; text-align:center; }
@media (max-width:760px) {
  .history { grid-template-columns:1fr; grid-template-rows:40vh 1fr; }
  .list { border-right:0; border-bottom:1px solid var(--line); }
}
</style>

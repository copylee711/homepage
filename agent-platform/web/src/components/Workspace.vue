<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import Icon from './Icon.vue';
import { useWorkspace } from '../stores/workspace';
import { useUi } from '../stores/ui';
import { useSession } from '../stores/session';
import { formatBytes } from '../services/format';

const ws = useWorkspace();
const ui = useUi();
const session = useSession();
const dragover = ref(false);

const crumbs = computed(() => {
  const parts = ws.path ? ws.path.split('/').filter(Boolean) : [];
  const out = [{ label: '工作区', path: '' }];
  let built = '';
  for (const p of parts) { built = built ? built + '/' + p : p; out.push({ label: p, path: built }); }
  return out;
});

function openEntry(e: any) { if (e.type === 'dir') ws.navigate(e.path); else void ws.previewFile(e.path); }
function fileContext(ev: MouseEvent, e: any) {
  const isFile = e.type !== 'dir';
  ui.openContext(ev, [
    { header: e.name },
    e.type === 'dir' ? { icon: 'folder-open', label: '打开文件夹', action: () => ws.navigate(e.path) } : { icon: 'file', label: '预览', action: () => ws.previewFile(e.path) },
    isFile ? { icon: 'corner-down-left', label: '引用路径到对话', action: () => insertPath(e.path) } : null,
    isFile ? { icon: 'download', label: '下载文件', action: () => { const a = document.createElement('a'); a.href = '/api/files/download?path=' + encodeURIComponent(e.path); a.click(); } } : null,
    { icon: 'copy', label: '复制文件名', action: () => navigator.clipboard?.writeText(e.name).then(() => ui.toast('已复制文件名', { tone: 'success' })) },
  ]);
}

function startResize(ev: PointerEvent) {
  ev.preventDefault();
  const move = (e: PointerEvent) => ui.setWorkspaceW(window.innerWidth - e.clientX);
  const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.body.style.cursor = ''; };
  document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.body.style.cursor = 'col-resize';
}

async function onDrop(e: DragEvent) {
  dragover.value = false;
  const file = e.dataTransfer?.files?.[0]; if (!file) return;
  if (file.size > 256 * 1024) { ui.toast('上传文件不能超过 256 KiB', { tone: 'error' }); return; }
  try {
    const content = await file.text();
    if (content.includes('\u0000')) { ui.toast('暂不支持上传二进制文件', { tone: 'error' }); return; }
    await ws.upload(file.name, content, false);
    ui.toast('已上传 ' + file.name, { tone: 'success' });
  } catch (err: any) { ui.toast(err.message, { tone: 'error' }); }
}

function insertPath(p: string) {
  const ref = "'/workspace/" + p.replace(/^\/workspace\/?/, '') + "'";
  const el = document.querySelector('.composer textarea') as HTMLTextAreaElement | null;
  if (el) { el.value = (el.value ? el.value + ' ' : '') + ref; el.dispatchEvent(new Event('input', { bubbles: true })); el.focus(); }
  ui.toast('已插入文件路径', { tone: 'success' });
}

onMounted(() => { if (!ws.entries.length && !ws.loading) void ws.load(''); });
</script>

<template>
  <aside class="workspace" aria-label="工作区文件">
    <div class="resize-handle resize-workspace" role="separator" aria-orientation="vertical" aria-label="调整工作区宽度" @pointerdown="startResize"></div>
    <header class="workspace-head">
      <div class="workspace-title"><h2>工作区</h2><p>仅你的沙箱 <code>/workspace</code></p></div>
      <div class="workspace-actions">
        <button class="icon-button" aria-label="刷新" title="刷新" @click="ws.load(ws.path, true)"><Icon name="refresh" /></button>
        <button class="icon-button only-narrow" aria-label="关闭工作区" title="关闭" @click="ui.mobileDrawer ? (ui.mobileDrawer = null) : ui.setWorkspaceOpen(false)"><Icon name="x" /></button>
      </div>
    </header>
    <div class="workspace-toolbar">
      <button class="icon-button small" aria-label="上一级" title="上一级" :disabled="!ws.path" @click="ws.navigate(crumbs[crumbs.length - 2]?.path || '')"><Icon name="chevron-left" /></button>
      <nav class="breadcrumb" aria-label="当前目录">
        <template v-for="(c, i) in crumbs" :key="c.path">
          <span v-if="i > 0" class="crumb-sep">/</span>
          <button class="crumb" @click="ws.navigate(c.path)">{{ c.label }}</button>
        </template>
      </nav>
    </div>
    <div class="file-list" :class="{ 'is-dragover': dragover }" @dragover.prevent="dragover = true" @dragleave="dragover = false" @drop.prevent="onDrop">
      <div v-if="ws.loading && !ws.entries.length" class="workspace-status"><span class="spinner"></span><span>正在读取工作区…</span></div>
      <p v-else-if="ws.error" class="list-empty">{{ ws.error }}</p>
      <p v-else-if="!ws.entries.length" class="list-empty">此文件夹为空。拖拽文本文件到这里可上传。</p>
      <button v-for="e in ws.entries" :key="e.path" class="file-row" :class="{ 'is-selected': e.path === ws.selected }" :data-dir="e.type === 'dir' ? '' : undefined" :title="e.name" @click="openEntry(e)" @contextmenu="ev => fileContext(ev, e)">
        <span class="file-icon"><Icon :name="e.type === 'dir' ? 'folder' : e.type === 'symlink' ? 'link' : 'file'" :size="16" /></span>
        <span class="file-name">{{ e.name }}</span>
        <span class="file-size">{{ e.type === 'dir' ? '' : formatBytes(e.size) }}</span>
      </button>
    </div>
    <section v-if="ws.preview" class="workspace-preview">
      <header class="preview-head">
        <div class="preview-title"><h3>{{ ws.preview.name }}</h3><p>{{ ws.preview.meta }}</p></div>
        <button class="icon-button small" aria-label="关闭预览" @click="ws.closePreview()"><Icon name="x" :size="16" /></button>
      </header>
      <pre class="preview-body">{{ ws.preview.text }}</pre>
      <p v-if="ws.preview.note" class="preview-note">{{ ws.preview.note }}</p>
      <footer class="preview-actions">
        <button class="btn btn-quiet" @click="insertPath(ws.selected!)">插入路径</button>
        <a class="btn btn-quiet" :href="'/api/files/download?path=' + encodeURIComponent(ws.selected || '')"><Icon name="download" :size="15" /><span>下载</span></a>
      </footer>
    </section>
  </aside>
</template>

<style src="./workspace.css"></style>

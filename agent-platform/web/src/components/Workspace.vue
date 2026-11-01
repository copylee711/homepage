<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue';
import Icon from './Icon.vue';
import DropMenu, { type MenuItem } from './DropMenu.vue';
import { useWorkspace, FILES_TAB, type OpenFileTab } from '../stores/workspace';
import { useUi } from '../stores/ui';
import { formatBytes } from '../services/format';
import { highlightInto } from '../services/highlight.js';

const ws = useWorkspace();
const ui = useUi();

const dragover = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const addAnchor = ref<HTMLElement | null>(null);
const addMenu = ref<MenuItem[] | null>(null);
const codeRef = ref<HTMLElement | null>(null);

const isMobileDrawer = computed(() => !!ui.mobileDrawer);
const isDual = computed(() => ui.workspaceDual && !isMobileDrawer.value);

const crumbs = computed(() => {
  const parts = ws.path ? ws.path.split('/').filter(Boolean) : [];
  const out = [{ label: '工作区', path: '' }];
  let built = '';
  for (const p of parts) {
    built = built ? built + '/' + p : p;
    out.push({ label: p, path: built });
  }
  return out;
});

const activeFileTab = computed<OpenFileTab | null>(() => {
  if (isDual.value) {
    return ws.tabs.find(t => t.path === ws.activeTab) || ws.tabs[0] || null;
  }
  if (ws.activeTab === FILES_TAB) return null;
  return ws.tabs.find(t => t.path === ws.activeTab) || null;
});

function extLang(name: string) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map: Record<string, string> = {
    py: 'py', js: 'js', mjs: 'js', cjs: 'js', ts: 'ts', tsx: 'tsx', jsx: 'jsx',
    json: 'json', sh: 'sh', bash: 'sh', zsh: 'sh', css: 'css', scss: 'scss',
    html: 'html', vue: 'html', svg: 'xml', xml: 'xml', md: 'md', yml: 'yaml', yaml: 'yaml',
    rs: 'rust', go: 'go', c: 'c', h: 'c', cpp: 'cpp', java: 'java', sql: 'sql', toml: 'toml',
  };
  return map[ext] || ext;
}

function renderHighlight() {
  const el = codeRef.value;
  const tab = activeFileTab.value;
  if (!el || !tab || tab.editing || tab.binary || tab.loading) return;
  highlightInto(el, tab.text, extLang(tab.name));
}

watch(
  () => [activeFileTab.value?.path, activeFileTab.value?.text, activeFileTab.value?.editing, activeFileTab.value?.loading, isDual.value],
  () => { void nextTick(renderHighlight); },
  { immediate: true }
);

function openEntry(e: any) {
  if (e.type === 'dir') ws.navigate(e.path);
  else void ws.openFile(e.path);
}

function openAddMenu() {
  const prefix = ws.path ? ws.path + '/' : '';
  addMenu.value = [
    {
      icon: 'file',
      label: '新建文本文件',
      action: async () => {
        const p = await ui.prompt({ title: '新建文本文件', message: '输入相对于工作区根目录的文件路径', defaultValue: prefix + 'untitled.txt', placeholder: '例如 notes.md 或 src/app.py', confirmText: '创建' });
        if (!p?.trim()) return;
        try { await ws.createFile(p.trim()); ui.toast('已创建文件', { tone: 'success' }); }
        catch (err: any) { ui.toast(err.message, { tone: 'error' }); }
      },
    },
    {
      icon: 'folder',
      label: '新建文件夹',
      action: async () => {
        const p = await ui.prompt({ title: '新建文件夹', message: '输入相对于工作区根目录的文件夹路径', defaultValue: prefix + 'new-folder', placeholder: '例如 docs 或 src/utils', confirmText: '创建' });
        if (!p?.trim()) return;
        try { await ws.createDir(p.trim()); ui.toast('已创建文件夹', { tone: 'success' }); }
        catch (err: any) { ui.toast(err.message, { tone: 'error' }); }
      },
    },
    {
      icon: 'upload',
      label: '上传文本文件…',
      action: () => fileInput.value?.click(),
    },
  ];
}

function fileContext(ev: MouseEvent, e: any) {
  const isFile = e.type !== 'dir';
  ui.openContext(ev, [
    { header: e.name },
    e.type === 'dir'
      ? { icon: 'folder-open', label: '打开文件夹', action: () => ws.navigate(e.path) }
      : { icon: 'file', label: '打开标签页', action: () => ws.openFile(e.path) },
    isFile ? { icon: 'edit', label: '编辑文本', action: () => ws.openFile(e.path, true) } : null,
    isFile ? { icon: 'corner-down-left', label: '引用路径到对话', action: () => insertPath(e.path) } : null,
    isFile ? { icon: 'download', label: '下载文件', action: () => triggerDownload(e.path) } : null,
    {
      icon: 'edit',
      label: '重命名 / 移动',
      action: async () => {
        const next = await ui.prompt({ title: '重命名 / 移动', message: '输入新的工作区相对路径', defaultValue: e.path, confirmText: '确定' });
        if (!next?.trim() || next.trim() === e.path) return;
        try { await ws.renameEntry(e.path, next.trim()); ui.toast('已重命名', { tone: 'success' }); }
        catch (err: any) { ui.toast(err.message, { tone: 'error' }); }
      },
    },
    {
      icon: 'copy',
      label: '复制文件名',
      action: () => navigator.clipboard?.writeText(e.name).then(() => ui.toast('已复制文件名', { tone: 'success' })),
    },
    {
      icon: 'trash',
      label: e.type === 'dir' ? '删除空文件夹' : '删除文件',
      danger: true,
      action: async () => {
        if (!(await ui.confirm({ title: e.type === 'dir' ? '删除文件夹' : '删除文件', message: `确定删除“${e.name}”？此操作不可撤销（文件夹须为空）。`, confirmText: '删除', danger: true }))) return;
        try { await ws.deleteEntry(e.path); ui.toast('已删除', { tone: 'success' }); }
        catch (err: any) { ui.toast(err.message, { tone: 'error' }); }
      },
    },
  ]);
}

function triggerDownload(path: string) {
  const a = document.createElement('a');
  a.href = '/api/files/download?path=' + encodeURIComponent(path);
  a.click();
}

function startResize(ev: PointerEvent) {
  ev.preventDefault();
  const move = (e: PointerEvent) => ui.setWorkspaceW(window.innerWidth - e.clientX);
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.body.style.cursor = '';
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  document.body.style.cursor = 'col-resize';
}

async function handleSelectedFile(file: File | undefined) {
  if (!file) return;
  if (file.size > 256 * 1024) {
    ui.toast('上传文件不能超过 256 KiB', { tone: 'error' });
    return;
  }
  try {
    const content = await file.text();
    if (content.includes('\u0000')) {
      ui.toast('暂不支持上传二进制文件', { tone: 'error' });
      return;
    }
    const ok = await ws.upload(file.name, content, false);
    if (ok) ui.toast('已上传 ' + file.name, { tone: 'success' });
  } catch (err: any) {
    ui.toast(err.message, { tone: 'error' });
  }
}

async function onFilePicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  await handleSelectedFile(file);
}

async function onDrop(e: DragEvent) {
  dragover.value = false;
  await handleSelectedFile(e.dataTransfer?.files?.[0]);
}

function insertPath(p: string) {
  const refText = "'/workspace/" + p.replace(/^\/workspace\/?/, '') + "'";
  const el = document.querySelector('.composer textarea') as HTMLTextAreaElement | null;
  if (el) {
    el.value = (el.value ? el.value + ' ' : '') + refText;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.focus();
  }
  ui.toast('已插入文件路径', { tone: 'success' });
}

async function saveActive() {
  const tab = activeFileTab.value;
  if (!tab) return;
  try {
    await ws.saveTab(tab.path);
    ui.toast('已保存 ' + tab.name, { tone: 'success' });
  } catch (err: any) {
    ui.toast(err.status === 409 ? '文件已在外部更改，请刷新后重试' : err.message, { tone: 'error' });
  }
}

function onEditorKeydown(e: KeyboardEvent) {
  const tab = activeFileTab.value;
  if (!tab) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (tab.draft !== tab.text) void saveActive();
    return;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    const ta = e.target as HTMLTextAreaElement;
    const s = ta.selectionStart;
    const end = ta.selectionEnd;
    tab.draft = tab.draft.slice(0, s) + '  ' + tab.draft.slice(end);
    void nextTick(() => { ta.selectionStart = ta.selectionEnd = s + 2; });
  }
}

function copyContent(tab: OpenFileTab) {
  navigator.clipboard?.writeText(tab.editing ? tab.draft : tab.text).then(() => ui.toast('已复制文件内容', { tone: 'success' }));
}

function closeWorkspace() {
  if (ui.mobileDrawer) ui.mobileDrawer = null;
  else ui.setWorkspaceOpen(false);
}

onMounted(() => {
  if (!ws.entries.length && !ws.loading) void ws.load('');
});
</script>

<template>
  <aside class="workspace" :class="{ 'is-dual': isDual }" aria-label="工作区">
    <div class="resize-handle resize-workspace" role="separator" aria-orientation="vertical" aria-label="调整工作区宽度" @pointerdown="startResize"></div>

    <!-- Single unified header bar: breadcrumbs directly on top + compact actions -->
    <header class="workspace-head">
      <div class="ws-crumb-wrap">
        <button
          v-if="ws.path"
          type="button"
          class="icon-button small"
          aria-label="上一级"
          title="返回上一级"
          @click="ws.navigate(crumbs[crumbs.length - 2]?.path || '')"
        >
          <Icon name="chevron-left" :size="16" />
        </button>
        <nav class="breadcrumb" aria-label="当前路径">
          <template v-for="(c, i) in crumbs" :key="c.path">
            <span v-if="i > 0" class="crumb-sep">/</span>
            <button
              type="button"
              class="crumb"
              :class="{ 'is-current': i === crumbs.length - 1 }"
              @click="ws.navigate(c.path)"
            >{{ c.label }}</button>
          </template>
        </nav>
      </div>

      <div class="workspace-actions">
        <button ref="addAnchor" type="button" class="icon-button small" aria-label="新建或上传" title="新建或上传" @click="openAddMenu">
          <Icon name="plus" :size="16" />
        </button>
        <button type="button" class="icon-button small" aria-label="刷新" title="刷新目录" @click="ws.load(ws.path, true)">
          <Icon name="refresh" :size="15" />
        </button>
        <button
          v-if="!isMobileDrawer"
          type="button"
          class="icon-button small"
          :class="{ 'is-on': ui.workspaceDual }"
          :aria-label="ui.workspaceDual ? '切换为单栏标签页' : '切换为双右栏并排'"
          :title="ui.workspaceDual ? '单栏标签页模式' : '双右栏并排模式'"
          @click="ui.setWorkspaceDual(!ui.workspaceDual)"
        >
          <Icon name="columns" :size="15" />
        </button>
        <button type="button" class="icon-button small" aria-label="关闭工作区" title="关闭工作区" @click="closeWorkspace">
          <Icon name="x" :size="16" />
        </button>
      </div>
      <input ref="fileInput" type="file" hidden @change="onFilePicked">
    </header>

    <!-- Single-sidebar Tab Bar (shown when not in dual mode and at least 1 file tab is open) -->
    <div v-if="!isDual && ws.tabs.length" class="ws-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        class="ws-tab"
        :class="{ 'is-active': ws.activeTab === FILES_TAB }"
        @click="ws.activeTab = FILES_TAB"
      >
        <Icon name="folder" :size="13" />
        <span>目录</span>
      </button>
      <div
        v-for="t in ws.tabs"
        :key="t.path"
        role="tab"
        class="ws-tab"
        :class="{ 'is-active': ws.activeTab === t.path }"
        :title="t.path"
        @click="ws.activeTab = t.path; ws.selected = t.path"
      >
        <span class="ws-tab-name">{{ t.name }}</span>
        <span v-if="t.editing && t.draft !== t.text" class="ws-dirty-dot" title="未保存"></span>
        <button type="button" class="ws-tab-close" aria-label="关闭标签" @click.stop="ws.closeTab(t.path)">
          <Icon name="x" :size="11" />
        </button>
      </div>
    </div>

    <!-- Body: either Dual Columns (Explorer + Viewer) or Single Tabbed Stage -->
    <div class="ws-stage" :class="{ 'is-dual': isDual }">
      <!-- Explorer Pane -->
      <div
        v-show="isDual || !activeFileTab"
        class="file-list"
        :class="{ 'is-dragover': dragover }"
        @dragover.prevent="dragover = true"
        @dragleave="dragover = false"
        @drop.prevent="onDrop"
      >
        <div v-if="ws.loading && !ws.entries.length" class="workspace-status">
          <span class="spinner"></span><span>正在读取…</span>
        </div>
        <p v-else-if="ws.error" class="list-empty">{{ ws.error }}</p>
        <p v-else-if="!ws.entries.length" class="list-empty">当前目录为空，可点击右上角 + 新建或拖拽文本文件上传。</p>

        <button
          v-for="e in ws.entries"
          :key="e.path"
          type="button"
          class="file-row"
          :class="{ 'is-selected': activeFileTab?.path === e.path || (!activeFileTab && ws.selected === e.path) }"
          :data-dir="e.type === 'dir' ? '' : undefined"
          :title="e.name"
          @click="openEntry(e)"
          @contextmenu="ev => fileContext(ev, e)"
        >
          <span class="file-icon"><Icon :name="e.type === 'dir' ? 'folder' : e.type === 'symlink' ? 'link' : 'file'" :size="15" /></span>
          <span class="file-name">{{ e.name }}</span>
          <span class="file-size">{{ e.type === 'dir' ? '' : formatBytes(e.size) }}</span>
        </button>
      </div>

      <!-- File Viewer / Editor Pane -->
      <section v-if="isDual || activeFileTab" class="ws-viewer">
        <!-- In dual mode, file tabs sit across the top of the right column -->
        <div v-if="isDual && ws.tabs.length" class="ws-tabs ws-tabs-dual" role="tablist">
          <div
            v-for="t in ws.tabs"
            :key="t.path"
            role="tab"
            class="ws-tab"
            :class="{ 'is-active': activeFileTab?.path === t.path }"
            :title="t.path"
            @click="ws.activeTab = t.path; ws.selected = t.path"
          >
            <span class="ws-tab-name">{{ t.name }}</span>
            <span v-if="t.editing && t.draft !== t.text" class="ws-dirty-dot" title="未保存"></span>
            <button type="button" class="ws-tab-close" aria-label="关闭标签" @click.stop="ws.closeTab(t.path)">
              <Icon name="x" :size="11" />
            </button>
          </div>
        </div>

        <template v-if="activeFileTab">
          <header class="viewer-bar">
            <div class="viewer-meta">
              <span class="viewer-path" :title="activeFileTab.path">{{ activeFileTab.path }}</span>
              <span class="viewer-size">{{ activeFileTab.meta }}</span>
            </div>
            <div class="viewer-tools">
              <template v-if="!activeFileTab.binary && !activeFileTab.truncated && !activeFileTab.loading">
                <template v-if="activeFileTab.editing">
                  <button
                    type="button"
                    class="viewer-pill is-solid"
                    :disabled="activeFileTab.saving || activeFileTab.draft === activeFileTab.text"
                    @click="saveActive"
                  >
                    {{ activeFileTab.saving ? '保存中…' : '保存' }}
                  </button>
                  <button
                    type="button"
                    class="viewer-pill"
                    :disabled="activeFileTab.saving"
                    @click="activeFileTab.draft = activeFileTab.text; activeFileTab.editing = false"
                  >
                    取消
                  </button>
                </template>
                <button v-else type="button" class="viewer-pill" @click="activeFileTab.editing = true">
                  <Icon name="edit" :size="12" /><span>编辑</span>
                </button>
              </template>
              <button v-if="!activeFileTab.binary" type="button" class="icon-button mini" title="复制内容" aria-label="复制内容" @click="copyContent(activeFileTab)">
                <Icon name="copy" :size="14" />
              </button>
              <button type="button" class="icon-button mini" title="引用路径到对话" aria-label="引用路径" @click="insertPath(activeFileTab.path)">
                <Icon name="corner-down-left" :size="14" />
              </button>
              <button type="button" class="icon-button mini" title="下载文件" aria-label="下载文件" @click="triggerDownload(activeFileTab.path)">
                <Icon name="download" :size="14" />
              </button>
            </div>
          </header>

          <p v-if="activeFileTab.note" class="preview-note">{{ activeFileTab.note }}</p>

          <div v-if="activeFileTab.loading" class="workspace-status">
            <span class="spinner"></span><span>正在读取文件…</span>
          </div>
          <textarea
            v-else-if="activeFileTab.editing"
            v-model="activeFileTab.draft"
            class="ws-editor"
            spellcheck="false"
            aria-label="编辑文件内容"
            @keydown="onEditorKeydown"
          ></textarea>
          <pre v-else-if="!activeFileTab.binary" class="preview-body"><code ref="codeRef">{{ activeFileTab.text }}</code></pre>
        </template>

        <div v-else class="viewer-empty">
          <Icon name="file" :size="24" />
          <span>从左侧点击文件以预览或编辑</span>
        </div>
      </section>
    </div>

    <DropMenu v-if="addMenu && addAnchor" :anchor="addAnchor" :items="addMenu" label="新建或上传" @close="addMenu = null" />
  </aside>
</template>

<style src="./workspace.css"></style>

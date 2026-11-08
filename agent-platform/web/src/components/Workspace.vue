<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue';
import Icon from './Icon.vue';
import { fileToBase64 } from '../services/files';
import MarkdownView from './MarkdownView.vue';
import TerminalPane from './TerminalPane.vue';
import BrowserPane from './BrowserPane.vue';
import DropMenu, { type MenuItem } from './DropMenu.vue';
import { useWorkspace, FILES_TAB, TERMINAL_TAB, BROWSER_TAB, type OpenFileTab } from '../stores/workspace';
import { useUi } from '../stores/ui';
import { useSession } from '../stores/session';
import { formatBytes } from '../services/format';
import { highlightInto } from '../services/highlight.js';

const ws = useWorkspace();
const ui = useUi();
const session = useSession();

const dragover = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const addAnchor = ref<HTMLElement | null>(null);
const addMenu = ref<MenuItem[] | null>(null);
const codeRef = ref<HTMLElement | null>(null);
const fileListRef = ref<HTMLElement | null>(null);
const breadcrumbRef = ref<HTMLElement | null>(null);
watch(() => ws.path, async () => {
  await nextTick();
  const el = breadcrumbRef.value;
  if (el) el.scrollLeft = el.scrollWidth;
});
const mdSourceMode = ref<Record<string, boolean>>({});

// Multi-select & Rubber-band Marquee state
const selectedPaths = ref<string[]>([]);
const lastAnchorPath = ref<string>('');
const marquee = ref<{ active: boolean; x: number; y: number; w: number; h: number }>({
  active: false, x: 0, y: 0, w: 0, h: 0,
});
let suppressNextClick = false;

const selectedSet = computed(() => new Set(selectedPaths.value));
const selectedEntries = computed(() => ws.entries.filter(e => selectedSet.value.has(e.path)));
const selectedFiles = computed(() => selectedEntries.value.filter(e => e.type !== 'dir'));

watch(() => ws.path, () => {
  selectedPaths.value = [];
  lastAnchorPath.value = '';
});
watch(() => ws.entries, (entries) => {
  if (!selectedPaths.value.length) return;
  const valid = new Set(entries.map(e => e.path));
  const filtered = selectedPaths.value.filter(p => valid.has(p));
  if (filtered.length !== selectedPaths.value.length) selectedPaths.value = filtered;
});

const isMobileDrawer = computed(() => !!ui.mobileDrawer);
const isDual = computed(() => ui.workspaceDual && !isMobileDrawer.value);

const crumbs = computed(() => {
  const parts = ws.path ? ws.path.split('/').filter(Boolean) : [];
  const out = [{ label: '/workspace', path: '' }];
  let built = '';
  for (const p of parts) {
    built = built ? built + '/' + p : p;
    out.push({ label: p, path: built });
  }
  return out;
});

const isTerminalActive = computed(() => ws.activeTab === TERMINAL_TAB);
const isBrowserActive = computed(() => ws.activeTab === BROWSER_TAB);

const currentFolderLabel = computed(() => {
  if (activeFileTab.value) {
    const parts = activeFileTab.value.path.split('/').filter(Boolean);
    if (parts.length > 1) {
      return parts[parts.length - 2];
    }
    return 'workspace';
  }
  if (ws.path) {
    const parts = ws.path.split('/').filter(Boolean);
    return parts[parts.length - 1] || 'workspace';
  }
  return 'workspace';
});

// Terminal: a real PTY relayed by the sandbox broker. The component is kept
// mounted while the workspace is open so switching tabs never drops the shell.
const terminalEverOpened = ref(false);
const termRef = ref<InstanceType<typeof TerminalPane> | null>(null);

function openTerminalTab() {
  ws.activeTab = TERMINAL_TAB;
  terminalEverOpened.value = true;
  void nextTick(() => termRef.value?.focus());
}

function toggleTerminal() {
  if (isTerminalActive.value) {
    ws.activeTab = ws.tabs[0]?.path || FILES_TAB;
  } else {
    openTerminalTab();
  }
}

// The live browser keeps running while its tab is hidden, exactly like the
// shell: closing the tab would drop the page the user was working in.
const browserEverOpened = ref(false);
const browserRef = ref<InstanceType<typeof BrowserPane> | null>(null);

function openBrowserTab() {
  ws.activeTab = BROWSER_TAB;
  browserEverOpened.value = true;
  // A real page is unreadable in a 300px column; give the dock room once.
  if (ui.workspaceW < 560) ui.setWorkspaceW(600);
}

function toggleBrowser() {
  if (isBrowserActive.value) {
    ws.activeTab = ws.tabs[0]?.path || FILES_TAB;
  } else {
    openBrowserTab();
  }
}

const activeFileTab = computed<OpenFileTab | null>(() => {
  if (ws.activeTab === FILES_TAB || ws.activeTab === TERMINAL_TAB || ws.activeTab === BROWSER_TAB) {
    if (isDual.value && ws.activeTab === FILES_TAB) {
      return ws.tabs[0] || null;
    }
    return null;
  }
  return ws.tabs.find(t => t.path === ws.activeTab) || (isDual.value ? ws.tabs[0] || null : null);
});

function extLang(name: string) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map: Record<string, string> = {
    py: 'py', js: 'js', mjs: 'js', cjs: 'js', ts: 'ts', tsx: 'tsx', jsx: 'jsx',
    json: 'json', sh: 'sh', bash: 'sh', zsh: 'sh', css: 'css', scss: 'scss',
    html: 'html', htm: 'html', vue: 'vue', svg: 'xml', xml: 'xml', md: 'md', markdown: 'md', mdx: 'md', yml: 'yaml', yaml: 'yaml', rb: 'ruby', diff: 'diff', patch: 'diff', env: 'env', ini: 'ini', conf: 'conf',
    rs: 'rust', go: 'go', c: 'c', h: 'c', cpp: 'cpp', java: 'java', sql: 'sql', toml: 'toml',
  };
  return map[ext] || ext;
}

function isMarkdownFile(name: string) {
  return /\.(md|markdown|mdx)$/i.test(name || '');
}
// Text formats with a rendered view; the same toggle switches back to source.
function renderableKind(name: string): 'md' | 'html' | 'csv' | null {
  if (isMarkdownFile(name)) return 'md';
  if (/\.html?$/i.test(name || '')) return 'html';
  if (/\.(csv|tsv)$/i.test(name || '')) return 'csv';
  return null;
}
const renderedKind = computed(() => {
  const tab = activeFileTab.value;
  if (!tab || tab.editing || tab.binary || tab.isImage || tab.loading) return null;
  return mdSourceMode.value[tab.path] ? null : renderableKind(tab.name);
});
const showRenderedMd = computed(() => renderedKind.value === 'md');
const htmlPreviewUrl = computed(() => {
  const tab = activeFileTab.value;
  return tab ? `/api/files/download?path=${encodeURIComponent(tab.path)}&inline=1&v=${tab.revision || Date.now()}` : '';
});
// Minimal RFC 4180 parsing, capped for responsiveness.
const csvRows = computed(() => {
  const tab = activeFileTab.value;
  if (renderedKind.value !== 'csv' || !tab) return [] as string[][];
  const sep = /\.tsv$/i.test(tab.name) ? '\t' : ',';
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false;
  const text = tab.text || '';
  for (let i = 0; i < text.length && rows.length < 1000; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch; continue; }
    if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
});

function toggleMdMode(path: string) {
  mdSourceMode.value = { ...mdSourceMode.value, [path]: !mdSourceMode.value[path] };
}

function renderHighlight() {
  const el = codeRef.value;
  const tab = activeFileTab.value;
  if (!el || !tab || tab.editing || tab.binary || tab.isImage || tab.loading || renderedKind.value) return;
  highlightInto(el, tab.text || '', extLang(tab.name));
}

watch(
  () => [activeFileTab.value?.path, activeFileTab.value?.text, activeFileTab.value?.editing, activeFileTab.value?.loading, isDual.value, renderedKind.value],
  () => { void nextTick(renderHighlight); },
  { immediate: true, flush: 'post' }
);

function openEntry(e: any) {
  if (e.type === 'dir') ws.navigate(e.path);
  else void ws.openFile(e.path);
}

function onRowClick(ev: MouseEvent, e: any) {
  if (suppressNextClick) {
    ev.preventDefault();
    return;
  }
  if (ev.ctrlKey || ev.metaKey) {
    ev.preventDefault();
    const next = new Set(selectedPaths.value);
    if (next.has(e.path)) next.delete(e.path);
    else next.add(e.path);
    selectedPaths.value = [...next];
    lastAnchorPath.value = e.path;
    return;
  }
  if (ev.shiftKey && ws.entries.length) {
    ev.preventDefault();
    const anchor = lastAnchorPath.value || ws.selected || ws.entries[0]?.path || e.path;
    const i1 = ws.entries.findIndex(x => x.path === anchor);
    const i2 = ws.entries.findIndex(x => x.path === e.path);
    if (i1 >= 0 && i2 >= 0) {
      const [lo, hi] = i1 <= i2 ? [i1, i2] : [i2, i1];
      const next = new Set(ev.ctrlKey || ev.metaKey ? selectedPaths.value : []);
      for (let i = lo; i <= hi; i++) next.add(ws.entries[i].path);
      selectedPaths.value = [...next];
      return;
    }
  }
  selectedPaths.value = [];
  lastAnchorPath.value = e.path;
  openEntry(e);
}

// Desktop rubber-band marquee selection inside .file-list
function onListPointerDown(ev: PointerEvent) {
  if (ev.button !== 0 || ev.pointerType === 'touch') return;
  const listEl = fileListRef.value;
  if (!listEl) return;
  if ((ev.target as HTMLElement | null)?.closest('.ws-batch-bar')) return;

  listEl.focus({ preventScroll: true });
  const startClientX = ev.clientX;
  const startClientY = ev.clientY;
  const r0 = listEl.getBoundingClientRect();
  if (ev.clientX - r0.left > listEl.clientWidth) return;

  const originX = ev.clientX - r0.left + listEl.scrollLeft;
  const originY = ev.clientY - r0.top + listEl.scrollTop;
  const additive = ev.ctrlKey || ev.metaKey || ev.shiftKey;
  const initialSet = new Set(additive ? selectedPaths.value : []);
  let started = false;

  const updateMarquee = (moveEv: PointerEvent) => {
    const dx = moveEv.clientX - startClientX;
    const dy = moveEv.clientY - startClientY;
    if (!started) {
      if (Math.hypot(dx, dy) < 5) return;
      started = true;
      suppressNextClick = true;
      document.body.style.userSelect = 'none';
    }
    const r = listEl.getBoundingClientRect();
    if (moveEv.clientY < r.top + 24) listEl.scrollTop -= 10;
    else if (moveEv.clientY > r.bottom - 24) listEl.scrollTop += 10;

    const maxW = Math.max(listEl.scrollWidth, listEl.clientWidth);
    const maxH = Math.max(listEl.scrollHeight, listEl.clientHeight);
    const curX = Math.max(0, Math.min(maxW, moveEv.clientX - r.left + listEl.scrollLeft));
    const curY = Math.max(0, Math.min(maxH, moveEv.clientY - r.top + listEl.scrollTop));

    const x = Math.min(originX, curX);
    const y = Math.min(originY, curY);
    const w = Math.abs(curX - originX);
    const h = Math.abs(curY - originY);
    marquee.value = { active: true, x, y, w, h };

    const rows = listEl.querySelectorAll<HTMLElement>('.file-row[data-entry-path]');
    const hitPaths = new Set<string>();
    rows.forEach((row) => {
      const p = row.dataset.entryPath;
      if (!p) return;
      const rr = row.getBoundingClientRect();
      const rx1 = rr.left - r.left + listEl.scrollLeft;
      const ry1 = rr.top - r.top + listEl.scrollTop;
      const rx2 = rx1 + rr.width;
      const ry2 = ry1 + rr.height;
      if (rx1 <= x + w && rx2 >= x && ry1 <= y + h && ry2 >= y) {
        hitPaths.add(p);
      }
    });

    if (moveEv.ctrlKey || moveEv.metaKey) {
      const next = new Set(initialSet);
      for (const p of hitPaths) {
        if (next.has(p)) next.delete(p);
        else next.add(p);
      }
      selectedPaths.value = [...next];
    } else {
      selectedPaths.value = [...new Set([...initialSet, ...hitPaths])];
    }
  };

  const finishMarquee = (upEv: PointerEvent) => {
    window.removeEventListener('pointermove', updateMarquee);
    window.removeEventListener('pointerup', finishMarquee);
    window.removeEventListener('pointercancel', finishMarquee);
    document.body.style.userSelect = '';

    if (started) {
      marquee.value = { active: false, x: 0, y: 0, w: 0, h: 0 };
      setTimeout(() => { suppressNextClick = false; }, 0);
    } else {
      const clickedRow = (upEv.target as HTMLElement | null)?.closest('.file-row');
      if (!clickedRow && !additive && selectedPaths.value.length) {
        selectedPaths.value = [];
      }
    }
  };

  window.addEventListener('pointermove', updateMarquee);
  window.addEventListener('pointerup', finishMarquee);
  window.addEventListener('pointercancel', finishMarquee);
}

function selectAllEntries() {
  selectedPaths.value = ws.entries.map(e => e.path);
}

function onListKeydown(ev: KeyboardEvent) {
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'a') {
    if (!ws.entries.length) return;
    ev.preventDefault();
    selectAllEntries();
    return;
  }
  if (ev.key === 'Escape' && selectedPaths.value.length) {
    ev.preventDefault();
    ev.stopPropagation();
    selectedPaths.value = [];
    return;
  }
  if ((ev.key === 'Delete' || ev.key === 'Backspace') && selectedPaths.value.length) {
    ev.preventDefault();
    void batchDelete();
  }
}

function batchInsertPaths() {
  const items = selectedEntries.value;
  if (!items.length) return;
  items.forEach(e => {
    session.addWorkspaceRef({ path: e.path, name: e.name, type: e.type, size: e.size });
  });
  ui.toast(`已引用 ${items.length} 个工作区项`, { tone: 'success' });
}

async function batchOpenFiles() {
  const files = selectedFiles.value.slice(0, 8);
  for (const f of files) {
    await ws.openFile(f.path);
  }
}

function batchDownload() {
  const files = selectedFiles.value;
  files.forEach((f, idx) => {
    setTimeout(() => triggerDownload(f.path), idx * 140);
  });
}

function batchCopyNames() {
  const text = selectedEntries.value.map(e => '/workspace/' + e.path).join('\n');
  navigator.clipboard?.writeText(text).then(() => ui.toast(`已复制 ${selectedEntries.value.length} 个路径`, { tone: 'success' }));
}

async function batchDelete() {
  const items = selectedEntries.value;
  if (!items.length) return;
  const names = items.slice(0, 4).map(e => e.name).join('、') + (items.length > 4 ? ` 等 ${items.length} 项` : '');
  const ok = await ui.confirm({
    title: `批量删除 ${items.length} 项`,
    message: `确定删除“${names}”？文件夹及其所有内容都会被删除。此操作不可撤销。`,
    confirmText: '全部删除',
    danger: true,
  });
  if (!ok) return;
  const { deleted, failed } = await ws.deleteEntries(items.map(e => e.path));
  selectedPaths.value = failed.map(f => f.path);
  if (failed.length) {
    ui.toast(`已删除 ${deleted.length} 项，${failed.length} 项失败（${failed[0].error}）`, { tone: 'error' });
  } else {
    ui.toast(`已删除 ${deleted.length} 项`, { tone: 'success' });
  }
}

function openAddMenu() {
  const prefix = ws.path ? ws.path + '/' : '';
  addMenu.value = [
    {
      icon: 'file',
      label: '新建文件',
      action: async () => {
        const p = await ui.prompt({ title: '新建文件', message: '输入相对于 /workspace 的文件路径', defaultValue: prefix + 'untitled.txt', placeholder: '例如 notes.md 或 src/app.py', confirmText: '创建' });
        if (!p?.trim()) return;
        try { await ws.createFile(p.trim()); ui.toast('已创建文件', { tone: 'success' }); }
        catch (err: any) { ui.toast(err.message, { tone: 'error' }); }
      },
    },
    {
      icon: 'folder',
      label: '新建文件夹',
      action: async () => {
        const p = await ui.prompt({ title: '新建文件夹', message: '输入相对于 /workspace 的文件夹路径', defaultValue: prefix + 'new-folder', placeholder: '例如 docs 或 src/utils', confirmText: '创建' });
        if (!p?.trim()) return;
        try { await ws.createDir(p.trim()); ui.toast('已创建文件夹', { tone: 'success' }); }
        catch (err: any) { ui.toast(err.message, { tone: 'error' }); }
      },
    },
    {
      icon: 'upload',
      label: '上传文件…',
      action: () => fileInput.value?.click(),
    },
  ];
}

function fileContext(ev: MouseEvent, e: any) {
  if (selectedSet.value.has(e.path) && selectedEntries.value.length > 1) {
    const count = selectedEntries.value.length;
    const fCount = selectedFiles.value.length;
    ui.openContext(ev, [
      { header: `已选中 ${count} 项` },
      { icon: 'corner-down-left', label: `引用 ${count} 个路径到对话`, action: batchInsertPaths },
      fCount > 0 ? { icon: 'file', label: `在标签页打开 (${Math.min(fCount, 8)})`, action: batchOpenFiles } : null,
      fCount > 0 ? { icon: 'download', label: `批量下载文件 (${fCount})`, action: batchDownload } : null,
      { icon: 'copy', label: '复制全部路径', action: batchCopyNames },
      { icon: 'trash', label: `批量删除 (${count})`, danger: true, action: batchDelete },
      { icon: 'x', label: '取消多选', action: () => { selectedPaths.value = []; } },
    ]);
    return;
  }

  if (selectedPaths.value.length > 0 && !selectedSet.value.has(e.path)) {
    selectedPaths.value = [e.path];
    lastAnchorPath.value = e.path;
  }

  const isFile = e.type !== 'dir';
  ui.openContext(ev, [
    { header: e.name },
    e.type === 'dir'
      ? { icon: 'folder-open', label: '打开文件夹', action: () => ws.navigate(e.path) }
      : { icon: 'file', label: '打开标签页', action: () => ws.openFile(e.path) },
    isFile ? { icon: 'edit', label: '编辑文本', action: () => ws.openFile(e.path, true) } : null,
    { icon: 'corner-down-left', label: '引用路径到对话', action: () => insertPath(e.path) },
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
      label: e.type === 'dir' ? '删除文件夹' : '删除文件',
      danger: true,
      action: async () => {
        if (!(await ui.confirm({ title: e.type === 'dir' ? '删除文件夹' : '删除文件', message: `确定删除“${e.name}”？文件夹及其所有内容都会被删除。此操作不可撤销。`, confirmText: '删除', danger: true }))) return;
        try { await ws.deleteEntry(e.path); ui.toast('已删除', { tone: 'success' }); }
        catch (err: any) { ui.toast(err.message, { tone: 'error' }); }
      },
    },
  ]);
}

function onListContext(ev: MouseEvent) {
  if ((ev.target as HTMLElement | null)?.closest('.file-row, .ws-batch-bar')) return;
  const prefix = ws.path ? ws.path + '/' : '';
  ui.openContext(ev, [
    { header: '/workspace' + (ws.path ? '/' + ws.path : '') },
    ws.entries.length ? { icon: 'check', label: `全选 (${ws.entries.length})`, action: selectAllEntries } : null,
    selectedEntries.value.length > 0 ? { icon: 'x', label: '取消选择', action: () => { selectedPaths.value = []; } } : null,
    {
      icon: 'file',
      label: '新建文件…',
      action: async () => {
        const p = await ui.prompt({ title: '新建文件', message: '输入相对于 /workspace 的文件路径', defaultValue: prefix + 'untitled.txt', confirmText: '创建' });
        if (p?.trim()) await ws.createFile(p.trim());
      },
    },
    {
      icon: 'folder',
      label: '新建文件夹…',
      action: async () => {
        const p = await ui.prompt({ title: '新建文件夹', message: '输入相对于 /workspace 的文件夹路径', defaultValue: prefix + 'new-folder', confirmText: '创建' });
        if (p?.trim()) await ws.createDir(p.trim());
      },
    },
    { icon: 'refresh', label: '刷新目录', action: () => ws.load(ws.path, true) },
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
  if (file.size > 15 * 1024 * 1024) {
    ui.toast('上传文件不能超过 15 MiB', { tone: 'error' });
    return;
  }
  try {
    const folder = ws.path;
    const content = await fileToBase64(file);
    const ok = await ws.upload(file.name, content, false, 'base64', folder);
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

function insertPath(e: any) {
  const p = typeof e === 'string' ? e : e?.path;
  const name = typeof e === 'object' && e?.name ? e.name : (String(p || '').split('/').pop() || p);
  const type = typeof e === 'object' ? e?.type : undefined;
  const size = typeof e === 'object' ? e?.size : undefined;
  session.addWorkspaceRef({ path: p, name, type, size });
  ui.toast(`已引用 ${name} 到输入框`, { tone: 'success' });
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
  <aside class="workspace" :class="{ 'is-dual': isDual }" aria-label="workspace">
    <div class="resize-handle resize-workspace" role="separator" aria-orientation="vertical" aria-label="调整工作区宽度" @pointerdown="startResize"></div>

    <!-- Separate rows keep the full path clear of toolbar controls. -->
    <header class="workspace-head">
      <span class="workspace-title">工作区</span>
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
        <nav ref="breadcrumbRef" class="breadcrumb" aria-label="当前路径" :title="'/workspace' + (ws.path ? '/' + ws.path : '')">
          <template v-for="(c, i) in crumbs" :key="c.path">
            <span v-if="i > 0" class="crumb-sep">/</span>
            <button
              type="button"
              class="crumb"
              :class="{ 'is-current': i === crumbs.length - 1 }"
              :title="'/workspace' + (c.path ? '/' + c.path : '')"
              :aria-current="i === crumbs.length - 1 ? 'location' : undefined"
              @click="ws.navigate(c.path)"
            >{{ c.label }}</button>
          </template>
        </nav>
      </div>

      <div class="workspace-actions">
        <button
          type="button"
          class="icon-button small"
          :class="{ 'is-on': isTerminalActive }"
          aria-label="打开沙箱 Linux 终端"
          title="沙箱 Linux 终端"
          @click="toggleTerminal"
        >
          <Icon name="terminal" :size="15" />
        </button>
        <button
          type="button"
          class="icon-button small"
          :class="{ 'is-on': isBrowserActive }"
          aria-label="打开实时浏览器"
          title="实时浏览器（真实页面 + 实时画面与操控）"
          @click="toggleBrowser"
        >
          <Icon name="globe" :size="15" />
        </button>
        <button ref="addAnchor" type="button" class="icon-button small" aria-label="新建或上传" title="新建或上传" @click="openAddMenu">
          <Icon name="plus" :size="16" />
        </button>
        <button type="button" class="icon-button small" :class="{ 'is-on': ui.showHiddenFiles }"
          :aria-pressed="ui.showHiddenFiles" :aria-label="ui.showHiddenFiles ? '隐藏隐藏文件' : '显示隐藏文件'"
          :title="ui.showHiddenFiles ? '隐藏以点开头的文件和目录' : '显示隐藏文件（如 .git、.env）'" @click="ui.toggleHiddenFiles">
          <Icon :name="ui.showHiddenFiles ? 'eye' : 'eye-off'" :size="15" />
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
        <button type="button" class="icon-button small" aria-label="关闭 workspace" title="关闭 workspace" @click="closeWorkspace">
          <Icon name="x" :size="16" />
        </button>
      </div>
      <input ref="fileInput" type="file" hidden @change="onFilePicked">
    </header>

    <!-- Single-sidebar Tab Bar (shown when not in dual mode and (tabs exist or terminal active)) -->
    <div v-if="!isDual && (ws.tabs.length || isTerminalActive || isBrowserActive)" class="ws-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        class="ws-tab"
        :class="{ 'is-active': ws.activeTab === FILES_TAB }"
        :title="'浏览目录：' + currentFolderLabel"
        @click="ws.activeTab = FILES_TAB"
      >
        <Icon name="folder" :size="13" />
        <span>{{ currentFolderLabel }}</span>
      </button>
      <button
        type="button"
        role="tab"
        class="ws-tab ws-tab-terminal"
        :class="{ 'is-active': isTerminalActive }"
        title="Linux 终端"
        @click="openTerminalTab"
      >
        <Icon name="terminal" :size="13" />
        <span>终端</span>
      </button>
      <button
        type="button"
        role="tab"
        class="ws-tab ws-tab-browser"
        :class="{ 'is-active': isBrowserActive }"
        title="实时浏览器"
        @click="openBrowserTab"
      >
        <Icon name="globe" :size="13" />
        <span>浏览器</span>
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
      <!-- Explorer Pane (supports rubber-band marquee + Ctrl/Shift multi-select) -->
      <div
        v-show="isDual ? true : (!activeFileTab && !isTerminalActive && !isBrowserActive)"
        ref="fileListRef"
        tabindex="-1"
        class="file-list"
        :class="{ 'is-dragover': dragover, 'is-marquee-active': marquee.active }"
        @pointerdown="onListPointerDown"
        @keydown="onListKeydown"
        @contextmenu="onListContext"
        @dragover.prevent="dragover = true"
        @dragleave="dragover = false"
        @drop.prevent="onDrop"
      >
        <div v-if="ws.loading && !ws.entries.length" class="workspace-status">
          <span class="spinner"></span><span>正在读取…</span>
        </div>
        <p v-else-if="ws.error" class="list-empty">{{ ws.error }}</p>
        <p v-else-if="!ws.entries.length" class="list-empty">当前目录为空，可点击右上角 + 新建或拖拽文件上传。</p>

        <button
          v-for="e in ws.entries"
          :key="e.path"
          type="button"
          class="file-row"
          :class="{
            'is-multi': selectedSet.has(e.path),
            'is-selected': !selectedEntries.length && (activeFileTab?.path === e.path || (!activeFileTab && ws.selected === e.path)),
          }"
          :data-entry-path="e.path"
          :data-dir="e.type === 'dir' ? '' : undefined"
          :title="e.name"
          @click="ev => onRowClick(ev, e)"
          @contextmenu="ev => fileContext(ev, e)"
        >
          <span class="file-icon"><Icon :name="e.type === 'dir' ? 'folder' : e.type === 'symlink' ? 'link' : 'file'" :size="15" /></span>
          <span class="file-name">{{ e.name }}</span>
          <span class="file-trailing">
            <span v-if="e.type !== 'dir'" class="file-size">{{ formatBytes(e.size) }}</span>
            <button
              type="button"
              class="file-quote-btn"
              :title="'引用 ' + e.name + ' 到对话'"
              :aria-label="'引用 ' + e.name + ' 到对话'"
              @click.stop="insertPath(e)"
            >
              <Icon name="corner-down-left" :size="12" />
            </button>
          </span>
        </button>

        <!-- Rubber-band marquee selection rectangle -->
        <div
          v-if="marquee.active"
          class="ws-marquee"
          :style="{
            left: marquee.x + 'px',
            top: marquee.y + 'px',
            width: marquee.w + 'px',
            height: marquee.h + 'px',
          }"
          aria-hidden="true"
        ></div>

        <!-- Sticky multi-select batch action bar -->
        <div v-if="selectedEntries.length > 0" class="ws-batch-bar" @pointerdown.stop>
          <span class="ws-batch-count">已选 {{ selectedEntries.length }} 项</span>
          <div class="ws-batch-actions">
            <button type="button" class="ws-batch-btn" title="引用选中路径到对话" @click="batchInsertPaths">
              <Icon name="corner-down-left" :size="13" /><span>引用</span>
            </button>
            <button v-if="selectedFiles.length > 0" type="button" class="ws-batch-btn" title="在标签页中打开" @click="batchOpenFiles">
              <Icon name="file" :size="13" /><span>打开</span>
            </button>
            <button type="button" class="ws-batch-btn is-danger" title="批量删除 (Delete)" @click="batchDelete">
              <Icon name="trash" :size="13" /><span>删除</span>
            </button>
            <button type="button" class="ws-batch-clear" title="取消选择 (Esc)" aria-label="取消选择" @click="selectedPaths = []">
              <Icon name="x" :size="13" />
            </button>
          </div>
        </div>
      </div>

      <!-- Terminal Pane: a real PTY inside the sandbox -->
      <section v-show="isTerminalActive" class="ws-terminal-pane">
        <header class="ws-term-bar">
          <div class="ws-term-meta">
            <span class="ws-term-title"><Icon name="terminal" :size="13" /> 终端</span>
            <span class="ws-term-project">/workspace/{{ session.currentProjectId || 'default' }}</span>
          </div>
          <div class="ws-term-tools">
            <button
              type="button"
              class="icon-button mini"
              title="清屏"
              aria-label="清屏"
              @click="termRef?.clear()"
            >
              <Icon name="trash" :size="13" />
            </button>
            <button
              type="button"
              class="icon-button mini"
              title="重新连接"
              aria-label="重新连接"
              @click="termRef?.reconnect()"
            >
              <Icon name="refresh" :size="13" />
            </button>
          </div>
        </header>
        <TerminalPane v-if="terminalEverOpened" ref="termRef" />
      </section>

      <!-- Live Browser Pane: a real Chromium page, streamed as frames -->
      <section v-show="isBrowserActive" class="ws-browser-pane">
        <BrowserPane v-if="browserEverOpened" ref="browserRef" />
      </section>

      <!-- File Viewer / Editor Pane -->
      <section v-if="!isTerminalActive && !isBrowserActive && (isDual || activeFileTab)" class="ws-viewer">
        <!-- In dual mode, file tabs sit across the top of the right column -->
        <div v-if="isDual && (ws.tabs.length || isTerminalActive)" class="ws-tabs ws-tabs-dual" role="tablist">
          <button
            type="button"
            role="tab"
            class="ws-tab ws-tab-terminal"
            :class="{ 'is-active': isTerminalActive }"
            title="Linux 终端"
            @click="openTerminalTab"
          >
            <Icon name="terminal" :size="13" />
            <span>终端</span>
          </button>
          <div
            v-for="t in ws.tabs"
            :key="t.path"
            role="tab"
            class="ws-tab"
            :class="{ 'is-active': !isTerminalActive && activeFileTab?.path === t.path }"
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
              <template v-if="!activeFileTab.binary && !activeFileTab.isImage && !activeFileTab.truncated && !activeFileTab.loading">
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
                <template v-else>
                  <button
                    v-if="renderableKind(activeFileTab.name)"
                    type="button"
                    class="viewer-pill"
                    :title="renderedKind ? '查看源码' : '查看渲染预览'"
                    @click="toggleMdMode(activeFileTab.path)"
                  >
                    <span>{{ renderedKind ? '源码' : '预览' }}</span>
                  </button>
                  <button type="button" class="viewer-pill" @click="activeFileTab.editing = true">
                    <Icon name="edit" :size="12" /><span>编辑</span>
                  </button>
                </template>
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
          <textarea style="resize: none"
            v-else-if="activeFileTab.editing"
            v-model="activeFileTab.draft"
            class="ws-editor"
            spellcheck="false"
            aria-label="编辑文件内容"
            @keydown="onEditorKeydown"
          ></textarea>
          <div v-else-if="activeFileTab.isImage" class="preview-image-stage">
            <div
              class="preview-image-box"
              title="点击全屏查看"
              @click="ui.openLightbox({ url: activeFileTab.imageUrl || '', name: activeFileTab.name, size: activeFileTab.size })"
            >
              <img :src="activeFileTab.imageUrl" :alt="activeFileTab.name" class="preview-image-el" />
              <div class="preview-image-hint">
                <Icon name="zoom-in" :size="13" />
                <span>点击全屏放大</span>
              </div>
            </div>
          </div>
          <div v-else-if="showRenderedMd" class="preview-markdown">
            <MarkdownView :source="activeFileTab.text" :sources="true" />
          </div>
          <iframe v-else-if="renderedKind === 'html'" class="preview-frame" :src="htmlPreviewUrl" sandbox="allow-scripts" :title="activeFileTab.name + ' 预览'"></iframe>
          <div v-else-if="renderedKind === 'csv'" class="preview-csv">
            <table>
              <thead v-if="csvRows.length"><tr><th v-for="(h, i) in csvRows[0]" :key="i">{{ h }}</th></tr></thead>
              <tbody><tr v-for="(r, ri) in csvRows.slice(1)" :key="ri"><td v-for="(c, ci) in r" :key="ci">{{ c }}</td></tr></tbody>
            </table>
            <p v-if="csvRows.length >= 1000" class="preview-note">仅显示前 1000 行。</p>
          </div>
          <iframe v-else-if="activeFileTab.embed === 'pdf'" class="preview-frame" :src="activeFileTab.embedUrl" :title="activeFileTab.name"></iframe>
          <div v-else-if="activeFileTab.embed === 'video'" class="preview-media"><video :src="activeFileTab.embedUrl" controls preload="metadata"></video></div>
          <div v-else-if="activeFileTab.embed === 'audio'" class="preview-media is-audio"><Icon name="file" :size="28" /><audio :src="activeFileTab.embedUrl" controls preload="metadata"></audio></div>
          <pre v-else-if="!activeFileTab.binary" class="preview-body"><code ref="codeRef"></code></pre>
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

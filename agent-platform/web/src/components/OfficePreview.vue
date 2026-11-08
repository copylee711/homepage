<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { getCsrf } from '../services/api';
import { useSession } from '../stores/session';
import { useUi } from '../stores/ui';
import type { OpenFileTab } from '../stores/workspace';
import { officeFormat, type OfficeElementInfo } from '../services/office/shared';
import { renderDocx } from '../services/office/docx';
import { parseXlsx, renderSheet, type Workbook } from '../services/office/xlsx';
import { parsePptx, renderPptxSlide, type PptxDeck } from '../services/office/pptx';

// Office files render in the pane and every paragraph, cell and shape is
// clickable: a click pins it and hands its text to the composer as a quote, so
// the agent knows exactly which element the request is about.
const props = defineProps<{ tab: OpenFileTab; fullscreen?: boolean; standalone?: boolean }>();
const emit = defineEmits<{ (event: 'toggle-fullscreen'): void }>();
const session = useSession();
const ui = useUi();

const host = ref<HTMLElement | null>(null);
const stage = ref<HTMLElement | null>(null);
const phase = ref<'loading' | 'ready' | 'error'>('loading');
const error = ref('');
const notes = ref<string[]>([]);
const pages = ref(0);
const selected = ref<OfficeElementInfo[]>([]);
// A drag-select inside one element quotes just that run of text, the way a
// reader would point at a sentence instead of the whole paragraph.
const textPick = ref<{ text: string; label: string } | null>(null);
const selectedIds = new Set<string>();
const book = ref<Workbook | null>(null);
const deck = ref<PptxDeck | null>(null);
const sheetIndex = ref(0);
const slideIndex = ref(0);
const zoom = ref(0); // 0 = fit to width
const refreshing = ref(false);
const updated = ref(false);
const agentNote = ref<{ note: string; at: number } | null>(null);
const editing = ref(false);
const editDraft = ref('');
const savingEdit = ref(false);
const restoreAvailable = ref(false);

const format = computed(() => officeFormat(props.tab.name));
let elementIndex = new Map<string, OfficeElementInfo>();
let naturalWidth = 0;
let loadToken = 0;
let observer: ResizeObserver | null = null;
let lastStamp = '';
let hovered: HTMLElement | null = null;
let downPoint: { x: number; y: number } | null = null;
let dragged = false;
let anchorId = '';

const selectionKind = computed(() => {
  if (textPick.value) return '选中文字';
  return selected.value.length > 1 ? `已选 ${selected.value.length} 项` : (selected.value[0]?.kind || '');
});
const selectionLabel = computed(() => {
  if (textPick.value) return `${textPick.value.label} · 选中 ${textPick.value.text.length} 字`;
  const labels = selected.value.map(item => item.label);
  if (labels.length <= 3) return labels.join('、');
  return labels.slice(0, 3).join('、') + ` 等 ${labels.length} 项`;
});
const selectionText = computed(() => {
  if (textPick.value) return textPick.value.text;
  return selected.value.map(item => item.text || `（${item.label} 无文字内容）`).join('\n\n');
});
const selectionDetail = computed(() => {
  if (textPick.value) return '仅引用拖选中的文字';
  if (selected.value.length > 1) return 'Shift 连选 · Ctrl / ⌘ 增减';
  return selected.value[0]?.detail || '';
});
const hasSelection = computed(() => !!textPick.value || selected.value.length > 0);

function fileUrl() {
  return `/api/files/download?path=${encodeURIComponent(props.tab.path)}&inline=1&t=${Date.now()}`;
}

function paintSelection() {
  const element = host.value;
  if (!element) return;
  element.querySelectorAll('[data-iris-selected]').forEach(node => node.removeAttribute('data-iris-selected'));
  for (const id of selectedIds) {
    element.querySelector(`[data-iris-el="${CSS.escape(id)}"]`)?.setAttribute('data-iris-selected', '');
  }
}

function clearSelection() {
  hovered?.removeAttribute('data-iris-hover');
  hovered = null;
  editing.value = false;
  editDraft.value = '';
  selectedIds.clear();
  selected.value = [];
  textPick.value = null;
  anchorId = '';
  paintSelection();
  window.getSelection()?.removeAllRanges();
}

/** Click selects one; Shift extends from the anchor; Ctrl/⌘ toggles one. */
function selectNode(node: HTMLElement | null, additive = false, range = false) {
  const id = node?.dataset.irisEl || '';
  if (!id) { if (!additive) clearSelection(); return; }
  textPick.value = null;
  if (range && anchorId && anchorId !== id) {
    const nodes = Array.from(host.value?.querySelectorAll('[data-iris-el]') || []) as HTMLElement[];
    const from = nodes.findIndex(item => item.dataset.irisEl === anchorId);
    const to = nodes.findIndex(item => item.dataset.irisEl === id);
    if (from >= 0 && to >= 0) {
      selectedIds.clear();
      for (let at = Math.min(from, to); at <= Math.max(from, to); at += 1) {
        const key = nodes[at].dataset.irisEl;
        if (key) selectedIds.add(key);
      }
      selected.value = [...selectedIds].map(key => elementIndex.get(key) || { id: key, label: key, kind: '元素', text: '' });
      editing.value = false;
      editDraft.value = '';
      paintSelection();
      queueFeedback();
      return;
    }
  }
  if (additive) {
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
  } else {
    selectedIds.clear();
    selectedIds.add(id);
    anchorId = id;
  }
  if (selectedIds.has(id) && !additive) anchorId = id;
  selected.value = [...selectedIds].map(key => elementIndex.get(key) || { id: key, label: key, kind: '元素', text: '' });
  editing.value = false;
  editDraft.value = '';
  paintSelection();
  queueFeedback();
}

/** The one element a reader can edit in place, or null for a multi-selection. */
const editable = computed(() => {
  if (textPick.value || selected.value.length !== 1) return null;
  return selected.value[0]?.edit ? selected.value[0] : null;
});

function startEdit() {
  const element = editable.value;
  if (!element) return;
  editing.value = true;
  editDraft.value = element.value ?? element.text ?? '';
  void nextTick(() => {
    const box = document.querySelector('.op-edit-input') as HTMLTextAreaElement | null;
    box?.focus();
    box?.select();
  });
}

async function saveEdit() {
  const element = editable.value;
  if (!element?.edit || savingEdit.value) return;
  savingEdit.value = true;
  try {
    const response = await fetch('/api/office/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrf() },
      body: JSON.stringify({ path: props.tab.path, target: element.edit, value: editDraft.value, anchor: element.label }),
      credentials: 'same-origin',
      redirect: 'error',
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value?.error || '无法保存这个修改');
    editing.value = false;
    ui.toast('已保存修改，Agent 会在下一轮看到', { tone: 'success' });
  } catch (error: any) {
    ui.toast(error?.message || '无法保存这个修改', { tone: 'error' });
  } finally {
    savingEdit.value = false;
  }
}

function nodeFrom(target: EventTarget | null) {
  if (!(target instanceof Element)) return null;
  return target.closest('[data-iris-el]') as HTMLElement | null;
}

function onPointerMove(event: PointerEvent) {
  const node = nodeFrom(event.target);
  if (node === hovered) return;
  hovered?.removeAttribute('data-iris-hover');
  hovered = node;
  node?.setAttribute('data-iris-hover', '');
}

function onPointerLeave() {
  hovered?.removeAttribute('data-iris-hover');
  hovered = null;
}

function onPointerDown(event: PointerEvent) {
  downPoint = { x: event.clientX, y: event.clientY };
  dragged = false;
}

function onPointerUp(event: PointerEvent) {
  if (downPoint && Math.hypot(event.clientX - downPoint.x, event.clientY - downPoint.y) > 5) {
    dragged = true;
    window.setTimeout(() => { dragged = false; }, 380);
  }
  downPoint = null;
  if (!dragged) return;
  const choice = window.getSelection();
  if (!choice || choice.isCollapsed || !choice.rangeCount) return;
  const range = choice.getRangeAt(0);
  const element = host.value;
  if (!element || !element.contains(range.commonAncestorContainer)) return;
  const text = choice.toString().replace(/[ \t]+/g, ' ').trim();
  if (!text) return;
  const holder = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
    ? range.commonAncestorContainer as Element
    : range.commonAncestorContainer.parentElement;
  const node = holder?.closest('[data-iris-el]');
  const id = (node as HTMLElement | null)?.dataset.irisEl || '';
  textPick.value = { text: text.slice(0, 4000), label: elementIndex.get(id)?.label || '选中文字' };
  selectedIds.clear();
  selected.value = [];
  paintSelection();
  queueFeedback();
}

function onClick(event: MouseEvent) {
  event.preventDefault();
  if (dragged) { dragged = false; return; }
  const node = nodeFrom(event.target);
  selectNode(node, event.ctrlKey || event.metaKey, event.shiftKey);
}

function quote() {
  const label = selectionLabel.value;
  const text = selectionText.value;
  if (!label || !text) return;
  sendFeedback('quote');
  if (props.standalone) {
    // A detached window hands the quote back to the console that opened it.
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage({ type: 'iris:quote', text, label, path: props.tab.path }, location.origin);
      ui.toast('已引用到主窗口的输入框', { tone: 'success' });
    } else {
      void navigator.clipboard?.writeText(text)
        .then(() => ui.toast('已复制选中内容', { tone: 'success' }))
        .catch(() => ui.toast('无法复制，请手动选择文字', { tone: 'error' }));
    }
    return;
  }
  session.addTextQuote(text, label, { path: props.tab.path, anchor: label });
  ui.toast(`已引用 ${label} 到输入框`, { tone: 'success' });
}

async function restorePrevious() {
  const ok = await ui.confirm({
    title: '回到上一版',
    message: '用这份文档上一个版本覆盖当前内容。Agent 对文件的改动会丢失，你的手工修改也会回到上一版。',
    confirmText: '回到上一版',
    danger: true,
  });
  if (!ok) return;
  try {
    const response = await fetch('/api/office/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrf() },
      body: JSON.stringify({ path: props.tab.path }),
      credentials: 'same-origin',
      redirect: 'error',
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value?.error || '无法回到上一版');
    restoreAvailable.value = false;
    ui.toast('已回到上一版', { tone: 'success' });
  } catch (error: any) {
    ui.toast(error?.message || '无法回到上一版', { tone: 'error' });
  }
}

function openWindow() {
  const name = 'iris-preview-' + props.tab.path.replace(/[^A-Za-z0-9]+/g, '-').slice(-40);
  const url = '/?preview=1&path=' + encodeURIComponent(props.tab.path);
  window.open(url, name, 'width=1100,height=840');
}

function fitZoom() {
  const element = host.value;
  if (!element) return 1;
  const factor = zoom.value || (naturalWidth ? Math.min(1.6, Math.max(0.35, ((stage.value?.clientWidth || 620) - 28) / naturalWidth)) : 1);
  element.style.zoom = String(factor);
  return factor;
}

function applyZoom() {
  if (format.value !== 'docx') return;
  fitZoom();
}

function zoomPercent() {
  if (format.value !== 'docx') return 100;
  const raw = host.value?.style.zoom;
  return Math.round(Number(raw || 1) * 100);
}

function stepZoom(delta: number) {
  const current = zoom.value || zoomPercent() / 100;
  zoom.value = Math.min(2, Math.max(0.4, Math.round((current + delta) * 20) / 20));
  applyZoom();
}

function resetZoom() {
  zoom.value = 0;
  applyZoom();
}

function showNotes(info: { notes?: string[] }) {
  notes.value = (info.notes || []).filter(Boolean);
}

function applyResult(info: { elements: Map<string, OfficeElementInfo>; pages: number; notes?: string[] }) {
  elementIndex = info.elements;
  pages.value = info.pages;
  showNotes(info);
  clearSelection();
}

async function measureDocx() {
  const element = host.value;
  if (!element) return;
  element.style.zoom = '1';
  await nextTick();
  const page = element.querySelector('section.iris-docx') as HTMLElement | null;
  naturalWidth = page?.offsetWidth || 0;
}

async function drawDocx(buffer: ArrayBuffer, token: number) {
  const element = host.value;
  if (!element) return;
  element.replaceChildren();
  const info = await renderDocx(buffer, element);
  if (token !== loadToken) return;
  applyResult(info);
  await measureDocx();
  if (token !== loadToken) return;
  applyZoom();
}

async function drawXlsx(buffer: ArrayBuffer, token: number) {
  const element = host.value;
  if (!element) return;
  const parsed = await parseXlsx(buffer);
  if (token !== loadToken) return;
  book.value = parsed;
  sheetIndex.value = Math.min(sheetIndex.value, parsed.sheets.length - 1);
  const info = renderSheet(element, parsed, sheetIndex.value);
  applyResult(info);
}

async function drawPptx(buffer: ArrayBuffer, token: number) {
  const element = host.value;
  if (!element) return;
  deck.value?.revoke();
  const parsed = await parsePptx(buffer);
  if (token !== loadToken) { parsed.revoke(); return; }
  deck.value = parsed;
  slideIndex.value = Math.min(slideIndex.value, parsed.slides.length - 1);
  drawSlide();
}

function drawSlide() {
  const element = host.value;
  if (!element || !deck.value) return;
  const info = renderPptxSlide(element, deck.value, slideIndex.value);
  elementIndex = info.elements;
  pages.value = info.pages;
  showNotes(info);
  if (selectedIds.size && ![...selectedIds].every(id => elementIndex.has(id))) clearSelection();
}

async function load(preserve = true) {
  if (phase.value === 'loading' && !refreshing.value && loadToken > 0) return;
  const token = ++loadToken;
  const element = host.value;
  if (!element) return;
  const previousScroll = stage.value?.scrollTop || 0;
  const keepSheet = sheetIndex.value;
  const keepSlide = slideIndex.value;
  refreshing.value = true;
  error.value = '';
  if (!preserve) phase.value = 'loading';
  try {
    const response = await fetch(fileUrl(), { credentials: 'same-origin', redirect: 'error' });
    if (!response.ok) {
      throw new Error(response.status === 404 ? '文件不存在或无权访问' : '无法读取这个文件');
    }
    const buffer = await response.arrayBuffer();
    if (token !== loadToken) return;
    if (!naturalWidth) await nextTick();
    if (format.value === 'docx') await drawDocx(buffer, token);
    else if (format.value === 'xlsx') { sheetIndex.value = keepSheet; await drawXlsx(buffer, token); }
    else { slideIndex.value = keepSlide; await drawPptx(buffer, token); }
    if (token !== loadToken) return;
    phase.value = 'ready';
    if (preserve && previousScroll) {
      await nextTick();
      if (stage.value) stage.value.scrollTop = previousScroll;
    }
    updated.value = preserve && phase.value === 'ready';
    if (updated.value) window.setTimeout(() => { updated.value = false; }, 1600);
  } catch (err: any) {
    if (token !== loadToken) return;
    phase.value = 'error';
    error.value = err?.message || '无法预览这个文件';
  } finally {
    if (token === loadToken) refreshing.value = false;
  }
}

function pickSheet(index: number) {
  if (!book.value || index === sheetIndex.value) return;
  sheetIndex.value = index;
  const element = host.value;
  if (!element) return;
  const info = renderSheet(element, book.value, index);
  elementIndex = info.elements;
  pages.value = info.pages;
  showNotes(info);
  clearSelection();
}

function moveSlide(delta: number) {
  if (!deck.value) return;
  const next = Math.min(deck.value.slides.length - 1, Math.max(0, slideIndex.value + delta));
  if (next === slideIndex.value) return;
  slideIndex.value = next;
  clearSelection();
  drawSlide();
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { if (hasSelection.value) { event.stopPropagation(); clearSelection(); } return; }
  if (format.value !== 'pptx') return;
  if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); moveSlide(-1); }
  if (event.key === 'ArrowRight' || event.key === 'PageDown') { event.preventDefault(); moveSlide(1); }
}

// ---- live preview channel ------------------------------------------------
// The preview server watches the document and the agent's control file; this
// reader turns those events into a reload, a scroll-to-element, or a note.
let streamAbort: AbortController | null = null;
let watchGeneration = 0;
let running = true;
let feedbackTimer: number | null = null;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function stampOf(file: any) {
  return Array.isArray(file) ? `${file[0]}:${file[1]}` : 'missing';
}

function findElementByAnchor(anchor: string) {
  if (!anchor) return null;
  for (const [id, info] of elementIndex) if (info.label === anchor) return id;
  for (const [id, info] of elementIndex) if (info.label && anchor.startsWith(info.label)) return id;
  return null;
}

function applyControl(control: any) {
  if (!control || typeof control !== 'object') return;
  const file = typeof control.file === 'string' ? control.file.replace(/^\/?workspace\/?/, '').replace(/^\/+/, '') : '';
  if (file && file !== props.tab.path) return;
  const anchors: string[] = Array.isArray(control.anchors)
    ? control.anchors.filter((item: any) => typeof item === 'string').slice(0, 8)
    : typeof control.anchor === 'string' ? [control.anchor] : [];
  const note = typeof control.note === 'string' ? control.note.slice(0, 400) : '';
  if (note) {
    const at = Date.now();
    agentNote.value = { note, at };
    window.setTimeout(() => { if (agentNote.value?.at === at) agentNote.value = null; }, 12000);
  }
  const element = host.value;
  if (!element || !anchors.length) return;
  element.querySelectorAll('[data-iris-agent]').forEach(node => node.removeAttribute('data-iris-agent'));
  let first: HTMLElement | null = null;
  for (const anchor of anchors) {
    const id = findElementByAnchor(anchor);
    if (!id) continue;
    const target = element.querySelector(`[data-iris-el="${CSS.escape(id)}"]`) as HTMLElement | null;
    if (!target) continue;
    target.setAttribute('data-iris-agent', '');
    if (!first) first = target;
  }
  if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
  window.setTimeout(() => element.querySelectorAll('[data-iris-agent]').forEach(node => node.removeAttribute('data-iris-agent')), 4200);
}

function handleWatchEvent(event: any) {
  if (!event || typeof event !== 'object') return;
  if (event.type === 'hello') {
    restoreAvailable.value = event.restore === true;
    const stamp = stampOf(event.file);
    const moved = lastStamp && stamp !== lastStamp;
    lastStamp = stamp;
    if (moved && phase.value === 'ready' && !refreshing.value) void load(true);
    if (event.control) applyControl(event.control);
    return;
  }
  if (event.type === 'changed') {
    restoreAvailable.value = event.restore === true;
    const stamp = stampOf(event.file);
    if (stamp === lastStamp) return;
    lastStamp = stamp;
    if (phase.value === 'ready' && !refreshing.value) void load(true);
    return;
  }
  if (event.type === 'agent') applyControl(event.control);
}

async function watchStream(gen: number) {
  while (running && gen === watchGeneration) {
    if (document.hidden) { await wait(600); continue; }
    try {
      streamAbort = new AbortController();
      const response = await fetch('/api/office/watch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrf() },
        body: JSON.stringify({ path: props.tab.path }),
        signal: streamAbort.signal,
        credentials: 'same-origin',
        redirect: 'error',
      });
      if (!response.ok || !response.body) throw new Error('preview stream unavailable');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (running && gen === watchGeneration) {
        const { done, value } = await reader.read();
        if (done) break;
        if (document.hidden) { streamAbort?.abort(); break; }
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          handleWatchEvent(event);
        }
      }
    } catch {
      // Dropped stream: the loop reconnects and the hello event reconciles.
    } finally {
      streamAbort = null;
    }
    await wait(900);
  }
}

/** Publish what the reader is looking at so the agent can see it too. */
function sendFeedback(kind: 'focus' | 'quote') {
  const anchor = selectionLabel.value;
  const text = selectionText.value;
  if (!anchor) return;
  void fetch('/api/office/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrf() },
    body: JSON.stringify({ path: props.tab.path, anchor, text: text.slice(0, 2000), kind }),
    credentials: 'same-origin',
    redirect: 'error',
  }).catch(() => {});
}

function queueFeedback() {
  if (feedbackTimer != null) clearTimeout(feedbackTimer);
  feedbackTimer = window.setTimeout(() => { feedbackTimer = null; sendFeedback('focus'); }, 300);
}

let stageWidth = 0;
function onResize() {
  if (phase.value !== 'ready' || !host.value) return;
  const width = stage.value?.clientWidth || 0;
  if (width === stageWidth) return;
  stageWidth = width;
  if (format.value === 'docx') applyZoom();
  else if (format.value === 'pptx') drawSlide();
}

function onVisibilityChange() {
  if (document.hidden) streamAbort?.abort();
}

watch(() => props.tab.path, () => {
  lastStamp = '';
  naturalWidth = 0;
  zoom.value = 0;
  sheetIndex.value = 0;
  slideIndex.value = 0;
  book.value = null;
  deck.value?.revoke();
  deck.value = null;
  agentNote.value = null;
  streamAbort?.abort();
  watchGeneration += 1;
  const gen = watchGeneration;
  running = true;
  void load(false);
  void watchStream(gen);
});

onMounted(() => {
  const element = host.value;
  if (!element) return;
  window.addEventListener('keydown', onKeydown);
  observer = new ResizeObserver(() => {
    if (!naturalWidth && format.value === 'docx') return;
    onResize();
  });
  if (stage.value) observer.observe(stage.value);
  document.addEventListener('visibilitychange', onVisibilityChange);
  void load(false);
  const gen = ++watchGeneration;
  running = true;
  void watchStream(gen);
});

onBeforeUnmount(() => {
  loadToken += 1;
  window.removeEventListener('keydown', onKeydown);
  observer?.disconnect();
  observer = null;
  running = false;
  watchGeneration += 1;
  streamAbort?.abort();
  if (feedbackTimer != null) clearTimeout(feedbackTimer);
  feedbackTimer = null;
  document.removeEventListener('visibilitychange', onVisibilityChange);
  deck.value?.revoke();
  deck.value = null;
});
</script>

<template>
  <div class="office-preview" :class="'is-' + format">
    <div class="op-toolbar">
      <div class="op-tools">
        <template v-if="format === 'docx'">
          <button type="button" class="op-btn op-icon" title="缩小" aria-label="缩小" @click="stepZoom(-0.1)">
            <Icon name="minus" :size="13" />
          </button>
          <button type="button" class="op-btn op-zoom" title="适应宽度" @click="resetZoom">{{ zoomPercent() }}%</button>
          <button type="button" class="op-btn op-icon" title="放大" aria-label="放大" @click="stepZoom(0.1)">
            <Icon name="plus" :size="13" />
          </button>
          <span class="op-sep"></span>
          <span class="op-meta">{{ pages }} 页</span>
        </template>
        <template v-else-if="format === 'pptx'">
          <button type="button" class="op-btn op-icon" title="上一张" aria-label="上一张" :disabled="slideIndex <= 0" @click="moveSlide(-1)">
            <Icon name="chevron-left" :size="14" />
          </button>
          <span class="op-meta op-counter">{{ slideIndex + 1 }} / {{ deck?.slides.length || pages }}</span>
          <button type="button" class="op-btn op-icon" title="下一张" aria-label="下一张" :disabled="!deck || slideIndex >= deck.slides.length - 1" @click="moveSlide(1)">
            <Icon name="chevron-right" :size="14" />
          </button>
        </template>
        <template v-else-if="format === 'xlsx' && book">
          <div class="op-sheets" role="tablist">
            <button
              v-for="(sheet, index) in book.sheets"
              :key="sheet.name"
              type="button"
              role="tab"
              class="op-sheet"
              :class="{ 'is-active': index === sheetIndex }"
              :aria-selected="index === sheetIndex"
              @click="pickSheet(index)"
            >{{ sheet.name }}</button>
          </div>
        </template>
      </div>
      <div class="op-tools op-tools-end">
        <span v-if="updated" class="op-updated"><span class="op-dot"></span>已更新</span>
        <span class="op-hint">点击元素即可引用给 Agent</span>
        <button
          v-if="restoreAvailable"
          type="button"
          class="op-btn"
          title="回到上一版（撤销这次对文件的改动）"
          @click="restorePrevious"
        >
          <Icon name="rotate-ccw" :size="12" /><span>回到上一版</span>
        </button>
        <button
          v-if="!standalone"
          type="button"
          class="op-btn op-icon"
          title="在独立窗口打开"
          aria-label="在独立窗口打开"
          @click="openWindow"
        >
          <Icon name="external-link" :size="13" />
        </button>
        <button
          type="button"
          class="op-btn op-icon"
          :class="{ 'is-on': fullscreen }"
          :title="fullscreen ? '退出全屏' : '全屏预览'"
          :aria-label="fullscreen ? '退出全屏' : '全屏预览'"
          @click="emit('toggle-fullscreen')"
        >
          <Icon :name="fullscreen ? 'minimize-2' : 'maximize-2'" :size="13" />
        </button>
        <button type="button" class="op-btn op-icon" :disabled="refreshing" title="重新载入" aria-label="重新载入" @click="load(true)">
          <Icon name="refresh" :size="13" />
        </button>
      </div>
    </div>

    <div v-if="agentNote" class="op-agent-note" role="status">
      <Icon name="sparkle" :size="12" />
      <span class="op-agent-text">{{ agentNote.note }}</span>
      <button type="button" class="op-agent-close" aria-label="关闭" title="关闭" @click="agentNote = null">
        <Icon name="x" :size="11" />
      </button>
    </div>
    <p v-for="note in notes" :key="note" class="op-note">{{ note }}</p>

    <div ref="stage" class="op-stage" :class="'is-' + format">
      <div
        ref="host"
        class="op-host"
        :class="'is-' + format"
        @click="onClick"
        @pointerdown="onPointerDown"
        @pointerup="onPointerUp"
        @pointermove="onPointerMove"
        @pointerleave="onPointerLeave"
      ></div>
      <div v-if="phase === 'loading'" class="op-status"><span class="spinner"></span>正在解析 {{ tab.name }}…</div>
      <div v-else-if="phase === 'error'" class="op-status is-error">
        <Icon name="alert-circle" :size="18" />
        <span>{{ error }}</span>
        <button type="button" class="op-btn" @click="load(false)">重试</button>
      </div>
    </div>

    <div v-if="hasSelection" class="op-selection" :class="{ 'is-editing': editing }">
      <div class="op-sel-body">
        <div class="op-sel-head">
          <span class="op-sel-kind">{{ editing ? '编辑' : selectionKind }}</span>
          <span class="op-sel-label">{{ selectionLabel }}</span>
          <span v-if="selectionDetail && !editing" class="op-sel-detail">{{ selectionDetail }}</span>
          <span v-else-if="editing" class="op-sel-detail">Ctrl / ⌘ + Enter 保存</span>
        </div>
        <textarea
          v-if="editing"
          v-model="editDraft"
          class="op-edit-input"
          rows="3"
          spellcheck="false"
          aria-label="编辑选中元素"
          @keydown.esc.stop="editing = false"
          @keydown.ctrl.enter.prevent="saveEdit"
          @keydown.meta.enter.prevent="saveEdit"
        ></textarea>
        <div v-else class="op-sel-text" :class="{ 'is-empty': !selectionText }">{{ selectionText || '（无文字内容）' }}</div>
      </div>
      <div class="op-sel-actions">
        <template v-if="editing">
          <button type="button" class="op-btn is-primary" :disabled="savingEdit" @click="saveEdit">{{ savingEdit ? '保存中…' : '保存' }}</button>
          <button type="button" class="op-btn" :disabled="savingEdit" @click="editing = false">取消</button>
        </template>
        <template v-else>
          <button v-if="editable" type="button" class="op-btn" title="直接修改这个元素，Agent 会看到" @click="startEdit">
            <Icon name="edit" :size="12" /><span>编辑</span>
          </button>
          <button type="button" class="op-btn is-primary" @click="quote">引用到对话</button>
          <button type="button" class="op-btn" @click="clearSelection">取消</button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.office-preview { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--surface); overflow: hidden; }
.op-toolbar { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 9px; border-bottom: 1px solid var(--line); background: var(--surface); }
.op-tools { min-width: 0; display: flex; align-items: center; gap: 4px; }
.op-tools-end { flex: none; justify-content: flex-end; }
.op-btn { height: 25px; display: inline-flex; align-items: center; justify-content: center; gap: 4px; padding: 0 9px; border: 1px solid var(--line-2); border-radius: 7px; background: var(--surface-2); color: var(--text-2); font-size: 11.5px; font-weight: 550; }
.op-btn:hover:not(:disabled) { border-color: var(--line-strong); color: var(--text); }
.op-btn:disabled { opacity: 0.4; }
.op-btn.is-primary { background: var(--ink); border-color: var(--ink); color: var(--surface); }
.op-btn.is-on { background: color-mix(in srgb, var(--text) 9%, transparent); border-color: var(--line-strong); color: var(--text); }
.op-icon { width: 25px; padding: 0; }
.op-zoom { min-width: 50px; font-variant-numeric: tabular-nums; }
.op-sep { width: 1px; height: 14px; margin: 0 3px; background: var(--line); }
.op-meta { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.op-counter { min-width: 52px; text-align: center; }
.op-hint { color: var(--faint); font-size: 11px; white-space: nowrap; }
.op-updated { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); font-size: 11px; }
.op-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px var(--accent-softer); }

.op-sheets { display: flex; align-items: center; gap: 2px; overflow-x: auto; scrollbar-width: thin; }
.op-sheet { flex: none; height: 25px; padding: 0 10px; border-radius: 7px; color: var(--muted); font-size: 11.5px; font-weight: 550; white-space: nowrap; }
.op-sheet:hover { background: color-mix(in srgb, var(--text) 6%, transparent); color: var(--text); }
.op-sheet.is-active { background: var(--surface-2); color: var(--text); box-shadow: inset 0 0 0 1px var(--line); }

.op-stage { flex: 1; min-height: 0; position: relative; overflow: auto; }
.op-stage.is-xlsx { overflow: hidden; }
.op-stage.is-pptx { display: flex; justify-content: center; align-items: flex-start; padding: 14px; background: var(--surface-2); }
.op-host { min-height: 0; }
.op-host.is-docx { padding: 14px 16px 26px; }
.op-host.is-xlsx { height: 100%; }
.op-host.is-pptx { width: 100%; display: flex; justify-content: center; }

.op-status { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 16px; color: var(--muted); font-size: 12.5px; background: color-mix(in srgb, var(--surface) 82%, transparent); }
.op-status.is-error { color: var(--danger, #b42318); flex-direction: column; text-align: center; }
.op-note { flex: none; margin: 0; padding: 6px 14px; color: var(--warn); background: var(--warn-soft); font-size: 11px; border-bottom: 1px solid var(--line); }
.op-agent-note { flex: none; display: flex; align-items: center; gap: 7px; padding: 6px 10px 6px 13px; border-bottom: 1px solid var(--line); background: var(--accent-softer); color: var(--accent-ink); font-size: 11.5px; }
.op-agent-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.op-agent-close { flex: none; width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center; border-radius: 5px; color: inherit; opacity: 0.7; }
.op-agent-close:hover { opacity: 1; background: color-mix(in srgb, var(--text) 8%, transparent); }

.op-selection { flex: none; display: flex; align-items: flex-end; gap: 10px; padding: 9px 12px 10px; border-top: 1px solid var(--line); background: var(--surface-2); }
.op-sel-body { flex: 1; min-width: 0; }
.op-sel-head { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
.op-sel-kind { flex: none; padding: 1px 6px; border-radius: 5px; background: var(--accent-softer); color: var(--accent-ink); font-size: 10.5px; font-weight: 620; }
.op-sel-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); font-size: 12px; font-weight: 560; }
.op-sel-detail { flex: none; color: var(--faint); font-size: 10.5px; }
.op-sel-text { margin-top: 4px; max-height: 58px; overflow: auto; color: var(--text-2); font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.op-sel-text.is-empty { color: var(--faint); font-style: italic; }
.op-selection.is-editing { align-items: stretch; }
.op-edit-input { width: 100%; margin-top: 5px; min-height: 54px; max-height: 140px; resize: vertical; padding: 7px 9px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface); color: var(--text); font-size: 12.5px; line-height: 1.5; font-family: inherit; }
.op-edit-input:focus { outline: 2px solid color-mix(in srgb, var(--accent) 40%, transparent); outline-offset: 0; border-color: var(--accent); }
.op-sel-actions { flex: none; display: flex; align-items: center; gap: 5px; }

/* Selection chrome inside rendered documents. */
.op-host :deep([data-iris-el]) { cursor: pointer; }
.op-host :deep([data-iris-hover]) { outline: 1.5px solid color-mix(in srgb, var(--accent) 42%, transparent); outline-offset: 1px; background: color-mix(in srgb, var(--accent) 5%, transparent); border-radius: 2px; }
.op-host :deep([data-iris-selected]) { outline: 2px solid var(--accent); outline-offset: 1px; background: color-mix(in srgb, var(--accent) 9%, transparent); border-radius: 2px; }
.op-host :deep([data-iris-agent]) { outline: 2px dashed color-mix(in srgb, var(--accent) 70%, transparent); outline-offset: 2px; background: color-mix(in srgb, var(--accent) 12%, transparent); border-radius: 2px; animation: op-agent-pulse 1.4s ease-in-out 2; }
@keyframes op-agent-pulse { 0%, 100% { background: color-mix(in srgb, var(--accent) 6%, transparent); } 50% { background: color-mix(in srgb, var(--accent) 18%, transparent); } }

/* DOCX */
.op-host.is-docx :deep(.iris-docx-wrapper) { margin: 0 auto; display: flex; flex-direction: column; align-items: center; gap: 16px; background: transparent; padding: 0; }
.op-host.is-docx :deep(section.iris-docx) { background: #fff; box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08), 0 6px 22px rgba(15, 23, 42, 0.08); border-radius: 3px; color: #1b1b1f; }
:global([data-theme='light']) .op-host.is-docx :deep(section.iris-docx) { box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06), 0 4px 16px rgba(15, 23, 42, 0.06); }

/* XLSX */
.op-host :deep(.ix-scroll) { height: 100%; overflow: auto; background: var(--surface); }
.op-host :deep(.ix-table) { border-collapse: separate; border-spacing: 0; table-layout: fixed; font-size: 12.5px; color: var(--text); font-family: var(--office-font, 'Segoe UI', system-ui, sans-serif); }
.op-host :deep(.ix-colhead), .op-host :deep(.ix-rownum) { position: sticky; top: 0; z-index: 2; height: 24px; padding: 0 6px; background: var(--surface-2); color: var(--muted); font-size: 10.5px; font-weight: 600; text-align: center; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.op-host :deep(.ix-rownum) { left: 0; top: auto; z-index: 3; width: 46px; min-width: 46px; }
.op-host :deep(thead th:first-child) { left: 0; z-index: 4; background: var(--surface-2); }
.op-host :deep(.ix-cell) { padding: 2px 6px; border-right: 1px solid color-mix(in srgb, var(--line) 70%, transparent); border-bottom: 1px solid color-mix(in srgb, var(--line) 70%, transparent); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; }
.op-host :deep(.ix-cell.is-number) { text-align: right; font-variant-numeric: tabular-nums; }
.op-host :deep(.ix-spacer td) { padding: 0; border: 0; }

/* PPTX */
.op-host :deep(.px-stage) { position: relative; width: 100%; display: flex; justify-content: center; }
.op-host :deep(.px-slide) { position: relative; flex: none; overflow: hidden; box-shadow: 0 1px 2px rgba(15, 23, 42, 0.1), 0 10px 30px rgba(15, 23, 42, 0.12); border-radius: 4px; font-family: var(--office-font, 'Segoe UI', system-ui, sans-serif); }
.op-host :deep(.px-shape) { position: absolute; overflow: hidden; }
.op-host :deep(.px-shape.is-image img) { width: 100%; height: 100%; object-fit: cover; display: block; }
.op-host :deep(.px-text) { width: 100%; height: 100%; display: flex; flex-direction: column; justify-content: flex-start; padding: 0.06em 0.1em; overflow: hidden; }
.op-host :deep(.px-para) { line-height: 1.32; color: #1f1f24; }
.op-host :deep(.px-bullet) { display: inline-block; width: 1.15em; color: inherit; }
.op-host :deep(.px-table) { width: 100%; border-collapse: collapse; font-size: 13px; color: #1f1f24; background: #fff; }
.op-host :deep(.px-table td) { border: 1px solid rgba(15, 23, 42, 0.16); padding: 3px 7px; vertical-align: middle; }
</style>

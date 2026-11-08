<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import Icon from './Icon.vue';
import { post } from '../services/api';
import { useSession } from '../stores/session';
import { useUi } from '../stores/ui';

// A real Chromium page inside the user's sandbox. The host relays JPEG frames
// and input events, so this pane is a live window onto a genuine browser: real
// TLS, real layout, real JavaScript, and nothing shared with this tab.
const session = useSession();
const ui = useUi();

const stage = ref<HTMLElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const addressEl = ref<HTMLInputElement | null>(null);

const phase = ref<'connecting' | 'open' | 'closed' | 'error'>('connecting');
const detail = ref('');
const address = ref('');
const pageTitle = ref('');
const canBack = ref(false);
const canForward = ref(false);
const loading = ref(false);
const hasFrame = ref(false);
const frameW = ref(1280);
const frameH = ref(800);
const saving = ref(false);

const SIZES = [
  { key: '1280x800', label: '桌面 1280 × 800', width: 1280, height: 800 },
  { key: '1440x900', label: '大屏 1440 × 900', width: 1440, height: 900 },
  { key: '1024x768', label: '紧凑 1024 × 768', width: 1024, height: 768 },
  { key: '390x844', label: '手机 390 × 844', width: 390, height: 844 },
];
const sizeKey = ref('1280x800');
const sizeMenu = ref(false);

let seq = 0;
let running = false;
let generation = 0;
let url = '';
let editing = false;
let visible = true;
let observer: IntersectionObserver | null = null;
let image: HTMLImageElement | null = null;
let pendingClick: number | null = null;
let wheelTimer: number | null = null;
let wheelDelta = { x: 0, y: 0 };
let lastMove = 0;
let lastMoveAt = { x: 0, y: 0 };

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function draw() {
  const target = canvas.value;
  if (!target || !image || !image.complete || !image.naturalWidth) return;
  if (target.width !== image.naturalWidth) target.width = image.naturalWidth;
  if (target.height !== image.naturalHeight) target.height = image.naturalHeight;
  const context = target.getContext('2d');
  if (!context) return;
  context.drawImage(image, 0, 0);
  hasFrame.value = true;
}

function applyFrame(frame: any) {
  if (!frame || !frame.data) return;
  frameW.value = Number(frame.width) || frameW.value;
  frameH.value = Number(frame.height) || frameH.value;
  if (typeof frame.url === 'string') {
    url = frame.url;
    if (!editing) address.value = frame.url === 'about:blank' ? '' : frame.url;
  }
  if (typeof frame.title === 'string') pageTitle.value = frame.title;
  canBack.value = frame.canBack === true;
  canForward.value = frame.canForward === true;
  loading.value = frame.loading === true;
  const next = new Image();
  next.onload = () => {
    image = next;
    draw();
  };
  const mime = typeof frame.mime === 'string' && /^image\/(jpeg|png)$/.test(frame.mime) ? frame.mime : 'image/jpeg';
  next.src = `data:${mime};base64,` + frame.data;
}

async function pump(gen: number) {
  while (running && gen === generation) {
    // A hidden pane or a background tab costs nothing: no polling means the
    // bridge stops capturing and the container drops to its idle cadence.
    if (!visible || document.hidden) {
      await wait(900);
      continue;
    }
    try {
      const result = await post('/api/browser/frame', { after: seq, wait: 6 });
      if (!running || gen !== generation) return;
      if (result.closed) {
        phase.value = 'closed';
        detail.value = result.error || '浏览器已关闭';
        return;
      }
      if (result.frame && Number(result.frame.seq) > seq) {
        seq = Number(result.frame.seq);
        applyFrame(result.frame);
      } else if (Number(result.seq) > seq) {
        seq = Number(result.seq);
      }
      if (phase.value !== 'open') phase.value = 'open';
    } catch (error: any) {
      if (!running || gen !== generation) return;
      phase.value = 'error';
      detail.value = error?.message || '浏览器连接中断';
      return;
    }
  }
}

async function open(): Promise<boolean> {
  const gen = ++generation;
  phase.value = 'connecting';
  detail.value = '';
  hasFrame.value = false;
  seq = 0;
  try {
    const size = SIZES.find(s => s.key === sizeKey.value) || SIZES[0];
    await post('/api/browser/open', { width: size.width, height: size.height });
    if (gen !== generation) return false;
    phase.value = 'open';
    running = true;
    void pump(gen);
    void nextTick(() => stage.value?.focus());
    return true;
  } catch (error: any) {
    phase.value = 'error';
    detail.value = error?.message || '无法打开浏览器';
    return false;
  }
}

async function reconnect() {
  running = false;
  generation += 1;
  await wait(30);
  await open();
}

function sendInput(payload: Record<string, unknown>) {
  void post('/api/browser/input', payload).catch(() => {});
}

function navigate(action: 'goto' | 'back' | 'forward' | 'reload') {
  if (action === 'goto') {
    const value = address.value.trim();
    if (!value) return;
    editing = false;
    addressEl.value?.blur();
    stage.value?.focus();
    void post('/api/browser/navigate', { action, url: value })
      .catch(error => { phase.value = phase.value === 'open' ? 'open' : phase.value; detail.value = error?.message || ''; });
    return;
  }
  void post('/api/browser/navigate', { action }).catch(() => {});
}

function changeSize(item: { key: string; width: number; height: number }) {
  sizeKey.value = item.key;
  sizeMenu.value = false;
  if (!running) return;
  void post('/api/browser/navigate', { action: 'resize', width: item.width, height: item.height }).catch(() => {});
  stage.value?.focus();
}

const sizeLabel = computed(() => (SIZES.find(s => s.key === sizeKey.value) || SIZES[0]).label);

function point(event: MouseEvent | WheelEvent) {
  const target = canvas.value;
  if (!target) return { x: 0, y: 0 };
  const rect = target.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * frameW.value;
  const y = ((event.clientY - rect.top) / Math.max(1, rect.height)) * frameH.value;
  return { x: Math.round(x), y: Math.round(y) };
}

function onClick(event: MouseEvent) {
  const { x, y } = point(event);
  if (pendingClick != null) clearTimeout(pendingClick);
  pendingClick = window.setTimeout(() => {
    pendingClick = null;
    sendInput({ kind: 'click', x, y });
  }, 210);
}

function onDoubleClick(event: MouseEvent) {
  if (pendingClick != null) { clearTimeout(pendingClick); pendingClick = null; }
  const { x, y } = point(event);
  sendInput({ kind: 'dblclick', x, y });
}

function onMove(event: MouseEvent) {
  const now = Date.now();
  if (now - lastMove < 130) return;
  const { x, y } = point(event);
  if (Math.abs(x - lastMoveAt.x) < 2 && Math.abs(y - lastMoveAt.y) < 2) return;
  lastMove = now;
  lastMoveAt = { x, y };
  sendInput({ kind: 'move', x, y });
}

function onWheel(event: WheelEvent) {
  event.preventDefault();
  const { x, y } = point(event);
  wheelDelta.x += event.deltaX;
  wheelDelta.y += event.deltaY;
  if (wheelTimer != null) return;
  wheelTimer = window.setTimeout(() => {
    wheelTimer = null;
    const dx = Math.round(wheelDelta.x), dy = Math.round(wheelDelta.y);
    wheelDelta = { x: 0, y: 0 };
    if (dx || dy) sendInput({ kind: 'wheel', x, y, dx, dy });
  }, 70);
}

const SPECIAL = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'F5', 'F11', 'F12']);

function modifiers(event: KeyboardEvent) {
  const list: string[] = [];
  if (event.ctrlKey) list.push('Control');
  if (event.shiftKey) list.push('Shift');
  if (event.altKey) list.push('Alt');
  if (event.metaKey) list.push('Meta');
  return list;
}

function onKeyDown(event: KeyboardEvent) {
  if (event.isComposing) return;
  const mods = modifiers(event);
  if ((event.metaKey || event.ctrlKey) && (event.key === 'l' || event.key === 'L')) {
    event.preventDefault();
    addressEl.value?.focus();
    addressEl.value?.select();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && (event.key === 'r' || event.key === 'R')) {
    event.preventDefault();
    navigate('reload');
    return;
  }
  if (event.key === 'F5') {
    event.preventDefault();
    navigate('reload');
    return;
  }
  if (SPECIAL.has(event.key)) {
    event.preventDefault();
    sendInput({ kind: 'key', key: event.key, modifiers: mods });
    return;
  }
  if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    sendInput({ kind: 'text', text: event.key });
  }
}

function onPaste(event: ClipboardEvent) {
  const text = event.clipboardData?.getData('text') || '';
  if (!text) return;
  event.preventDefault();
  sendInput({ kind: 'text', text: text.slice(0, 20000) });
}

function onAddressKey(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    event.preventDefault();
    navigate('goto');
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    editing = false;
    address.value = url === 'about:blank' ? '' : url;
    addressEl.value?.blur();
    stage.value?.focus();
  }
}

function onStagePointer() {
  if (document.activeElement !== stage.value) stage.value?.focus();
}

async function saveScreenshot() {
  const target = canvas.value;
  if (!target || !hasFrame.value || saving.value) return;
  saving.value = true;
  try {
    const data = target.toDataURL('image/jpeg', 0.85).split(',')[1] || '';
    const stamp = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const name = `browser-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.jpg`;
    const project = session.currentProjectId || 'default';
    await post('/api/files/upload', { path: project + '/' + name, content: data, encoding: 'base64' });
    ui.toast(`截图已保存到 /workspace/${project}/${name}`, { tone: 'success' });
  } catch (error: any) {
    ui.toast(error?.message || '截图保存失败', { tone: 'error' });
  } finally {
    saving.value = false;
  }
}

function openExternal() {
  const value = address.value.trim() || url;
  if (!value || value === 'about:blank') return;
  window.open(value, '_blank', 'noopener,noreferrer');
}

function onDocumentDown(event: PointerEvent) {
  if (!sizeMenu.value) return;
  const el = event.target as HTMLElement | null;
  if (el && !el.closest('.browser-size')) sizeMenu.value = false;
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentDown, true);
  if (stage.value) {
    observer = new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting === true; }, { threshold: 0 });
    observer.observe(stage.value);
  }
  void open();
});

onBeforeUnmount(() => {
  running = false;
  generation += 1;
  observer?.disconnect();
  observer = null;
  document.removeEventListener('pointerdown', onDocumentDown, true);
  if (pendingClick != null) clearTimeout(pendingClick);
  if (wheelTimer != null) clearTimeout(wheelTimer);
  image = null;
  void post('/api/browser/close', {}).catch(() => {});
});

watch(() => useSession().currentProjectId, () => { if (running) void reconnect(); });

defineExpose({ reload: reconnect });
</script>

<template>
  <div class="browser-pane">
    <div class="browser-bar">
      <div class="browser-nav">
        <button type="button" class="icon-button mini" title="后退" aria-label="后退" :disabled="!canBack" @click="navigate('back')">
          <Icon name="chevron-left" :size="14" />
        </button>
        <button type="button" class="icon-button mini" title="前进" aria-label="前进" :disabled="!canForward" @click="navigate('forward')">
          <Icon name="chevron-right" :size="14" />
        </button>
        <button type="button" class="icon-button mini" :class="{ 'is-spinning': loading }" title="刷新" aria-label="刷新" @click="navigate('reload')">
          <Icon name="refresh" :size="13" />
        </button>
      </div>

      <div class="browser-address" :class="{ 'is-loading': loading }">
        <Icon name="globe" :size="12.5" class="browser-address-icon" />
        <input
          ref="addressEl"
          v-model="address"
          type="text"
          class="browser-address-input"
          spellcheck="false"
          autocomplete="off"
          :placeholder="phase === 'open' ? '输入网址后回车' : '正在准备浏览器…'"
          aria-label="网页地址"
          @focus="editing = true"
          @blur="editing = false"
          @keydown="onAddressKey"
        />
        <span v-if="pageTitle" class="browser-page-title" :title="pageTitle">{{ pageTitle }}</span>
      </div>

      <div class="browser-tools">
        <div class="browser-size">
          <button type="button" class="icon-button mini" :class="{ 'is-on': sizeMenu }" :title="'视口尺寸：' + sizeLabel" aria-label="视口尺寸" @click="sizeMenu = !sizeMenu">
            <Icon name="columns" :size="13" />
          </button>
          <div v-if="sizeMenu" class="browser-size-menu" role="menu">
            <button
              v-for="s in SIZES"
              :key="s.key"
              type="button"
              role="menuitem"
              class="browser-size-item"
              :class="{ 'is-active': s.key === sizeKey }"
              @click="changeSize(s)"
            >{{ s.label }}</button>
          </div>
        </div>
        <button type="button" class="icon-button mini" title="在新标签页打开当前网址" aria-label="在新标签页打开" @click="openExternal">
          <Icon name="external-link" :size="13" />
        </button>
        <button type="button" class="icon-button mini" :class="{ 'is-spinning': saving }" :disabled="!hasFrame || saving" title="把当前画面保存到工作区" aria-label="保存截图" @click="saveScreenshot">
          <Icon :name="saving ? 'refresh' : 'image'" :size="13" />
        </button>
      </div>
    </div>

    <div ref="stage" class="browser-stage" tabindex="0" @pointerdown="onStagePointer" @keydown="onKeyDown" @paste="onPaste">
      <div class="browser-canvas-wrap" :class="{ 'is-portrait': frameH > frameW }">
        <canvas
          ref="canvas"
          class="browser-canvas"
          @click="onClick"
          @dblclick="onDoubleClick"
          @mousemove="onMove"
          @wheel="onWheel"
          @contextmenu.prevent
        ></canvas>
        <div v-if="!hasFrame || phase !== 'open'" class="browser-overlay" role="status">
          <template v-if="phase === 'connecting' || phase === 'open'"><span class="spinner"></span> 正在启动浏览器…</template>
          <template v-else>
            <span class="browser-note">{{ detail || (phase === 'closed' ? '浏览器已关闭' : '浏览器连接中断') }}</span>
            <button type="button" class="btn btn-quiet btn-sm" @click="reconnect">重新连接</button>
          </template>
        </div>
      </div>
      <p v-if="hasFrame" class="browser-hint">点击与输入直接在真实页面生效 · Ctrl/⌘ + L 输入网址</p>
    </div>
  </div>
</template>

<style scoped>
.browser-pane { position: relative; flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--surface-2); }
.browser-bar { flex: none; display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--line); background: var(--surface); }
.browser-nav { flex: none; display: flex; align-items: center; gap: 1px; }
.browser-nav .icon-button:disabled { opacity: 0.3; cursor: default; }
.is-spinning { animation: browser-spin 1s linear infinite; }
@keyframes browser-spin { to { transform: rotate(360deg); } }
.browser-address { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; height: 27px; padding: 0 9px; border: 1px solid var(--line); border-radius: 999px; background: color-mix(in srgb, var(--text) 3%, transparent); transition: border-color var(--fast), background-color var(--fast); }
.browser-address:focus-within { border-color: var(--line-strong); background: var(--surface); }
.browser-address-icon { flex: none; color: var(--muted); }
.browser-address-input { flex: 1; min-width: 40px; border: 0; background: transparent; color: var(--text); font-size: 12px; outline: none; }
.browser-address-input::placeholder { color: var(--faint); }
.browser-page-title { flex: none; max-width: 38%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 11px; }
.browser-tools { flex: none; display: flex; align-items: center; gap: 1px; }
.browser-size { position: relative; }
.browser-size-menu { position: absolute; right: 0; top: calc(100% + 6px); z-index: 40; min-width: 168px; padding: 4px; border: 1px solid var(--line-2); border-radius: 10px; background: var(--surface); box-shadow: var(--shadow-lg); }
.browser-size-item { display: block; width: 100%; padding: 6px 9px; border-radius: 7px; color: var(--text-2); font-size: 12px; text-align: left; white-space: nowrap; }
.browser-size-item:hover { background: color-mix(in srgb, var(--text) 6%, transparent); color: var(--text); }
.browser-size-item.is-active { color: var(--text); font-weight: 600; }
.browser-stage { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 10px; overflow: hidden; outline: none; }
.browser-stage:focus-visible .browser-canvas-wrap { box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 40%, transparent); }
.browser-canvas-wrap { position: relative; flex: 1; min-height: 0; width: 100%; display: flex; align-items: center; justify-content: center; border-radius: 8px; }
.browser-canvas { max-width: 100%; max-height: 100%; width: auto; height: auto; border-radius: 6px; box-shadow: 0 1px 2px rgba(0,0,0,.08), 0 8px 24px rgba(0,0,0,.08); cursor: default; user-select: none; -webkit-user-drag: none; }
.browser-canvas-wrap.is-portrait .browser-canvas { max-height: 100%; width: auto; }
.browser-overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 10px; border-radius: 8px; background: color-mix(in srgb, var(--surface-2) 88%, transparent); color: var(--muted); font-size: 12.5px; }
.browser-note { max-width: 70%; text-align: center; }
.browser-hint { flex: none; margin: 0; color: var(--faint); font-size: 10.5px; }
</style>

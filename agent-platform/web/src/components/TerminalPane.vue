<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { post } from '../services/api';
import { useSession } from '../stores/session';
import { useUi } from '../stores/ui';

// One real PTY per browser tab. Keystrokes go up as base64 frames and the
// output comes back through a long poll, so the shell sees a genuine tty:
// line editing, job control, colours and full-screen programs all work.
const host = ref<HTMLElement | null>(null);
const phase = ref<'connecting' | 'open' | 'closed' | 'error'>('connecting');
const detail = ref('');

let term: Terminal | null = null;
let fit: FitAddon | null = null;
let observer: ResizeObserver | null = null;
let running = false;
let generation = 0;
let after = 0;
let encoder = new TextEncoder();
let pending = '';
let pendingTimer: number | null = null;
let writes: Promise<unknown> = Promise.resolve();
let resizeTimer: number | null = null;

function toBase64(bytes: Uint8Array) {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}
function fromBase64(value: string) {
  const raw = atob(value);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function palette() {
  const style = host.value ? getComputedStyle(host.value) : getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => (style.getPropertyValue(name).trim() || fallback);
  const dark = document.documentElement.dataset.theme !== 'light';
  return {
    background: read('--term-bg', dark ? '#121317' : '#fafafc'),
    foreground: read('--term-fg', dark ? '#e4e4e7' : '#18181b'),
    cursor: read('--term-fg', dark ? '#e4e4e7' : '#18181b'),
    cursorAccent: read('--term-bg', dark ? '#121317' : '#fafafc'),
    selectionBackground: dark ? 'rgba(96,165,250,0.32)' : 'rgba(37,99,235,0.18)',
    black: dark ? '#3f3f46' : '#27272a',
    red: dark ? '#f87171' : '#dc2626',
    green: read('--term-prompt-u', dark ? '#34d399' : '#059669'),
    yellow: dark ? '#fbbf24' : '#b45309',
    blue: read('--term-prompt-d', dark ? '#60a5fa' : '#2563eb'),
    magenta: dark ? '#c084fc' : '#7c3aed',
    cyan: dark ? '#22d3ee' : '#0891b2',
    white: dark ? '#e4e4e7' : '#3f3f46',
    brightBlack: dark ? '#71717a' : '#52525b',
    brightRed: dark ? '#fca5a5' : '#ef4444',
    brightGreen: dark ? '#6ee7b7' : '#10b981',
    brightYellow: dark ? '#fde68a' : '#d97706',
    brightBlue: dark ? '#93c5fd' : '#3b82f6',
    brightMagenta: dark ? '#d8b4fe' : '#8b5cf6',
    brightCyan: dark ? '#67e8f9' : '#06b6d4',
    brightWhite: dark ? '#fafafa' : '#18181b',
  };
}

function flush() {
  if (pendingTimer != null) { clearTimeout(pendingTimer); pendingTimer = null; }
  if (!pending) return;
  const data = toBase64(encoder.encode(pending));
  pending = '';
  writes = writes.then(() => post('/api/terminal/write', { data })).catch(() => {});
}

function sendResize() {
  if (!term) return;
  const cols = term.cols, rows = term.rows;
  writes = writes.then(() => post('/api/terminal/write', { data: '', cols, rows })).catch(() => {});
}

function queue(data: string) {
  pending += data;
  if (pending.length >= 4096) flush();
  else if (pendingTimer == null) pendingTimer = window.setTimeout(flush, 8);
}

function scheduleResize() {
  if (resizeTimer != null) clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => { resizeTimer = null; sendResize(); }, 200);
}

async function pump(gen: number) {
  while (running && gen === generation) {
    try {
      const result = await post('/api/terminal/read', { after, wait: 10 });
      if (!running || gen !== generation || !term) return;
      if (typeof result.base === 'number' && result.base > after) after = result.base; // sync after buffer trim
      if (result.data) term.write(fromBase64(result.data));
      if (typeof result.cursor === 'number') after = result.cursor;
      if (result.closed) {
        phase.value = 'closed';
        detail.value = '终端已结束';
        return;
      }
    } catch (error: any) {
      if (!running || gen !== generation) return;
      phase.value = 'error';
      detail.value = error?.message || '终端连接中断';
      return;
    }
  }
}

async function open(): Promise<boolean> {
  if (!term) return false;
  const gen = ++generation;
  phase.value = 'connecting';
  detail.value = '';
  try {
    await post('/api/terminal/open', {
      project: useSession().currentProjectId || 'default',
      cols: term.cols, rows: term.rows,
    });
    if (gen !== generation) return false;
    after = 0;
    term.reset();
    phase.value = 'open';
    running = true;
    void pump(gen);
    term.focus();
    return true;
  } catch (error: any) {
    phase.value = 'error';
    detail.value = error?.message || '无法打开终端';
    return false;
  }
}

async function reconnect() {
  running = false;
  generation += 1;
  await wait(30);
  await open();
}

function clear() {
  term?.clear();
  term?.focus();
}

function focus() { term?.focus(); }

function appliedTheme() {
  if (term) term.options.theme = palette();
}

function fitPane() {
  if (!fit || !host.value) return;
  try { fit.fit(); } catch {}
}

onMounted(() => {
  const element = host.value;
  if (!element) return;
  term = new Terminal({
    cursorBlink: true,
    cursorStyle: 'bar',
    fontFamily: getComputedStyle(element).fontFamily || 'monospace',
    fontSize: 12.5,
    lineHeight: 1.35,
    letterSpacing: 0,
    scrollback: 5000,
    allowProposedApi: true,
    theme: palette(),
    convertEol: false,
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  try { term.loadAddon(new WebLinksAddon()); } catch {}
  term.open(element);
  fitPane();
  term.onData(queue);
  term.onResize(() => scheduleResize());
  observer = new ResizeObserver(() => fitPane());
  observer.observe(element);
  void open();
});

onBeforeUnmount(() => {
  running = false;
  generation += 1;
  if (pendingTimer != null) clearTimeout(pendingTimer);
  if (resizeTimer != null) clearTimeout(resizeTimer);
  observer?.disconnect();
  observer = null;
  term?.dispose();
  term = null;
  void post('/api/terminal/close', {}).catch(() => {});
});

watch(() => useUi().theme, () => { appliedTheme(); requestAnimationFrame(fitPane); });
watch(() => useSession().currentProjectId, () => { if (phase.value === 'open') void reconnect(); });

defineExpose({ focus, clear, reconnect, fitPane });
</script>

<template>
  <div class="terminal-pane">
    <div class="term-host" ref="host" />
    <div v-if="phase !== 'open'" class="term-overlay" role="status">
      <template v-if="phase === 'connecting'"><span class="spinner"></span> 正在连接沙箱终端…</template>
      <template v-else>
        <span class="term-note">{{ detail || (phase === 'closed' ? '终端已结束' : '终端连接中断') }}</span>
        <button type="button" class="btn btn-quiet btn-sm" @click="reconnect">重新连接</button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.terminal-pane { position: relative; flex: 1; min-width: 0; min-height: 0; display: flex; background: var(--term-bg); }
.term-host { flex: 1; min-width: 0; min-height: 0; padding: 8px 10px 4px; }
.term-host :deep(.xterm) { height: 100%; }
.term-host :deep(.xterm-viewport) { background: transparent !important; scrollbar-width: none; }
.term-host :deep(.xterm-viewport)::-webkit-scrollbar { display: none; }
.term-overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 10px; background: color-mix(in srgb, var(--term-bg) 86%, transparent); color: var(--term-title); font-size: 12.5px; }
.term-note { max-width: 70%; text-align: center; }
</style>

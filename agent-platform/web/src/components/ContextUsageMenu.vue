<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import Icon from './Icon.vue';
import { get } from '../services/api';
import { useSession } from '../stores/session';
import { useUi } from '../stores/ui';

const props = defineProps<{
  anchor: HTMLElement;
  localStats: {
    contextTokens: number;
    contextWindow: number;
    percent: number;
    inputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: number;
    userTurns: number;
    assistantCalls: number;
    toolCalls: number;
    avgTokensPerSec: number;
    peakTokensPerSec: number;
    liveTokensPerSec: number;
  };
}>();
const emit = defineEmits<{
  close: [];
  updated: [stats: any];
}>();

const session = useSession();
const ui = useUi();
const root = ref<HTMLElement | null>(null);
const remote = ref<any>(null);
const loading = ref(false);
const compacting = computed(() => !!session.chatId && session.compactions[session.chatId]?.state === 'running');

function calcPos(el?: HTMLElement | null) {
  const r = props.anchor.getBoundingClientRect();
  const margin = 10;
  const w = el?.offsetWidth || Math.min(364, window.innerWidth - 24);
  const spaceAbove = r.top - margin - 8;
  const spaceBelow = window.innerHeight - r.bottom - margin - 8;
  const up = spaceAbove >= Math.min(spaceBelow, 360) || spaceAbove > spaceBelow;
  const maxH = Math.max(220, Math.min(480, Math.floor(up ? spaceAbove : spaceBelow)));
  const left = Math.round(Math.max(margin, Math.min(r.right - w + 32, window.innerWidth - w - margin)));
  if (up) {
    return { left, top: 'auto', bottom: Math.round(window.innerHeight - r.top + 8) + 'px', maxH };
  }
  return { left, top: Math.round(r.bottom + 8) + 'px', bottom: 'auto', maxH };
}

const pos = ref(calcPos(null));
function place() { pos.value = calcPos(root.value); }
function onDoc(e: PointerEvent) {
  if (root.value && !root.value.contains(e.target as Node) && !props.anchor.contains(e.target as Node)) {
    emit('close');
  }
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
  }
}

async function fetchStats() {
  const thread = session.chatId;
  if (!thread) return;
  loading.value = true;
  try {
    const res = await get('/api/context/stats?chat=' + encodeURIComponent(thread));
    if (session.chatId !== thread) return;
    remote.value = res;
    emit('updated', res);
  } catch {
    // Fall back to local computed metrics if chat hasn't been persisted yet
  } finally {
    loading.value = false;
    void nextTick(place);
  }
}

const merged = computed(() => {
  const loc = props.localStats;
  const rem = remote.value;
  const cw = rem?.contextUsage?.contextWindow || loc.contextWindow || 128000;
  const ctxTokens = loc.contextTokens;
  const pct = Math.min(100, Number(((ctxTokens / cw) * 100).toFixed(1)));
  const autoCompactAt = rem?.contextUsage?.autoCompactThreshold || Math.round(cw * 0.85);
  const untilCompact = Math.max(0, autoCompactAt - ctxTokens);

  let input = Math.max(loc.inputTokens, rem?.tokens?.input || 0);
  const cacheRead = Math.max(loc.cacheReadTokens, rem?.tokens?.cacheRead || 0);
  let output = Math.max(loc.outputTokens, rem?.tokens?.output || 0);
  let total = Math.max(loc.totalTokens, rem?.tokens?.total || 0, input + cacheRead + output);
  if (total === 0 && ctxTokens > 0) {
    input = ctxTokens;
    total = ctxTokens;
  }
  const cost = Math.max(loc.cost, Number(rem?.cost) || 0);

  const assistantCalls = Math.max(loc.assistantCalls, rem?.assistantCalls || 0);
  const toolCalls = Math.max(loc.toolCalls, rem?.toolCalls || 0);
  const userTurns = Math.max(loc.userTurns, rem?.userMessages || 0);

  const avgRate = loc.liveTokensPerSec > 0
    ? loc.liveTokensPerSec
    : (rem?.speed?.avgTokensPerSec || loc.avgTokensPerSec || 0);
  const peakRate = Math.max(loc.peakTokensPerSec, rem?.speed?.peakTokensPerSec || 0, avgRate);

  const promptTotal = input + cacheRead;
  const cacheHitRate = promptTotal > 0
    ? Number(((cacheRead / promptTotal) * 100).toFixed(1))
    : (Number(rem?.cacheHitRate) || 0);

  const bd = rem?.contextUsage?.tokens === ctxTokens ? rem?.contextUsage?.breakdown : null;
  const segCache = bd ? (bd.cacheRead || 0) : Math.round(ctxTokens * (cacheRead / Math.max(1, total)));
  const segInput = bd ? ((bd.input || 0) + (bd.cacheWrite || 0)) : Math.max(0, ctxTokens - segCache - Math.min(ctxTokens, output));
  const segOutput = Math.max(0, ctxTokens - segCache - segInput);

  return {
    cw,
    ctxTokens,
    pct,
    autoCompactAt,
    untilCompact,
    segInputPct: Math.min(100, (segInput / cw) * 100),
    segCachePct: Math.min(100, (segCache / cw) * 100),
    segOutputPct: Math.min(100, (segOutput / cw) * 100),
    input,
    cacheRead,
    promptTotal,
    cacheHitRate,
    output,
    total,
    cost,
    userTurns,
    assistantCalls,
    toolCalls,
    avgRate,
    peakRate,
    isLiveRate: loc.liveTokensPerSec > 0,
  };
});

function fmtTok(n: number): string {
  const v = Math.max(0, Number(n) || 0);
  if (v >= 1_000_000) {
    const m = v / 1_000_000;
    return (m >= 10 ? m.toFixed(0) : m.toFixed(1).replace(/\.0$/, '')) + 'M';
  }
  if (v >= 1_000) {
    const k = v / 1_000;
    return (k >= 100 ? k.toFixed(0) : k.toFixed(1).replace(/\.0$/, '')) + 'k';
  }
  return String(Math.round(v));
}

function fmtCost(c: number): string {
  const v = Number(c) || 0;
  if (v <= 0) return '$0.00';
  if (v < 0.0001) return '< $0.0001';
  if (v < 0.01) return '$' + v.toFixed(4);
  return '$' + v.toFixed(3);
}

watch(() => session.chatId && session.compactions[session.chatId]?.state, (state) => {
  if (state === 'done') void fetchStats();
});

function openFullUsage() {
  emit('close');
  ui.openSettings('usage');
}

watch(() => session.messages.length, () => { void fetchStats(); });

onMounted(async () => {
  place();
  setTimeout(() => document.addEventListener('pointerdown', onDoc, true), 0);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place, { passive: true });
  await fetchStats();
  await nextTick();
  place();
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDoc, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', place);
});
</script>

<template>
  <teleport to="body">
    <div
      ref="root"
      class="cu-popover"
      role="dialog"
      aria-label="上下文窗口与会话用量"
      :style="{ left: pos.left + 'px', top: pos.top, bottom: pos.bottom, maxHeight: pos.maxH + 'px' }"
    >
      <!-- Top section: Claude Desktop-style Context Window progress & Compact session action -->
      <div class="cu-section">
        <div class="cu-head">
          <span class="cu-title">上下文窗口</span>
          <span class="cu-summary">
            <strong>{{ fmtTok(merged.ctxTokens) }}</strong> / {{ fmtTok(merged.cw) }} ({{ Math.round(merged.pct) }}%)
          </span>
        </div>

        <div class="cu-bar-track" :title="`当前上下文: ${merged.ctxTokens.toLocaleString()} / ${merged.cw.toLocaleString()} tokens`">
          <span class="cu-bar-seg is-input" :style="{ width: Math.max(merged.ctxTokens > 0 && merged.segInputPct === 0 ? 1.5 : 0, merged.segInputPct) + '%' }"></span>
          <span class="cu-bar-seg is-cache" :style="{ width: merged.segCachePct + '%' }"></span>
          <span class="cu-bar-seg is-output" :style="{ width: merged.segOutputPct + '%' }"></span>
          <span class="cu-bar-threshold" style="left: 85%" title="自动压缩阈值 (85%)"></span>
        </div>

        <div class="cu-compact-row">
          <span class="cu-until">
            <template v-if="merged.untilCompact > 0">距离自动压缩还有 {{ fmtTok(merged.untilCompact) }}</template>
            <template v-else>已达到自动压缩阈值</template>
          </span>
          <button
            type="button"
            class="cu-compact-btn"
            :disabled="!session.currentChat || session.busy || compacting || merged.ctxTokens === 0"
            title="调用模型将较早的对话整理为精简摘要，释放上下文窗口空间"
            @click="session.compactContext()"
          >
            <span v-if="compacting" class="spinner spinner-xs"></span>
            <span>{{ compacting ? '压缩中…' : '压缩上下文' }}</span>
          </button>
        </div>
      </div>

      <!-- Divider & Session Token / Cost / Speed stats -->
      <div class="cu-divider"></div>

      <div class="cu-section cu-stats-section">
        <div class="cu-metrics-strip">
          <div class="cu-metric">
            <span class="cu-metric-label">总 Token</span>
            <strong class="cu-metric-val">{{ fmtTok(merged.total) }}</strong>
          </div>
          <div class="cu-metric">
            <span class="cu-metric-label">估算费用</span>
            <strong class="cu-metric-val">{{ fmtCost(merged.cost) }}</strong>
          </div>
          <div class="cu-metric">
            <span class="cu-metric-label">缓存命中</span>
            <strong class="cu-metric-val">{{ merged.cacheHitRate.toFixed(1).replace(/\.0$/, '') }}%</strong>
          </div>
          <div class="cu-metric">
            <span class="cu-metric-label">输出速率</span>
            <strong class="cu-metric-val" :class="{ 'is-live': merged.isLiveRate }">
              <template v-if="merged.avgRate > 0">{{ merged.avgRate.toFixed(1) }} <small>t/s</small></template>
              <template v-else>—</template>
            </strong>
          </div>
        </div>

        <div class="cu-kv-list">
          <div class="cu-kv-row">
            <span class="cu-kv-key">Token 构成</span>
            <span class="cu-kv-val">输入 {{ fmtTok(merged.input) }} · 缓存 {{ fmtTok(merged.cacheRead) }} · 输出 {{ fmtTok(merged.output) }}</span>
          </div>
          <div class="cu-kv-row">
            <span class="cu-kv-key">缓存命中率</span>
            <span class="cu-kv-val">{{ merged.cacheHitRate.toFixed(1) }}%（命中 {{ fmtTok(merged.cacheRead) }} / 提示词 {{ fmtTok(merged.promptTotal) }}）</span>
          </div>
          <div class="cu-kv-row">
            <span class="cu-kv-key">交互与调用</span>
            <span class="cu-kv-val">
              {{ merged.userTurns }} 轮提问 · {{ merged.assistantCalls }} 次模型 · {{ merged.toolCalls }} 次工具<template v-if="merged.peakRate > 0"> · 峰值 {{ merged.peakRate.toFixed(1) }} t/s</template>
            </span>
          </div>
        </div>
      </div>

      <button type="button" class="cu-footer-btn" @click="openFullUsage">
        <Icon name="activity" :size="14" />
        <span>查看全局累计用量与趋势…</span>
      </button>
    </div>
  </teleport>
</template>

<style>
.cu-popover {
  position: fixed;
  z-index: 165;
  width: min(364px, calc(100vw - 24px));
  max-width: calc(100vw - 24px);
  padding: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--line-2);
  border-radius: 14px;
  background: var(--surface);
  box-shadow: var(--shadow-lg);
  transform-origin: bottom right;
  animation: menu-in 140ms var(--ease);
  font-variant-numeric: tabular-nums;
}
.cu-section {
  padding: 14px 16px 13px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cu-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.cu-title {
  color: var(--text);
  font-size: 13px;
  font-weight: 620;
  white-space: nowrap;
}
.cu-summary {
  color: var(--muted);
  font-size: 12.5px;
  white-space: nowrap;
}
.cu-summary strong {
  color: var(--text);
  font-weight: 630;
}

.cu-bar-track {
  position: relative;
  height: 6px;
  width: 100%;
  display: flex;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text) 8%, transparent);
}
.cu-bar-seg {
  height: 100%;
  transition: width 260ms var(--ease);
}
.cu-bar-seg.is-input {
  background: #d97757;
}
.cu-bar-seg.is-cache {
  background: #e59866;
}
.cu-bar-seg.is-output {
  background: #60a5fa;
}
.cu-bar-threshold {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1.5px;
  background: color-mix(in srgb, var(--text) 24%, transparent);
}

.cu-compact-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 1px;
}
.cu-until {
  flex: 1;
  min-width: 0;
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cu-compact-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 28px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid var(--line-strong);
  background: color-mix(in srgb, var(--text) 3.5%, var(--surface));
  color: var(--text);
  font-size: 12px;
  font-weight: 560;
  line-height: 1;
  white-space: nowrap;
  transition: background-color var(--fast), border-color var(--fast), opacity var(--fast);
}
.cu-compact-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--text) 8%, var(--surface));
  border-color: var(--text-2);
}
.cu-compact-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.spinner-xs {
  width: 11px;
  height: 11px;
  border-width: 1.6px;
}

.cu-divider {
  height: 1px;
  background: var(--line);
}

.cu-stats-section {
  padding: 12px 16px 13px;
  gap: 10px;
}
.cu-metrics-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
  padding: 9px 10px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--text) 3.2%, transparent);
}
.cu-metric {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.cu-metric + .cu-metric {
  padding-left: 7px;
  border-left: 1px solid var(--line);
}
.cu-metric-label {
  color: var(--muted);
  font-size: 10.5px;
  white-space: nowrap;
}
.cu-metric-val {
  color: var(--text);
  font-size: 13px;
  font-weight: 650;
  line-height: 1.25;
  white-space: nowrap;
}
.cu-metric-val small {
  font-size: 10.5px;
  font-weight: 520;
  color: var(--muted);
}
.cu-metric-val.is-live {
  color: var(--accent);
}

.cu-kv-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.cu-kv-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11.5px;
  line-height: 1.35;
}
.cu-kv-key {
  flex: none;
  color: var(--muted);
  white-space: nowrap;
}
.cu-kv-val {
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cu-footer-btn {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 16px;
  border-top: 1px solid var(--line);
  color: var(--text-2);
  font-size: 12px;
  white-space: nowrap;
  text-align: left;
  transition: background-color var(--fast), color var(--fast);
}
.cu-footer-btn:hover {
  background: color-mix(in srgb, var(--text) 5%, transparent);
  color: var(--text);
}
.cu-footer-btn svg {
  color: var(--muted);
}
</style>

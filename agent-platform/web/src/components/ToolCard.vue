<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import Icon from './Icon.vue';
import SiteIcon from './SiteIcon.vue';
import WebToolPages from './WebToolPages.vue';
import ToolImagePreview from './ToolImagePreview.vue';
import { formatDuration } from '../services/format';
import { rowSiteUrl } from '../services/site-icon.mjs';
import { useWorkspace } from '../stores/workspace';
import { useSession } from '../stores/session';

const props = defineProps<{ block?: any; tools?: any[] }>();

const list = computed<any[]>(() => {
  if (Array.isArray(props.tools) && props.tools.length) return props.tools;
  return props.block ? [props.block] : [];
});

const isGroup = computed(() => list.value.length > 1);

// 3-state machine for multi-tool groups (identical behavior to ThinkingBlock):
//   'preview'   -> initial state (~4 rows scrollable window, auto-scrolls to newest)
//   'collapsed' -> collapsed to the summary line
//   'expanded'  -> subsequent clicks toggle full list <-> collapsed
// A group stays in preview while any child is still running or pending, then
// collapses once every child has finished. Reopening that settled group pins it
// open so the same settled snapshot does not collapse again immediately.
type GroupMode = 'preview' | 'collapsed' | 'expanded';
const mode = ref<GroupMode>('preview');
const pinnedOpen = ref(false);
const listEl = ref<HTMLElement | null>(null);
const userScrolledUp = ref(false);
const openRows = ref<Record<string, boolean>>({});

function rowKey(b: any, idx: number) {
  return String(b?.id || idx);
}
function isRowOpen(b: any, idx: number) {
  return !!openRows.value[rowKey(b, idx)];
}
function toggleRow(b: any, idx: number) {
  const k = rowKey(b, idx);
  openRows.value = { ...openRows.value, [k]: !openRows.value[k] };
}

function toggleGroup() {
  if (mode.value === 'collapsed') {
    mode.value = 'expanded';
    if (runningCount.value === 0) pinnedOpen.value = true;
    return;
  }
  mode.value = 'collapsed';
  pinnedOpen.value = false;
}

function onGroupScroll() {
  if (mode.value !== 'preview' || !listEl.value) return;
  const el = listEl.value;
  userScrolledUp.value = el.scrollHeight - el.scrollTop - el.clientHeight > 20;
}

watch(
  () => list.value.map(b => `${b?.id || ''}:${b?.state || ''}:${(b?.result || '').length}`).join('|'),
  async () => {
    if (mode.value !== 'preview' || userScrolledUp.value) return;
    await nextTick();
    if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight;
  },
  { immediate: true }
);

const runningCount = computed(() => list.value.filter(b => b?.state === 'running' || b?.state === 'pending').length);
watch([isGroup, runningCount], ([group, running], previous) => {
  if (!group) return;
  if (running > 0) {
    pinnedOpen.value = false;
    if (mode.value === 'collapsed' && previous?.[1] === 0) mode.value = 'preview';
    return;
  }
  if (!pinnedOpen.value) mode.value = 'collapsed';
}, { immediate: true });
const stoppedCount = computed(() => list.value.filter(b => b.state === 'stopped' || b.state === 'interrupted').length);
const failedCount = computed(() => list.value.filter(b => b?.state === 'error').length);
const totalDurationMs = computed(() => list.value.reduce((acc, b) => acc + (Number(b?.durationMs) || 0), 0));

const VERBS: Record<string, string> = {
  read: '读取',
  image_search:'搜索图片',
  write: '写入',
  edit: '编辑',
  multi_edit: '编辑',
  bash: '运行',
  shell: '运行',
  ls: '浏览',
  list_dir: '浏览',
  glob: '查找',
  find: '查找',
  grep: '搜索',
  search: '搜索',
  web_search: '搜索',
  memory_read: '读取记忆',
  memory_update: '保存记忆',
  ask_user: '询问用户',
  background_start: '启动后台任务',
  background_status: '后台任务状态',
  background_stop: '停止后台任务',
  web_fetch: '访问',
  fetch: '访问',
};

function parseArgs(raw: any): Record<string, any> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)) || {}; } catch { return {}; }
}

function isWebTool(block: any) {
  return ['web_fetch', 'fetch', 'web_search', 'image_search'].includes(block?.name);
}

function actionParts(b: any): { verb: string; target: string; full: string } {
  const name = String(b?.name || 'tool').trim();
  const key = name.toLowerCase();
  const a = parseArgs(b?.args);
  const verb = VERBS[key] || name;
  if (key === 'bash' || key === 'shell') {
    const desc = String(a.description || '').trim();
    if (desc) return { verb: '运行', target: desc, full: desc };
    const cmd = String(a.command || a.cmd || '').replace(/\s+/g, ' ').trim();
    const t = cmd ? (cmd.length > 40 ? cmd.slice(0, 38) + '…' : cmd) : '终端命令';
    return { verb: '运行', target: t, full: `运行 ${t}` };
  }
  let target = String(a.path || a.file_path || a.pattern || a.query || a.url || a.name || '').replace(/\s+/g, ' ').trim();
  if (isWebTool(b) && (key === 'web_fetch' || key === 'fetch')) {
    try { target = new URL(a.url).hostname; } catch {}
    return { verb, target, full: target ? verb + ' ' + target : verb };
  }
  if (target) {
    if (target.includes('/') && !isWebTool(b)) {
      const parts = target.split('/');
      target = parts[parts.length - 1] || target;
    }
    if (target.length > 38) target = target.slice(0, 36) + '…';
    return { verb, target, full: `${verb} ${target}` };
  }
  return { verb, target: '', full: verb };
}

function summarize(b: any): string {
  return actionParts(b).full;
}

// Synthesize Claude-style summary:
// "Finished a background task, read 10 files...   and 9 more actions (2 failed)  +68 -33 · View changes >"
const claudeSummary = computed(() => {
  const tools = list.value;
  const total = tools.length;
  if (!total) return { headText: '', moreText: '', failedText: '', diffAdd: 0, diffDel: 0 };

  let reads = 0;
  let edits = 0;
  let runs = 0;
  let searches = 0;
  let diffAdd = 0;
  let diffDel = 0;
  const specificActions: string[] = [];

  for (const b of tools) {
    const key = String(b?.name || '').toLowerCase();
    const p = actionParts(b);

    if (key === 'read') {
      reads++;
      if (reads === 1 && p.target) specificActions.push(`读取了 ${p.target}`);
    } else if (key === 'write' || key === 'edit' || key === 'multi_edit') {
      edits++;
      if (edits === 1 && p.target) specificActions.push(`编辑了 ${p.target}`);
    } else if (key === 'bash' || key === 'shell') {
      runs++;
      if (runs === 1) specificActions.push(p.full);
    } else if (key === 'grep' || key === 'search' || key === 'find' || key === 'glob') {
      searches++;
      if (searches === 1) specificActions.push('搜索了代码');
    }

    // Only explicit structured edit statistics count. URLs, dates and output
    // numbers must never be interpreted as changed lines.
    if (['write', 'edit', 'multi_edit'].includes(key)) {
      const stats = b?.details?.diffStats;
      if (Number.isSafeInteger(stats?.added) && stats.added >= 0) diffAdd += stats.added;
      if (Number.isSafeInteger(stats?.removed) && stats.removed >= 0) diffDel += stats.removed;
    }
  }

  const headParts: string[] = [];
  if (runningCount.value > 0) {
    headParts.push(`正在执行 (${total - runningCount.value}/${total})`);
  } else {
    if (reads > 1) headParts.push(`读取了 ${reads} 个文件`);
    else if (reads === 1) headParts.push(specificActions.find(s => s.startsWith('读取')) || '读取了 1 个文件');

    if (edits > 1) headParts.push(`编辑了 ${edits} 个文件`);
    else if (edits === 1) headParts.push(specificActions.find(s => s.startsWith('编辑')) || '编辑了 1 个文件');

    if (runs > 1) headParts.push(`运行了 ${runs} 条命令`);
    else if (runs === 1) headParts.push(specificActions.find(s => s.startsWith('运行')) || '运行了终端命令');

    if (searches > 0 && headParts.length < 2) headParts.push('搜索了文件与代码');

    if (!headParts.length) {
      headParts.push(specificActions[0] || `执行了 ${total} 项操作`);
    }
  }

  const displayedCount = (reads > 1 ? reads : (reads === 1 ? 1 : 0)) + (edits > 1 ? edits : (edits === 1 ? 1 : 0));
  const remaining = Math.max(0, total - Math.max(1, displayedCount));
  const headText = headParts.slice(0, 2).join('，') + (remaining > 0 ? '…' : '');
  const moreText = remaining > 0 ? `还有 ${remaining} 项操作` : '';
  const failedText = failedCount.value > 0 ? `(${failedCount.value} 项失败)` : stoppedCount.value ? `(${stoppedCount.value} 项中断)` : '';

  return { headText, moreText, failedText, diffAdd, diffDel };
});

function argRows(b: any): Array<{ k: string; v: string }> {
  const a = parseArgs(b?.args);
  const keys = Object.keys(a);
  if (!keys.length) return b?.args ? [{ k: '', v: String(b.args) }] : [];
  return keys.map(k => ({ k, v: typeof a[k] === 'string' ? a[k] : JSON.stringify(a[k]) }));
}

function toolIcon(b: any): string {
  const k = String(b?.name || '').toLowerCase();
  if (k === 'bash' || k === 'shell') return 'terminal';
  if (k === 'read' || k === 'ls' || k === 'list_dir' || k === 'glob' || k === 'find') return 'file';
  if (k === 'grep' || k === 'search' || k === 'web_search') return 'search';
  if (k === 'web_fetch' || k === 'fetch') return 'globe';
  return 'edit';
}

function isFilePathArg(k: string, v: string) {
  if (k === 'path' || k === 'file' || k === 'destination') return true;
  return typeof v === 'string' && (v.startsWith('/workspace/') || v.startsWith('workspace/'));
}

function openArgFile(v: string) {
  const proj = useSession().currentProjectId;
  void useWorkspace().locateAndOpenFile(v, proj);
}

function imageName(block: any) {
  const args = parseArgs(block.args);
  return String(args.path || args.file_path || '').split(/[\\/]/).pop() || '读取的图片';
}
</script>

<template>
  <!-- Single tool call: Claude-style quiet inline row -->
  <div v-if="!isGroup && list[0]" class="tc-single" :data-state="list[0].state" :class="{ 'is-open': isRowOpen(list[0], 0) }">
    <div class="tc-row-head">
      <button
        type="button"
        class="tc-line"
        :aria-expanded="isRowOpen(list[0], 0)"
        @click="toggleRow(list[0], 0)"
      >
        <span v-if="list[0].state === 'running' || list[0].state === 'pending'" class="tc-dots" aria-hidden="true">
          <i></i><i></i><i></i>
        </span>
        <SiteIcon v-else-if="isWebTool(list[0])" :url="rowSiteUrl(list[0])" />
        <span v-else class="tc-mini-icon" aria-hidden="true">
          <Icon :name="toolIcon(list[0])" :size="13" />
        </span>
        <span class="tc-summary" :title="summarize(list[0])">{{ summarize(list[0]) }}</span>
        <span v-if="list[0].state === 'error'" class="tc-failed">失败</span>
        <span v-else-if="list[0].state === 'stopped' || list[0].state === 'interrupted'" class="tc-time">{{ list[0].state === 'stopped' ? '已停止' : '已中断' }}</span>
        <span v-if="list[0].durationMs" class="tc-dur">{{ formatDuration(list[0].durationMs) }}</span>
        <span class="tc-chevron"><Icon name="chevron-right" :size="12" /></span>
      </button>
      <ToolImagePreview v-if="list[0].imageUrl" :url="list[0].imageUrl" :name="imageName(list[0])" />
    </div>
    <div v-if="isRowOpen(list[0], 0)" class="tc-detail">
      <dl v-if="argRows(list[0]).length" class="tc-args">
        <template v-for="(r, ri) in argRows(list[0])" :key="ri">
          <dt v-if="r.k">{{ r.k }}</dt>
          <dd
            :class="{ 'is-wide': !r.k, 'is-ws-target': isFilePathArg(r.k, r.v) }"
            :title="isFilePathArg(r.k, r.v) ? '点击在工作区定位此文件' : undefined"
            @click="isFilePathArg(r.k, r.v) ? openArgFile(r.v) : undefined"
          >
            {{ r.v }}
          </dd>
        </template>
      </dl>
      <WebToolPages v-if="isWebTool(list[0])" :block="list[0]" />
      <div v-if="list[0].result" class="tc-out" :class="{ 'is-error': list[0].state === 'error' }">{{ list[0].result }}</div>
    </div>
  </div>

  <!-- Consecutive multi-tool group: Claude-style header + 3-state auto-scrolling list -->
  <div v-else-if="isGroup" class="tg" :data-mode="mode">
    <button
      type="button"
      class="tg-head"
      :aria-expanded="mode !== 'collapsed'"
      @click="toggleGroup"
    >
      <div class="tg-head-left">
        <span v-if="runningCount > 0" class="tc-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="tg-summary-head">{{ claudeSummary.headText }}</span>
      </div>
      <div class="tg-head-right">
        <span v-if="claudeSummary.moreText" class="tg-summary-more">{{ claudeSummary.moreText }}</span>
        <span v-if="claudeSummary.failedText" class="tg-failed-note">{{ claudeSummary.failedText }}</span>
        <span v-if="claudeSummary.diffAdd || claudeSummary.diffDel" class="tg-diff-badge">
          <span v-if="claudeSummary.diffAdd" class="tg-diff-add">+{{ claudeSummary.diffAdd }}</span>
          <span v-if="claudeSummary.diffDel" class="tg-diff-del">-{{ claudeSummary.diffDel }}</span>
        </span>
        <span class="tg-view-action" :title="mode === 'collapsed' ? '展开操作明细' : '收起操作明细'">
          <Icon name="chevron-right" :size="13" />
        </span>
      </div>
    </button>

    <div
      v-show="mode !== 'collapsed'"
      ref="listEl"
      class="tg-list"
      @scroll.passive="onGroupScroll"
    >
      <div
        v-for="(b, idx) in list"
        :key="rowKey(b, idx)"
        class="tg-item"
        :data-state="b.state"
        :class="{ 'is-open': isRowOpen(b, idx) }"
      >
        <div class="tc-row-head">
          <button
            type="button"
            class="tg-row"
            :aria-expanded="isRowOpen(b, idx)"
            @click="toggleRow(b, idx)"
          >
            <span v-if="b.state === 'running' || b.state === 'pending'" class="tc-dots" aria-hidden="true"><i></i><i></i><i></i></span>
            <SiteIcon v-else-if="isWebTool(b)" :url="rowSiteUrl(b)" />
            <span class="tg-row-summary" :title="summarize(b)">
              <span class="tg-row-verb">{{ actionParts(b).verb }}</span>
              <span class="tg-row-target">{{ actionParts(b).target }}</span>
            </span>
            <span v-if="b.state === 'error'" class="tc-failed">失败</span>
            <span v-else-if="b.state === 'stopped' || b.state === 'interrupted'" class="tc-time">{{ b.state === 'stopped' ? '已停止' : '已中断' }}</span>
            <span v-else-if="b.durationMs" class="tc-dur">{{ formatDuration(b.durationMs) }}</span>
            <span class="tc-chevron"><Icon name="chevron-right" :size="12" /></span>
          </button>
          <ToolImagePreview v-if="b.imageUrl" :url="b.imageUrl" :name="imageName(b)" />
        </div>
        <div v-if="isRowOpen(b, idx)" class="tc-detail">
          <dl v-if="argRows(b).length" class="tc-args">
            <template v-for="(r, ri) in argRows(b)" :key="ri">
              <dt v-if="r.k">{{ r.k }}</dt>
              <dd
                :class="{ 'is-wide': !r.k, 'is-ws-target': isFilePathArg(r.k, r.v) }"
                :title="isFilePathArg(r.k, r.v) ? '点击在工作区定位此文件' : undefined"
                @click="isFilePathArg(r.k, r.v) ? openArgFile(r.v) : undefined"
              >
                {{ r.v }}
              </dd>
            </template>
          </dl>
          <WebToolPages v-if="isWebTool(b)" :block="b" />
          <div v-if="b.result" class="tc-out" :class="{ 'is-error': b.state === 'error' }">{{ b.result }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
/* Single-line Claude-style tool row (borderless, quiet, inline) */
.tc-single {
  margin: 4px 0 6px;
  font-size: 13px;
}
.tc-line {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: 100%;
  min-width: 0;
  min-height: 26px;
  padding: 2px 6px 2px 2px;
  border-radius: 7px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.4;
  text-align: left;
  user-select: none;
  transition: color var(--fast), background-color var(--fast);
}
.tc-line:hover {
  color: var(--text-2);
  background: color-mix(in srgb, var(--text) 3.5%, transparent);
}
.tc-mini-icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  color: var(--faint);
}
.tc-single[data-state='error'] .tc-mini-icon {
  color: var(--danger);
}

/* Subtle 3-dot activity indicator (like Claude's neutral cluster) */
.tc-dots {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 2.5px;
  height: 14px;
}
.tc-dots i {
  width: 3.5px;
  height: 3.5px;
  border-radius: 50%;
  background: var(--text-2);
  opacity: 0.35;
  animation: tc-pulse 1.15s ease-in-out infinite;
}
.tc-dots i:nth-child(2) { animation-delay: 0.18s; }
.tc-dots i:nth-child(3) { animation-delay: 0.36s; }
@keyframes tc-pulse {
  0%, 100% { opacity: 0.28; transform: scale(0.92); }
  50% { opacity: 0.92; transform: scale(1.12); }
}

.tc-summary {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tc-failed {
  flex: none;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 11px;
  font-weight: 520;
  white-space: nowrap;
}
.tc-dur {
  flex: none;
  color: var(--faint);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.tc-chevron {
  flex: none;
  display: inline-flex;
  color: var(--faint);
  transition: transform 180ms var(--ease);
}
.is-open > .tc-row-head .tc-chevron {
  transform: rotate(90deg);
}
.tc-row-head { display: flex; align-items: center; gap: 6px; }
.tg-item .tool-image-preview { margin: 3px 8px 3px 0; }

/* Grouped multi-tool block: Claude-style full summary line + box */
.tg {
  margin: 7px 0 11px;
}
.tg-head {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 6px;
  border-radius: 8px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.45;
  user-select: none;
  transition: background-color var(--fast), color var(--fast);
}
.tg-head:hover {
  background: color-mix(in srgb, var(--text) 3.5%, transparent);
  color: var(--text);
}
.tg-head-left {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  overflow: hidden;
}
.tg-summary-head {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
  font-weight: 480;
}
.tg-head-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  font-size: 12.5px;
}
.tg-summary-more {
  color: var(--muted);
}
.tg-failed-note {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 11px;
  font-weight: 520;
}
.tg-diff-badge {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 1px 5px;
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.35;
}
.tg-diff-add {
  padding: 0 3px;
  border-radius: 3px;
  background: rgba(16, 185, 129, 0.16);
  color: #059669;
}
:root[data-theme='dark'] .tg-diff-add {
  background: rgba(16, 185, 129, 0.22);
  color: #34d399;
}
.tg-diff-del {
  padding: 0 3px;
  border-radius: 3px;
  background: rgba(239, 68, 68, 0.16);
  color: #dc2626;
}
:root[data-theme='dark'] .tg-diff-del {
  background: rgba(239, 68, 68, 0.22);
  color: #f87171;
}

.tg-view-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  color: var(--muted);
  transition: color var(--fast);
}
.tg-head:hover .tg-view-action {
  color: var(--text);
}
.tg-view-action svg {
  transition: transform 180ms var(--ease);
}
.tg[data-mode='preview'] .tg-view-action svg,
.tg[data-mode='expanded'] .tg-view-action svg {
  transform: rotate(90deg);
}

.tg-list {
  margin-top: 6px;
  border: 1px solid var(--line-2);
  border-radius: 11px;
  background: var(--surface);
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.02);
}
/* Preview mode: show ~4.3 rows & auto-scroll, matching ThinkingBlock's 3-state UX */
.tg[data-mode='preview'] .tg-list {
  max-height: 156px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.tg[data-mode='expanded'] .tg-list {
  max-height: none;
  overflow: visible;
}

.tg-item + .tg-item {
  border-top: 1px solid var(--line-2);
}
.tg-row {
  width: 100%;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 35px;
  padding: 6px 12px;
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.42;
  text-align: left;
  user-select: none;
  transition: background-color var(--fast), color var(--fast);
}
.tg-row:hover {
  background: color-mix(in srgb, var(--text) 2.6%, transparent);
  color: var(--text-2);
}
.tg-row-summary {
  flex: 1 1 auto;
  min-width: 0;
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  overflow: hidden;
  white-space: nowrap;
}
.tg-row-verb {
  color: var(--muted);
  font-size: 12px;
}
.tg-row-target {
  color: var(--text-2);
  font-weight: 560;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Expandable detail: left guideline + plain text, deliberately unlike boxed code blocks */
.tc-detail {
  margin: 3px 0 8px 9px;
  padding: 2px 0 2px 13px;
  border-left: 1.5px solid var(--line-2);
  animation: tc-detail-in 160ms var(--ease) both;
}
.tg-item > .tc-detail {
  margin: 0 12px 10px 21px;
}
@keyframes tc-detail-in { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: none; } }
.tc-args {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 3px 12px;
  margin: 0;
  font-size: 12px;
  line-height: 1.55;
}
.tc-args dt {
  color: var(--faint);
  font-size: 11.5px;
}
.tc-args dd {
  margin: 0;
  min-width: 0;
  max-height: 120px;
  overflow: auto;
  color: var(--text-2);
  font-family: var(--font-mono);
  font-size: 11.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.tc-args dd.is-wide {
  grid-column: 1 / -1;
}
.tc-out {
  max-height: 180px;
  margin-top: 7px;
  overflow: auto;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.tc-args + .tc-out {
  padding-top: 7px;
  border-top: 1px dashed var(--line);
}
.tc-out.is-error {
  padding: 6px 10px;
  border-radius: 7px;
  background: var(--danger-soft);
  color: var(--text-2);
  border: 1px solid color-mix(in srgb, var(--danger) 16%, transparent);
}
</style>

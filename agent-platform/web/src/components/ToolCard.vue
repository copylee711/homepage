<script setup lang="ts">
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';
import SiteIconStack from './SiteIconStack.vue';
import WebToolPages from './WebToolPages.vue';
import ToolImagePreview from './ToolImagePreview.vue';
import { formatDuration } from '../services/format';
import { rowSiteUrls, siteHost } from '../services/site-icon.mjs';
import { useWorkspace } from '../stores/workspace';
import { useSession } from '../stores/session';
import { useUi } from '../stores/ui';
import { workspaceImageUrl } from '../services/markdown-image.mjs';
import { toolImagePath } from '../services/tool-images.mjs';

const props = defineProps<{ block?: any; tools?: any[] }>();
const ui = useUi();

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
  list_directory: '浏览',
  search_files: '搜索文件',
  update_plan: '更新计划',
  set_chat_title: '命名会话',
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

// Summarize a group by what it actually did, e.g. "搜索了“Claude Opus 5.5”，访问了 anthropic.com".
// Every tool belongs to a category; each category yields one phrase, specific
// when it ran once and counted when it ran several times.
type Category = { key: string; count: number; first: string; many: (n: number) => string };
function hostOf(url: string) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } }
function short(text: string, n = 28) { const t = String(text || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
function categorize(b: any): { key: string; one: string; many: (n: number) => string } {
  const key = String(b?.name || '').toLowerCase();
  const a = parseArgs(b?.args);
  const p = actionParts(b);
  if (key === 'read') return { key: 'read', one: p.target ? `读取了 ${p.target}` : '读取了文件', many: n => `读取了 ${n} 个文件` };
  if (['write', 'edit', 'multi_edit'].includes(key)) return { key: 'edit', one: p.target ? `编辑了 ${p.target}` : '编辑了文件', many: n => `编辑了 ${n} 个文件` };
  if (key === 'bash' || key === 'shell') return { key: 'bash', one: p.full, many: n => `运行了 ${n} 条命令` };
  if (['grep', 'search', 'find', 'glob', 'search_files'].includes(key)) return { key: 'code', one: a.query ? `搜索了代码“${short(a.query, 20)}”` : '搜索了项目文件', many: n => `搜索了 ${n} 次代码` };
  if (['ls', 'list_dir', 'list_directory'].includes(key)) return { key: 'ls', one: p.target ? `浏览了 ${p.target}` : '浏览了目录', many: n => `浏览了 ${n} 个目录` };
  if (key === 'web_search') return { key: 'web', one: a.query ? `搜索了“${short(a.query)}”` : '搜索了网页', many: n => `搜索了 ${n} 次网页` };
  if (key === 'web_fetch' || key === 'fetch') return { key: 'fetch', one: a.url ? `访问了 ${hostOf(a.url)}` : '访问了网页', many: n => `访问了 ${n} 个网页` };
  if (key === 'image_search') return { key: 'image', one: a.query ? `搜索了图片“${short(a.query, 20)}”` : '搜索了图片', many: n => `搜索了 ${n} 次图片` };
  if (key === 'memory_read') return { key: 'mem-r', one: '读取了记忆', many: () => '读取了记忆' };
  if (key === 'memory_update') return { key: 'mem-w', one: '保存了记忆', many: n => `保存了 ${n} 条记忆` };
  if (key === 'update_plan') return { key: 'plan', one: '更新了计划', many: () => '更新了计划' };
  if (key === 'set_chat_title') return { key: 'title', one: '命名了会话', many: () => '命名了会话' };
  if (key === 'ask_user') return { key: 'ask', one: '询问了你', many: n => `询问了你 ${n} 次` };
  if (key.startsWith('background_')) return { key: 'bg', one: VERBS[key] || '管理后台任务', many: () => '管理了后台任务' };
  return { key: 'tool:' + key, one: `调用了 ${b?.name || '工具'}`, many: n => `调用了 ${n} 次 ${b?.name || '工具'}` };
}
const claudeSummary = computed(() => {
  const tools = list.value;
  const total = tools.length;
  if (!total) return { headText: '', moreText: '', failedText: '', diffAdd: 0, diffDel: 0 };

  let diffAdd = 0;
  let diffDel = 0;
  const cats: Category[] = [];
  for (const b of tools) {
    const c = categorize(b);
    const found = cats.find(x => x.key === c.key);
    if (found) found.count++; else cats.push({ key: c.key, count: 1, first: c.one, many: c.many });
    // Only explicit structured edit statistics count. URLs, dates and output
    // numbers must never be interpreted as changed lines.
    if (c.key === 'edit') {
      const stats = b?.details?.diffStats;
      if (Number.isSafeInteger(stats?.added) && stats.added >= 0) diffAdd += stats.added;
      if (Number.isSafeInteger(stats?.removed) && stats.removed >= 0) diffDel += stats.removed;
    }
  }
  // Bookkeeping (plan, title) only fills the line when nothing substantive ran.
  const minor = new Set(['plan', 'title']);
  const ordered = [...cats.filter(c => !minor.has(c.key)), ...cats.filter(c => minor.has(c.key))];
  const shown = ordered.slice(0, 2);
  const covered = shown.reduce((n, c) => n + c.count, 0);
  const remaining = total - covered;
  const phrase = (c: Category) => c.count > 1 ? c.many(c.count) : c.first;
  const headText = runningCount.value > 0
    ? `正在执行 (${total - runningCount.value}/${total}) · ${phrase(shown[shown.length - 1] || ordered[0])}`
    : shown.map(phrase).join('，');
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

// File-type glyphs: a read/write row shows what kind of file it touched.
const FILE_ICONS: Array<[RegExp, string]> = [
  [/\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|py|go|rs|java|kt|c|h|cpp|hpp|cs|rb|php|swift|sh|bash|zsh|fish|ps1|lua|sql|json|jsonc|ya?ml|toml|ini|cfg|conf|env|xml|html?|css|scss|sass|less|astro)$/i, 'file-code'],
  [/\.(csv|tsv|xlsx?|ods|xlsm)$/i, 'file-sheet'],
  [/\.(pptx?|odp|key)$/i, 'file-slide'],
  [/\.pdf$/i, 'file-pdf'],
  [/\.(png|jpe?g|gif|webp|svg|bmp|ico|tiff?|avif|heic)$/i, 'file-image'],
  [/\.(zip|tar|t?gz|bz2|xz|7z|rar|zst)$/i, 'file-archive'],
  [/\.(db|sqlite3?|parquet|duckdb)$/i, 'database'],
  [/\.(md|markdown|mdx|txt|log|rst|adoc|tex)$/i, 'file-text'],
  [/\.(docx?|odt|rtf|pages)$/i, 'file-text'],
];
function fileIcon(path: string): string {
  if (!path) return 'file';
  for (const [pattern, icon] of FILE_ICONS) if (pattern.test(path)) return icon;
  return 'file';
}

function toolIcon(b: any): string {
  const k = String(b?.name || '').toLowerCase();
  const a = parseArgs(b?.args);
  const path = String(a.path || a.file_path || a.filePath || a.file || a.destination || a.target || '');
  if (['read', 'write', 'edit', 'multi_edit', 'read_file', 'write_file', 'apply_patch'].includes(k)) return fileIcon(path);
  if (k === 'bash' || k === 'shell') return 'terminal';
  if (['ls', 'list_dir', 'list_directory'].includes(k)) return 'folder';
  if (['glob', 'find', 'search_files', 'grep', 'search'].includes(k)) return 'search';
  if (k === 'web_search' || k === 'image_search') return 'search';
  if (k === 'web_fetch' || k === 'fetch') return 'globe';
  if (k.startsWith('memory_')) return 'sparkle';
  if (k === 'update_plan') return 'list';
  if (k === 'ask_user') return 'message';
  if (k.startsWith('background_')) return 'activity';
  if (k === 'set_chat_title') return 'edit';
  if (k.includes('git')) return 'git';
  return 'file';
}

// Per-command animation while a tool runs, so the row says what it is doing
// (writing, searching, fetching) rather than a generic pulsing dot cluster.
function runClass(b: any): string {
  const k = String(b?.name || '').toLowerCase();
  if (k === 'bash' || k === 'shell') return 'run-bash';
  if (['write', 'edit', 'multi_edit', 'apply_patch'].includes(k)) return 'run-edit';
  if (['read', 'read_file'].includes(k)) return 'run-read';
  if (['web_fetch', 'fetch'].includes(k)) return 'run-web';
  if (['web_search', 'image_search', 'grep', 'search', 'glob', 'find', 'search_files'].includes(k)) return 'run-search';
  return 'run-default';
}

function isFilePathArg(k: string, v: string) {
  if (k === 'path' || k === 'file' || k === 'destination') return true;
  return typeof v === 'string' && (v.startsWith('/workspace/') || v.startsWith('workspace/'));
}

function openArgFile(v: string) {
  const proj = useSession().currentProjectId;
  void useWorkspace().locateAndOpenFile(v, proj);
}

// A running tool ticks its own elapsed time, like the desktop client, so a
// long call never looks frozen.
const now = ref(Date.now());
let ticker: number | null = null;
watch(
  () => list.value.some(b => b?.state === 'running'),
  running => {
    if (running && ticker == null) ticker = window.setInterval(() => { now.value = Date.now(); }, 500);
    if (!running && ticker != null) { clearInterval(ticker); ticker = null; }
  },
  { immediate: true }
);
onBeforeUnmount(() => { if (ticker != null) clearInterval(ticker); });

function durationOf(block: any) {
  if (!block) return 0;
  if (block.state === 'running') return block.started ? Math.max(0, now.value - block.started) : 0;
  return block.durationMs || 0;
}

function imageName(block: any) {
  const args = parseArgs(block.args);
  return String(args.path || args.file_path || '').split(/[\\/]/).pop() || '读取的图片';
}

// Image payloads never reach the browser, so a read-image row shows the file
// from the workspace instead of an inline copy.
function imageUrlFor(block: any): string | undefined {
  if (block?.imageUrl) return block.imageUrl;
  const path = toolImagePath(block);
  if (!path) return undefined;
  return workspaceImageUrl(path, useSession().currentProjectId || 'default');
}

const groupImages = computed(() => list.value
  .map(block => { const url = imageUrlFor(block); return url ? { url, name: imageName(block) } : null; })
  .filter(Boolean) as Array<{ url: string; name: string }>);
const visibleImages = computed(() => groupImages.value.slice(-3));
const extraImages = computed(() => Math.max(0, groupImages.value.length - visibleImages.value.length));

// Sites visited by this group, deduplicated by host and stacked on the summary.
// A search that ranked eight sites contributes up to eight icons, not one.
const allSites = computed(() => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const block of list.value) {
    if (!isWebTool(block)) continue;
    for (const url of rowSiteUrls(block)) {
      const host = siteHost(url);
      if (!host || seen.has(host)) continue;
      seen.add(host);
      out.push(url);
    }
  }
  return out;
});
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
        <span v-if="list[0].state === 'pending'" class="tc-dots" aria-hidden="true">
          <i></i><i></i><i></i>
        </span>
        <span
          v-else-if="list[0].state === 'running'"
          class="tc-mini-icon is-live"
          :class="runClass(list[0])"
          aria-hidden="true"
        >
          <Icon :name="toolIcon(list[0])" :size="13" />
        </span>
        <SiteIconStack v-else-if="isWebTool(list[0]) && rowSiteUrls(list[0]).length" :urls="rowSiteUrls(list[0])" :max="3" />
        <span v-else class="tc-mini-icon" aria-hidden="true">
          <Icon :name="toolIcon(list[0])" :size="13" />
        </span>
        <span class="tc-summary" :title="summarize(list[0])">{{ summarize(list[0]) }}</span>
        <span v-if="list[0].state === 'error'" class="tc-failed">失败</span>
        <span v-else-if="list[0].state === 'stopped' || list[0].state === 'interrupted'" class="tc-time">{{ list[0].state === 'stopped' ? '已停止' : '已中断' }}</span>
        <span v-if="durationOf(list[0])" class="tc-dur" :class="{ 'is-live': list[0].state === 'running' }">{{ formatDuration(durationOf(list[0])) }}</span>
        <span class="tc-chevron"><Icon name="chevron-right" :size="12" /></span>
      </button>
      <ToolImagePreview v-if="imageUrlFor(list[0])" :url="imageUrlFor(list[0]) || ''" :name="imageName(list[0])" />
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
    <div class="tg-head">
      <button
        type="button"
        class="tg-head-btn"
        :aria-expanded="mode !== 'collapsed'"
        @click="toggleGroup"
      >
        <div class="tg-head-left">
          <span v-if="runningCount > 0" class="tc-dots" aria-hidden="true"><i></i><i></i><i></i></span>
          <span class="tg-summary-head">{{ claudeSummary.headText }}</span>
          <!-- Visited sites follow the summary text, one icon per host. -->
          <SiteIconStack v-if="allSites.length" :urls="allSites" :max="4" size="md" />
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
      <!-- Read images stay visible on the summary line, newest last. -->
      <div v-if="visibleImages.length" class="tg-thumbs">
        <span v-if="extraImages" class="tg-thumbs-more">+{{ extraImages }}</span>
        <button
          v-for="(img, i) in visibleImages"
          :key="img.url + i"
          type="button"
          class="tg-thumb"
          :aria-label="'预览图片 ' + img.name"
          :title="img.name"
          @click.stop="ui.openLightbox({ url: img.url, name: img.name })"
        >
          <img :src="img.url" alt="" loading="lazy" decoding="async">
        </button>
      </div>
    </div>
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
            <span v-if="b.state === 'pending'" class="tc-dots" aria-hidden="true"><i></i><i></i><i></i></span>
            <span v-else-if="b.state === 'running'" class="tc-mini-icon is-live" :class="runClass(b)" aria-hidden="true">
              <Icon :name="toolIcon(b)" :size="13" />
            </span>
            <SiteIconStack v-else-if="isWebTool(b) && rowSiteUrls(b).length" :urls="rowSiteUrls(b)" :max="3" />
            <span class="tg-row-summary" :title="summarize(b)">
              <span class="tg-row-verb">{{ actionParts(b).verb }}</span>
              <span class="tg-row-target">{{ actionParts(b).target }}</span>
            </span>
            <span v-if="b.state === 'error'" class="tc-failed">失败</span>
            <span v-else-if="b.state === 'stopped' || b.state === 'interrupted'" class="tc-time">{{ b.state === 'stopped' ? '已停止' : '已中断' }}</span>
            <span v-else-if="durationOf(b)" class="tc-dur" :class="{ 'is-live': b.state === 'running' }">{{ formatDuration(durationOf(b)) }}</span>
            <span class="tc-chevron"><Icon name="chevron-right" :size="12" /></span>
          </button>
          <ToolImagePreview v-if="imageUrlFor(b)" :url="imageUrlFor(b) || ''" :name="imageName(b)" />
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

/* Running tool: the category glyph itself animates, so the row reads as
   "writing" / "searching" / "fetching" instead of a generic pulse. */
.tc-mini-icon.is-live { color: var(--text-2); }
.tc-mini-icon.is-live .icon { transform-origin: 50% 50%; }
.tc-mini-icon.run-bash.is-live .icon { animation: tc-run-bash 1.05s ease-in-out infinite; }
.tc-mini-icon.run-edit.is-live .icon { animation: tc-run-edit 1.25s ease-in-out infinite; }
.tc-mini-icon.run-read.is-live .icon { animation: tc-run-read 1.5s ease-in-out infinite; }
.tc-mini-icon.run-search.is-live .icon { animation: tc-run-search 1.35s ease-in-out infinite; }
.tc-mini-icon.run-web.is-live .icon { animation: tc-run-web 3.2s linear infinite; }
.tc-mini-icon.run-default.is-live .icon { animation: tc-run-read 1.4s ease-in-out infinite; }
@keyframes tc-run-bash { 0%, 100% { transform: translateY(0); opacity: 0.72; } 50% { transform: translateY(-1.5px); opacity: 1; } }
@keyframes tc-run-edit { 0%, 100% { transform: rotate(-8deg); } 50% { transform: rotate(8deg); } }
@keyframes tc-run-read { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
@keyframes tc-run-search { 0%, 100% { transform: translate(0, 0) scale(0.94); opacity: 0.6; } 50% { transform: translate(1px, -1px) scale(1.06); opacity: 1; } }
@keyframes tc-run-web { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .tc-mini-icon.is-live .icon { animation: none; }
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
/* Still running: the counter keeps moving and breathes so a long call never
   looks stuck. */
.tc-dur.is-live { color: var(--muted); animation: tc-live 1.6s ease-in-out infinite; }
@keyframes tc-live { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
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
  gap: 8px;
  padding: 4px 6px;
  border-radius: 8px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.45;
  user-select: none;
  transition: background-color var(--fast), color var(--fast);
}
.tg-head-btn {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.tg-head:hover {
  background: color-mix(in srgb, var(--text) 3.5%, transparent);
  color: var(--text);
}
.tg-thumbs { display: flex; align-items: center; gap: 4px; flex: none; }
.tg-thumbs-more { color: var(--muted); font-size: 12px; }
.tg-thumb {
  width: 27px;
  height: 18px;
  padding: 0;
  border: 1px solid var(--line-2);
  border-radius: 5px;
  overflow: hidden;
  background: var(--surface-2);
  cursor: zoom-in;
  transition: border-color var(--fast), transform var(--fast);
}
.tg-thumb:hover { border-color: var(--accent); transform: translateY(-1px); }
.tg-thumb img { display: block; width: 100%; height: 100%; object-fit: cover; }
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
  scrollbar-width: none;
}
.tg[data-mode='preview'] .tg-list::-webkit-scrollbar { display: none; }
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

<script setup lang="ts">
import { ref, computed } from 'vue';
import Icon from './Icon.vue';
import { formatDuration } from '../services/format';

const props = defineProps<{ block: any }>();
const open = ref(false);
const TOOL_NAMES: Record<string, string> = { bash: '终端命令', read: '读取文件', write: '写入文件', edit: '编辑文件' };
const STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: '等待执行', tone: 'pending' }, running: { label: '运行中', tone: 'running' },
  success: { label: '已完成', tone: 'success' }, error: { label: '失败', tone: 'error' },
};
const label = computed(() => TOOL_NAMES[props.block.name] || props.block.name || '工具');
const status = computed(() => STATUS[props.block.state] || STATUS.pending);
const icon = computed(() => props.block.name === 'bash' ? 'terminal' : props.block.name === 'read' ? 'file' : 'edit');
const preview = computed(() => {
  try { const a = JSON.parse(props.block.args || '{}'); const h = props.block.name === 'bash' ? a.command : (a.path || a.file_path || a.pattern || ''); return String(h || '').replace(/\s+/g, ' ').slice(0, 100); } catch { return ''; }
});
</script>

<template>
  <details class="tool-card" :data-state="block.state" :open="open" @toggle="open = ($event.target as HTMLDetailsElement).open">
    <summary class="tool-summary">
      <span class="tool-icon"><Icon :name="icon" :size="15" /></span>
      <span class="tool-name">{{ label }}</span>
      <code class="tool-code-name">{{ block.name }}</code>
      <span class="tool-preview">{{ preview }}</span>
      <span class="tool-status" :class="'tone-' + status.tone">{{ status.label }}</span>
      <span v-if="block.durationMs" class="tool-duration">{{ formatDuration(block.durationMs) }}</span>
      <span class="tool-chevron"><Icon name="chevron-right" :size="14" /></span>
    </summary>
    <div class="tool-body">
      <section v-if="block.args" class="tool-section"><h4>参数</h4><pre class="tool-pre">{{ block.args }}</pre></section>
      <section v-if="block.result" class="tool-section"><h4>结果</h4><pre class="tool-pre">{{ block.result }}</pre></section>
    </div>
  </details>
</template>

<style>
.tool-card { margin: 11px 0; overflow: hidden; border: 1px solid var(--line-2); border-radius: 14px; background: var(--surface); font-size: 12.5px; box-shadow: var(--shadow-sm); transition: border-color var(--fast), box-shadow var(--fast); }
.tool-card[data-state='running'] { border-color: color-mix(in srgb, var(--accent) 45%, var(--line-2)); box-shadow: 0 0 0 3px var(--accent-soft); }
.tool-summary { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 40px; padding: 7px 11px; list-style: none; cursor: pointer; color: var(--text-2); user-select: none; }
.tool-summary::-webkit-details-marker { display: none; }
.tool-summary:hover { background: color-mix(in srgb, var(--text) 3.5%, transparent); }
.tool-icon { display: grid; place-items: center; width: 26px; height: 26px; flex: none; border-radius: 8px; background: var(--accent-soft); color: var(--accent); }
.tool-name { flex: none; font-weight: 600; white-space: nowrap; }
.tool-code-name { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 1.5px 6px; border-radius: 6px; background: var(--bg-tint); color: var(--muted); font-family: var(--font-mono); font-size: 9.5px; }
.tool-preview { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-family: var(--font-mono); font-size: 10.5px; }
.tool-status { flex: none; padding: 2.5px 8px; border-radius: 999px; font-size: 9.5px; line-height: 1.5; white-space: nowrap; font-weight: 650; }
.tool-status.tone-pending { color: var(--muted); background: color-mix(in srgb, var(--text) 5%, transparent); }
.tool-status.tone-running { color: var(--accent-ink); background: var(--accent-soft); }
.tool-status.tone-success { color: var(--ok); background: var(--ok-soft); }
.tool-status.tone-error { color: var(--danger); background: var(--danger-soft); }
.tool-duration { flex: none; color: var(--faint); font-size: 9.5px; font-variant-numeric: tabular-nums; }
.tool-chevron { display: flex; color: var(--faint); transition: transform var(--dur) var(--ease); }
.tool-card[open] .tool-chevron { transform: rotate(90deg); }
.tool-body { padding: 10px 12px 12px; border-top: 1px solid var(--line); }
.tool-section + .tool-section { margin-top: 11px; }
.tool-section h4 { margin: 0 0 5px; color: var(--muted); font-size: 9.5px; font-weight: 650; letter-spacing: 0.03em; text-transform: uppercase; }
.tool-pre { max-height: 260px; margin: 0; padding: 9px 11px; overflow: auto; border: 1px solid var(--line); border-radius: 9px; background: var(--code-bg); font-family: var(--font-mono); font-size: 11px; line-height: 1.56; white-space: pre-wrap; word-break: break-word; }
</style>

<script setup lang="ts">
import { computed } from 'vue';
import MarkdownView from './MarkdownView.vue';
import ThinkingBlock from './ThinkingBlock.vue';
import { segmentBlocks, groupExecution } from '../services/transcript.mjs';
import PlanCard from './PlanCard.vue';
import ToolCard from './ToolCard.vue';
import SourceList from './SourceList.vue';
import SiteIconStack from './SiteIconStack.vue';
import { rowSiteUrls } from '../services/site-icon.mjs';
import { collectSources, splitSourceBlocks } from '../services/markdown.js';

function execSiteUrls(items: any[]): string[] {
  const out: string[] = [];
  for (const item of items || []) {
    if (item?.type === 'tool') out.push(...rowSiteUrls(item));
  }
  return out;
}

// Accepts normalized blocks: { type:'text'|'thinking'|'tool', text?, ...tool fields }
const props = defineProps<{ blocks: any[]; streaming?: boolean; nested?:boolean; references?:any[] }>();
const sourceBlocks = computed(() => props.blocks.map(block =>
  block.type === 'text' ? splitSourceBlocks(block.text) : null));
const displayBlocks = computed(() => props.blocks
  .map((block, index) => sourceBlocks.value[index] ? { ...block, text: sourceBlocks.value[index].text } : block)
  .filter(block => block.type !== 'tool' || block.name !== 'set_chat_title'));
const segments = computed(() => {
  return props.nested ? segmentBlocks(displayBlocks.value) : groupExecution(displayBlocks.value, props.streaming);
});
const citations=computed(()=>{
  if(props.references)return props.references;
  const metadata=[];for(const block of props.blocks||[]){if(block.type==='tool'&&block.result){try{const result=JSON.parse(block.result);if(Array.isArray(result.results)&&!result.images)metadata.push(...result.results);}catch{}}}
  return collectSources(sourceBlocks.value.map(block => block?.text || '').join('\n\n'), metadata, sourceBlocks.value.flatMap(block => block?.sources || []));
});
</script>

<template>
  <div class="blocks">
    <template v-for="(seg, i) in segments" :key="seg.type === 'tools' ? seg.items[0]?.id || i : i">
      <details v-if="seg.type === 'execution'" :open="!seg.collapsed" class="work-prelude" :class="{ 'has-body': seg.collapsed }">
        <summary class="work-prelude-summary">
          <SiteIconStack v-if="execSiteUrls(seg.items).length" :urls="execSiteUrls(seg.items)" :size="14" :max="5" />
          <span>查看执行过程 · {{ seg.items.length }} 项</span>
        </summary>
        <BlockList :blocks="seg.items" :streaming="streaming" nested :references="citations" />
      </details>
      <MarkdownView v-else-if="seg.type === 'text'" :source="seg.text" :citations="citations" :streaming="streaming && i === segments.length - 1" />
      <ThinkingBlock v-else-if="seg.type === 'thinking'" :text="seg.text" :started="seg.started" :duration-ms="seg.durationMs" />
      <PlanCard v-else-if="seg.type === 'plan'" :block="seg.block" />
      <ToolCard v-else-if="seg.type === 'tools'" :tools="seg.items" />
    </template>
    <SourceList v-if="!nested && !streaming && citations.length" :sources="citations" />
  </div>
</template>

<style>
.blocks { min-width: 0; }
.work-prelude{margin:2px 0 16px;color:var(--muted)}.work-prelude>summary{cursor:pointer;padding:6px 0;font-size:12px;user-select:none}.work-prelude>summary.work-prelude-summary{display:inline-flex;align-items:center;gap:6px}.work-prelude>summary.work-prelude-summary::before{content:'▸';font-size:11px;line-height:1;color:var(--faint);transition:transform var(--fast)}.work-prelude[open]>summary.work-prelude-summary::before{transform:rotate(90deg)}.work-prelude>summary::-webkit-details-marker{display:none}.work-prelude[open]>.blocks{margin:10px 0 20px;padding-left:12px;border-left:1px solid var(--line)}
.work-prelude:not(.has-body)>summary{display:none}.work-prelude:not(.has-body)[open]>.blocks{margin:0;padding:0;border:0}
</style>

<script setup lang="ts">
import { computed,ref,watch } from 'vue';
import MarkdownView from './MarkdownView.vue';
import ThinkingBlock from './ThinkingBlock.vue';
import { segmentBlocks } from '../services/transcript.mjs';
import PlanCard from './PlanCard.vue';
import ToolCard from './ToolCard.vue';
import SourceList from './SourceList.vue';
import { collectSources } from '../services/markdown.js';

// Accepts normalized blocks: { type:'text'|'thinking'|'tool', text?, ...tool fields }
const props = defineProps<{ blocks: any[]; streaming?: boolean; nested?:boolean; references?:any[] }>();
const displayBlocks = computed(() => props.blocks.filter(block => block.type !== 'tool' || block.name !== 'set_chat_title'));
const bodyIndex=computed(()=>props.nested?-1:displayBlocks.value.findLastIndex(b=>b.type==='text'&&b.text?.trim()));
const prelude=computed(()=>props.nested?[]:bodyIndex.value>0?displayBlocks.value.slice(0,bodyIndex.value):bodyIndex.value<0?displayBlocks.value:[]);
const visibleBlocks=computed(()=>props.nested?displayBlocks.value:bodyIndex.value<0?[]:displayBlocks.value.slice(bodyIndex.value));
const preludeOpen=ref(true);
const canCollapse = computed(() => bodyIndex.value >= 0 || !props.streaming);
watch([bodyIndex, canCollapse], ([index, ready], previous) => {
  if (ready && (index > 0 || !props.streaming) && (!previous?.[1] || index !== previous[0])) preludeOpen.value = false;
}, { immediate: true });

const segments = computed(() => segmentBlocks(visibleBlocks.value));
const citations=computed(()=>{
  if(props.references)return props.references;
  const metadata=[];for(const block of props.blocks||[]){if(block.type==='tool'&&block.result){try{const result=JSON.parse(block.result);if(Array.isArray(result.results)&&!result.images)metadata.push(...result.results);}catch{}}}
  return collectSources((props.blocks||[]).filter(b=>b.type==='text').map(b=>b.text||'').join('\n\n'),metadata);
});
</script>

<template>
  <div class="blocks">
    <details v-if="!nested" v-show="prelude.length" :open="preludeOpen" class="work-prelude" :class="{'has-body':canCollapse}" @toggle="preludeOpen=($event.target as HTMLDetailsElement).open"><summary>查看执行过程 · {{prelude.length}} 项</summary><BlockList :blocks="prelude" :streaming="streaming" :nested="true" :references="citations" /></details>
    <template v-for="(seg, i) in segments" :key="seg.type === 'tools' ? seg.items[0]?.id || i : i">
      <MarkdownView v-if="seg.type === 'text'" :source="seg.text" :citations="citations" :streaming="streaming" />
      <ThinkingBlock v-else-if="seg.type === 'thinking'" :text="seg.text" />
      <PlanCard v-else-if="seg.type === 'plan'" :block="seg.block" />
      <ToolCard v-else-if="seg.type === 'tools'" :tools="seg.items" />
    </template>
    <SourceList v-if="!nested && !streaming && citations.length" :sources="citations" />
  </div>
</template>

<style>
.blocks { min-width: 0; }
.work-prelude{margin:2px 0 16px;color:var(--muted)}.work-prelude>summary{cursor:pointer;padding:6px 0;font-size:12px;user-select:none}.work-prelude[open]>.blocks{margin:10px 0 20px;padding-left:12px;border-left:1px solid var(--line)}
.work-prelude:not(.has-body)>summary{display:none}.work-prelude:not(.has-body)[open]>.blocks{margin:0;padding:0;border:0}
</style>

<script setup lang="ts">
import { computed } from 'vue';
import MarkdownView from './MarkdownView.vue';
import ThinkingBlock from './ThinkingBlock.vue';
import ToolCard from './ToolCard.vue';

// Accepts normalized blocks: { type:'text'|'thinking'|'tool', text?, ...tool fields }
const props = defineProps<{ blocks: any[]; streaming?: boolean }>();

const segments = computed(() => {
  const out: any[] = [];
  for (const b of props.blocks || []) {
    if (!b) continue;
    if (b.type === 'tool') {
      const last = out[out.length - 1];
      if (last && last.type === 'tools') last.items.push(b);
      else out.push({ type: 'tools', items: [b] });
    } else {
      out.push(b);
    }
  }
  return out;
});
</script>

<template>
  <div class="blocks">
    <template v-for="(seg, i) in segments" :key="i">
      <MarkdownView v-if="seg.type === 'text'" :source="seg.text" :sources="true" :fresh="streaming && seg.fresh" />
      <ThinkingBlock v-else-if="seg.type === 'thinking'" :text="seg.text" />
      <ToolCard v-else-if="seg.type === 'tools'" :tools="seg.items" />
    </template>
  </div>
</template>

<style>
.blocks { min-width: 0; }
</style>

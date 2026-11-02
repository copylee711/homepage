<script setup lang="ts">
import { computed } from 'vue';
import MarkdownView from './MarkdownView.vue';
import ThinkingBlock from './ThinkingBlock.vue';
import { segmentBlocks } from '../services/transcript.mjs';
import PlanCard from './PlanCard.vue';
import ToolCard from './ToolCard.vue';

// Accepts normalized blocks: { type:'text'|'thinking'|'tool', text?, ...tool fields }
const props = defineProps<{ blocks: any[]; streaming?: boolean }>();

const segments = computed(() => segmentBlocks(props.blocks));
</script>

<template>
  <div class="blocks">
    <template v-for="(seg, i) in segments" :key="i">
      <MarkdownView v-if="seg.type === 'text'" :source="seg.text" :sources="true" :fresh="streaming && seg.fresh" />
      <ThinkingBlock v-else-if="seg.type === 'thinking'" :text="seg.text" />
      <PlanCard v-else-if="seg.type === 'plan'" :block="seg.block" />
      <ToolCard v-else-if="seg.type === 'tools'" :tools="seg.items" />
    </template>
  </div>
</template>

<style>
.blocks { min-width: 0; }
</style>

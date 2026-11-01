<script setup lang="ts">
import MarkdownView from './MarkdownView.vue';
import ThinkingBlock from './ThinkingBlock.vue';
import ToolCard from './ToolCard.vue';

// Accepts normalized blocks: { type:'text'|'thinking'|'tool', text?, ...tool fields }
defineProps<{ blocks: any[]; streaming?: boolean }>();
</script>

<template>
  <div class="blocks">
    <template v-for="(b, i) in blocks" :key="i">
      <MarkdownView v-if="b.type === 'text'" :source="b.text" :sources="true" :fresh="streaming && b.fresh" />
      <ThinkingBlock v-else-if="b.type === 'thinking'" :text="b.text" />
      <ToolCard v-else-if="b.type === 'tool'" :block="b" />
    </template>
  </div>
</template>

<style>
.blocks { min-width: 0; }
</style>

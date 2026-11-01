<script setup lang="ts">
import { ref } from 'vue';
import Icon from './Icon.vue';
defineProps<{ text: string }>();
// Three states would be noisy; use two: a compact scrolling peek (default) and a
// fully expanded view. "收起/展开" toggles between them and the label matches.
const open = ref(false);
function toggle() { open.value = !open.value; }
</script>

<template>
  <div class="thinking" :class="{ 'is-open': open }">
    <button type="button" class="thinking-head" @click="toggle">
      <Icon name="sparkle" :size="14" /><span>思考过程</span>
      <span class="thinking-toggle"><span>{{ open ? '收起' : '展开' }}</span><Icon class="thinking-chevron" name="chevron-down" :size="14" /></span>
    </button>
    <div class="thinking-body">{{ text }}</div>
  </div>
</template>

<style>
.thinking { margin: 10px 0; border: 1px solid var(--line-2); border-radius: 13px; background: var(--surface-2); overflow: hidden; }
.thinking-head { display: flex; align-items: center; gap: 7px; width: 100%; padding: 8px 11px; color: var(--muted); font-size: 11.5px; font-weight: 550; text-align: left; cursor: pointer; transition: background-color var(--fast); }
.thinking-head:hover { background: color-mix(in srgb, var(--text) 3.5%, transparent); }
.thinking-head svg { color: var(--accent); }
.thinking-toggle { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; color: var(--faint); font-size: 10.5px; }
.thinking-chevron { transition: transform var(--dur) var(--ease); }
.thinking.is-open .thinking-chevron { transform: rotate(180deg); }
/* Peek: a short scrollable window with a soft fade. Expanded: taller, no fade. */
.thinking-body { max-height: 5.4em; overflow-y: auto; padding: 0 12px 10px; color: var(--text-2); font-size: 12.5px; line-height: 1.68; white-space: pre-wrap; overflow-wrap: anywhere; -webkit-mask-image: linear-gradient(to bottom, #000 70%, transparent); mask-image: linear-gradient(to bottom, #000 70%, transparent); transition: max-height var(--slow) var(--ease); }
.thinking.is-open .thinking-body { max-height: 460px; -webkit-mask-image: none; mask-image: none; }
</style>

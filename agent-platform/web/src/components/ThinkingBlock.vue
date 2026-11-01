<script setup lang="ts">
import { ref, computed } from 'vue';
import Icon from './Icon.vue';

defineProps<{ text: string }>();

// Initial appearance starts in 'preview' (compact few-line peek).
// First click collapses completely ('collapsed'); next click expands fully ('expanded');
// subsequent clicks toggle 'collapsed' <-> 'expanded' without returning to 'preview'.
const mode = ref<'preview' | 'collapsed' | 'expanded'>('preview');
const isOpen = computed(() => mode.value !== 'collapsed');

function toggle() {
  mode.value = mode.value === 'collapsed' ? 'expanded' : 'collapsed';
}
</script>

<template>
  <div class="thinking" :class="['is-' + mode]">
    <button type="button" class="thinking-head" :aria-expanded="isOpen" @click="toggle">
      <Icon name="sparkle" :size="14" /><span>思考过程</span>
      <span class="thinking-toggle">
        <span>{{ isOpen ? '收起' : '展开' }}</span>
        <Icon class="thinking-chevron" name="chevron-down" :size="14" />
      </span>
    </button>
    <div v-show="mode !== 'collapsed'" class="thinking-body">{{ text }}</div>
  </div>
</template>

<style>
.thinking { margin: 10px 0; border: 1px solid var(--line-2); border-radius: 13px; background: var(--surface-2); overflow: hidden; }
.thinking-head { display: flex; align-items: center; gap: 7px; width: 100%; padding: 8px 12px; color: var(--muted); font-size: 11.5px; font-weight: 550; text-align: left; cursor: pointer; transition: background-color var(--fast); }
.thinking-head:hover { background: color-mix(in srgb, var(--text) 3.5%, transparent); }
.thinking-head > svg { color: var(--accent); }
.thinking-toggle { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; color: var(--faint); font-size: 10.5px; }
.thinking-chevron { transition: transform var(--dur) var(--ease); }
.thinking.is-preview .thinking-chevron,
.thinking.is-expanded .thinking-chevron { transform: rotate(180deg); }

.thinking-body { padding: 0 13px 11px; color: var(--text-2); font-size: 12.5px; line-height: 1.68; white-space: pre-wrap; overflow-wrap: anywhere; }
/* Initial few-line scrollable preview (only on first appearance) */
.thinking.is-preview .thinking-body {
  max-height: 5.6em;
  overflow-y: auto;
  -webkit-mask-image: linear-gradient(to bottom, #000 68%, transparent);
  mask-image: linear-gradient(to bottom, #000 68%, transparent);
}
/* Full expansion after re-opening */
.thinking.is-expanded .thinking-body {
  max-height: none;
  overflow: visible;
  -webkit-mask-image: none;
  mask-image: none;
}
</style>

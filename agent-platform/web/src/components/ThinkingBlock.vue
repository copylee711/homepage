<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import Icon from './Icon.vue';

const props = defineProps<{ text: string }>();
const body = ref<HTMLElement | null>(null);
const follow = ref(true);
function onScroll() { const el = body.value; if (el) follow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }
watch(() => props.text, async () => { if (!follow.value) return; await nextTick(); if (body.value && mode.value === 'preview') body.value.scrollTop = body.value.scrollHeight; }, { immediate: true });

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
      <Icon class="thinking-icon" name="sparkle" :size="13" />
      <span class="thinking-label">思考过程</span>
      <span class="thinking-toggle">
        <span>{{ isOpen ? '收起' : '展开' }}</span>
        <Icon class="thinking-chevron" name="chevron-right" :size="13" />
      </span>
    </button>
    <div v-show="mode !== 'collapsed'" class="thinking-body" ref="body" @scroll.passive="onScroll">{{ text }}</div>
  </div>
</template>

<style>
.thinking {
  margin: 4px 0 13px;
}
.thinking-head {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px 4px 5px;
  margin-left: -5px;
  border-radius: 8px;
  color: var(--muted);
  font-size: 12px;
  font-weight: 540;
  text-align: left;
  cursor: pointer;
  user-select: none;
  transition: background-color var(--fast), color var(--fast);
}
.thinking-head:hover {
  background: color-mix(in srgb, var(--text) 4.5%, transparent);
  color: var(--text-2);
}
.thinking-icon {
  color: var(--muted);
  opacity: 0.85;
}
.thinking-toggle {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: 2px;
  color: var(--faint);
  font-size: 11px;
  font-weight: 480;
}
.thinking-chevron {
  transition: transform var(--dur) var(--ease);
}
.thinking.is-preview .thinking-chevron,
.thinking.is-expanded .thinking-chevron {
  transform: rotate(90deg);
}

.thinking-body {
  margin: 3px 0 2px 9px;
  padding: 1px 8px 2px 13px;
  border-left: 1.5px solid var(--line-2);
  color: var(--muted);
  font-size: 13px;
  line-height: 1.68;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
/* Initial few-line scrollable preview (only on first appearance) */
.thinking.is-preview .thinking-body {
  max-height: 5.5em;
  overflow-y: auto;
  -webkit-mask-image: linear-gradient(to bottom, transparent, #000 20%);
  mask-image: linear-gradient(to bottom, transparent, #000 20%);
}
/* Full expansion after re-opening */
.thinking.is-expanded .thinking-body {
  max-height: none;
  overflow: visible;
  -webkit-mask-image: none;
  mask-image: none;
}
</style>

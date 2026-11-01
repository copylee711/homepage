<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
// @ts-ignore - JS module with no types
import { renderMarkdown } from '../services/markdown.js';
import { copyText } from '../services/clipboard';

const props = defineProps<{ source: string; sources?: boolean; fresh?: boolean }>();
const host = ref<HTMLElement | null>(null);

function render() {
  const el = host.value;
  if (!el) return;
  el.replaceChildren(renderMarkdown(props.source || '', document, { sources: props.sources }));
}

// Delegate copy-code buttons produced by the renderer.
function onClick(event: MouseEvent) {
  const target = event.target as HTMLElement;
  const btn = target.closest('[data-copy-code]') as HTMLElement | null;
  if (!btn) return;
  const code = btn.closest('.code-block')?.querySelector('pre code') as HTMLElement | null;
  copyText(code?.textContent || '').then(ok => {
    btn.textContent = ok ? '已复制' : '复制失败';
    setTimeout(() => { btn.textContent = '复制'; }, 1500);
  });
}

onMounted(render);
watch(() => props.source, render);
</script>

<template>
  <div class="md" ref="host" :class="{ 'is-fresh': fresh }" @click="onClick"></div>
</template>

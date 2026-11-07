<script setup lang="ts">
import { computed } from 'vue';
import SiteIcon from './SiteIcon.vue';
import { siteKey } from '../services/site-icon.mjs';

// Half-overlapping favicon stack, one per distinct host. A web_search row that
// hit six sites shows six icons instead of only the first.
const props = defineProps<{ urls: string[]; max?: number; size?: 'sm' | 'md' }>();
const uniqueUrls = computed(() => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of props.urls || []) {
    const key = siteKey(url) || url;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
});
const visible = computed(() => uniqueUrls.value.slice(0, props.max ?? 4));
const extra = computed(() => Math.max(0, uniqueUrls.value.length - visible.value.length));
const title = computed(() => uniqueUrls.value.map((url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } }).join(' · '));
</script>

<template>
  <span v-if="visible.length" class="site-stack" :class="'is-' + (size || 'sm')" :title="title">
    <SiteIcon v-for="(url, i) in visible" :key="url + i" :url="url" />
    <span v-if="extra" class="site-stack-more">+{{ extra }}</span>
  </span>
</template>

<style>
.site-stack { display: inline-flex; align-items: center; flex: none; vertical-align: middle; }
.site-stack .site-icon {
  position: relative;
  overflow: hidden;
  border-radius: 50%;
  background: var(--surface);
  box-shadow: 0 0 0 1.5px var(--surface);
}
.site-stack .site-icon img {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
}
.site-stack.is-sm .site-icon { width: 16px; height: 16px; }
.site-stack.is-md .site-icon { width: 18px; height: 18px; box-shadow: 0 0 0 2px var(--surface); }
.site-stack .site-icon + .site-icon { margin-left: -5px; }
.site-stack.is-md .site-icon + .site-icon { margin-left: -6px; }
.site-stack-more {
  position: relative;
  margin-left: -4px;
  height: 16px;
  min-width: 16px;
  padding: 0 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: var(--surface-2);
  box-shadow: 0 0 0 1.5px var(--surface);
  color: var(--muted);
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.site-stack.is-md .site-stack-more {
  height: 18px;
  min-width: 18px;
  font-size: 10.5px;
  box-shadow: 0 0 0 2px var(--surface);
}
</style>

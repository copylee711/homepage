<script setup lang="ts">
import { computed } from 'vue';
import SiteIcon from './SiteIcon.vue';

// Half-overlapping favicon stack, one per distinct host. A web_search row that
// hit six sites shows six icons instead of only the first.
const props = defineProps<{ urls: string[]; max?: number; size?: 'sm' | 'md' }>();
const visible = computed(() => props.urls.slice(0, props.max ?? 4));
const extra = computed(() => Math.max(0, props.urls.length - visible.value.length));
const title = computed(() => props.urls.map((url) => { try { return new URL(url).hostname; } catch { return url; } }).join(' · '));
</script>

<template>
  <span v-if="visible.length" class="site-stack" :class="'is-' + (size || 'sm')" :title="title">
    <SiteIcon v-for="(url, i) in visible" :key="url + i" :url="url" />
    <span v-if="extra" class="site-stack-more">+{{ extra }}</span>
  </span>
</template>

<style>
.site-stack { display: inline-flex; align-items: center; flex: none; }
.site-stack .site-icon { border-radius: 50%; background: var(--surface); box-shadow: 0 0 0 1.5px var(--surface); }
.site-stack.is-sm .site-icon { width: 16px; height: 16px; }
.site-stack.is-md .site-icon { width: 18px; height: 18px; box-shadow: 0 0 0 2px var(--surface); }
.site-stack .site-icon + .site-icon { margin-left: -6px; }
.site-stack.is-md .site-icon + .site-icon { margin-left: -7px; }
.site-stack-more { margin-left: 3px; color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
</style>

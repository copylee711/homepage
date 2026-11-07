<script setup lang="ts">
import { computed } from 'vue';
import SiteIcon from './SiteIcon.vue';

const props = defineProps<{ block: any }>();
const pages = computed(() => {
  try {
    const result = typeof props.block.result === 'string' ? JSON.parse(props.block.result) : props.block.result;
    const entries = Array.isArray(result?.results) && result.results.length ? result.results : result?.url ? [result] : [];
    const seen = new Set<string>();
    return entries.flatMap((entry: any) => {
      try {
        const url = new URL(entry.sourceUrl || entry.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || seen.has(url.href)) return [];
        seen.add(url.href);
        return [{ url: url.href, host: url.hostname, title: entry.title || url.pathname === '/' && url.hostname || url.href }];
      } catch { return []; }
    }).slice(0, 8);
  } catch { return []; }
});
</script>

<template>
  <ul v-if="pages.length" class="web-tool-pages">
    <li v-for="page in pages" :key="page.url">
      <a :href="page.url" target="_blank" rel="noopener noreferrer">
        <SiteIcon :url="page.url" />
        <span><strong>{{ page.title }}</strong><small>{{ page.host }}</small></span>
      </a>
    </li>
  </ul>
</template>

<style>
.web-tool-pages { list-style: none; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(210px, 100%), 1fr)); gap: 6px; margin: 8px 0; padding: 0; }
.web-tool-pages a { display: flex; align-items: center; gap: 8px; padding: 7px 9px; border: 1px solid var(--line-2); border-radius: 8px; color: var(--text-2); text-decoration: none; }
.web-tool-pages a:hover { background: var(--surface-2); }
.web-tool-pages a > span:last-child { min-width: 0; }
.web-tool-pages strong, .web-tool-pages small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.web-tool-pages small { color: var(--muted); }
</style>

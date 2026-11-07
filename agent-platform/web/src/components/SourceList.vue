<script setup lang="ts">
import SiteIcon from './SiteIcon.vue';
import Icon from './Icon.vue';
defineProps<{ sources: any[] }>();
</script>
<template>
  <details v-if="sources.length" class="citation-sources">
    <summary>
      <span class="source-icons"><SiteIcon v-for="source in sources.slice(0, 3)" :key="source.url" :url="source.url" /></span>
      <span>参考来源 · {{ sources.length }}</span>
      <Icon name="chevron-right" :size="11" class="sources-chevron" />
    </summary>
    <ol tabindex="0" aria-label="参考来源列表">
      <li v-for="source in sources" :key="source.url">
        <a :href="source.url" target="_blank" rel="noopener noreferrer">
          <span v-if="source.label" class="source-number">{{ source.label }}</span>
          <span class="source-info">
            <strong>{{ source.title || source.host }}</strong>
            <small><SiteIcon :url="source.url" />{{ source.host }}</small>
          </span>
        </a>
      </li>
    </ol>
  </details>
</template>
<style>
.citation-sources {
  margin-top: 14px;
  color: var(--text-2);
  font-size: 12px;
}
.citation-sources summary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  width: fit-content;
  padding: 4px 9px;
  border: 1px solid var(--line-2);
  border-radius: 999px;
  color: var(--muted);
  font-size: 12px;
  user-select: none;
  list-style: none;
  transition: color var(--fast), background-color var(--fast), border-color var(--fast);
}
.citation-sources summary::-webkit-details-marker {
  display: none;
}
.citation-sources summary:hover {
  background: color-mix(in srgb, var(--text) 3.5%, transparent);
  color: var(--text);
  border-color: var(--line-strong);
}
.sources-chevron {
  transition: transform 180ms var(--ease);
  color: var(--faint);
}
.citation-sources[open] .sources-chevron {
  transform: rotate(90deg);
}
.citation-sources ol {
  display: flex;
  flex-direction: row;
  flex-wrap: nowrap;
  gap: 8px;
  list-style: none;
  padding: 4px 2px 10px;
  margin: 8px 0 0;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  -webkit-overflow-scrolling: touch;
  animation: sources-in 180ms var(--ease) both;
}
@keyframes sources-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: none; }
}
.citation-sources li {
  flex: 0 0 220px;
  max-width: min(220px, 78vw);
  min-width: 0;
}
.citation-sources a {
  display: flex;
  gap: 9px;
  padding: 9px 12px;
  border-radius: 10px;
  border: 1px solid var(--line-2);
  background: var(--surface);
  color: inherit;
  text-decoration: none;
  height: 100%;
  transition: background-color var(--fast), border-color var(--fast);
}
.citation-sources a:hover {
  background: color-mix(in srgb, var(--text) 3.5%, transparent);
  border-color: var(--line-strong);
}
.source-info { min-width: 0; flex: 1; }
.citation-sources strong {
  display: block;
  font-size: 12px;
  font-weight: 550;
  line-height: 1.45;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.source-icons { display: inline-flex; gap: 2px; }
.citation-sources small {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
  color: var(--muted);
  font-size: 11px;
}
.source-number {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--text) 7%, transparent);
  color: var(--muted);
  font-size: 10.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
</style>

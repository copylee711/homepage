<script setup lang="ts">
import Icon from './Icon.vue';
defineProps<{ sources: any[] }>();
</script>
<template>
  <details v-if="sources.length" class="citation-sources">
    <summary>
      <Icon name="link" :size="12" />
      <span>参考来源 · {{ sources.length }}</span>
      <Icon name="chevron-right" :size="11" class="sources-chevron" />
    </summary>
    <ol>
      <li v-for="source in sources" :key="source.url">
        <a :href="source.url" target="_blank" rel="noopener noreferrer">
          <span v-if="source.label" class="source-number">{{ source.label }}</span>
          <span class="source-info">
            <strong>{{ source.title || source.host }}</strong>
            <small>{{ source.host }}</small>
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
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr));
  gap: 8px;
  list-style: none;
  padding: 0;
  margin: 10px 0 0;
  animation: sources-in 180ms var(--ease) both;
}
@keyframes sources-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: none; }
}
.citation-sources li { min-width: 0; }
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
.citation-sources small {
  display: block;
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

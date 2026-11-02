<script setup lang="ts">
defineProps<{sources:any[]}>();
</script>
<template>
  <details v-if="sources.length" class="citation-sources" open>
    <summary>来源 · {{sources.length}}</summary>
    <ol><li v-for="source in sources" :key="source.url"><a :href="source.url" target="_blank" rel="noopener noreferrer"><span class="source-number">{{source.label}}</span><span><strong>{{source.title||source.host}}</strong><small>{{source.host}}</small></span></a></li></ol>
  </details>
</template>
<style>
.citation-sources{margin-top:18px;color:var(--text-2);font-size:12px;}.citation-sources summary{display:list-item;cursor:pointer;width:fit-content;padding:6px 10px;border:1px solid var(--line);border-radius:var(--radius-sm);color:var(--muted)}
.citation-sources ol{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(230px,100%),1fr));gap:8px;list-style:none;padding:0;margin:10px 0 0}.citation-sources li{min-width:0}.citation-sources a{display:flex;gap:9px;padding:10px;border-radius:10px;background:var(--surface-2);color:inherit;text-decoration:none;height:100%}.citation-sources a:hover{background:var(--hover)}.citation-sources strong{display:block;font-size:12px;font-weight:550;line-height:1.5;overflow-wrap:anywhere}.citation-sources small{display:block;margin-top:3px;color:var(--muted)}.source-number{color:var(--muted);font-variant-numeric:tabular-nums}
</style>

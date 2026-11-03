<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Icon from './Icon.vue';

const props = defineProps<{ url?: string }>();
const failed = ref(false);
const src = computed(() => {
  try {
    const site = new URL(props.url || '');
    if (site.protocol !== 'https:' && site.protocol !== 'http:') return '';
    return '/api/image?url=' + encodeURIComponent(site.origin + '/favicon.ico');
  } catch { return ''; }
});
watch(src, () => { failed.value = false; });
</script>

<template>
  <span class="site-icon" aria-hidden="true">
    <img v-if="src && !failed" :src="src" alt="" width="16" height="16" loading="lazy" @error="failed = true">
    <Icon v-else name="globe" :size="15" />
  </span>
</template>

<style>
.site-icon { display: inline-grid; flex: none; width: 18px; height: 18px; place-items: center; color: var(--muted); }
.site-icon img { display: block; border-radius: 3px; object-fit: contain; }
</style>

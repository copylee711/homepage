<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { noteFaviconError, noteFaviconLoad, siteHost, watchFavicon } from '../services/site-icon.mjs';

const props = defineProps<{ url?: string }>();
const src = ref('');
const failed = ref(true);
let stop = () => {};

watch(() => siteHost(props.url), (host) => {
  stop();
  stop = watchFavicon(host, (state) => {
    src.value = state.src;
    failed.value = state.failed;
  });
}, { immediate: true });

onBeforeUnmount(() => stop());

function onError(event: Event) {
  const el = event.target as HTMLImageElement | null;
  noteFaviconError(siteHost(props.url), el?.dataset.icon || '');
}
function onLoad(event: Event) {
  const el = event.target as HTMLImageElement | null;
  noteFaviconLoad(siteHost(props.url), el?.dataset.icon || '', { width: el?.naturalWidth || 0, height: el?.naturalHeight || 0 });
}
</script>

<template>
  <span class="site-icon" aria-hidden="true">
    <img
      v-if="src && !failed"
      :key="src"
      :src="src"
      :data-icon="src"
      alt=""
      width="16"
      height="16"
      loading="lazy"
      referrerpolicy="no-referrer"
      @error="onError"
      @load="onLoad"
    >
    <Icon v-else name="globe" :size="15" />
  </span>
</template>

<style>
.site-icon { display: inline-grid; flex: none; width: 18px; height: 18px; place-items: center; color: var(--muted); }
.site-icon img { display: block; border-radius: 3px; object-fit: contain; }
</style>

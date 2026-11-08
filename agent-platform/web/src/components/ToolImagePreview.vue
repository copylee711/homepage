<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { useUi } from '../stores/ui';

const props = defineProps<{ url: string; name: string }>();
const ui = useUi();
const failed = ref(false);
const retry = ref(0);
let retryTimer: ReturnType<typeof setTimeout> | undefined;
watch(() => props.url, () => { clearTimeout(retryTimer); failed.value = false; retry.value = 0; });
onBeforeUnmount(() => clearTimeout(retryTimer));

function onError() {
  failed.value = true;
  if (retry.value || !props.url.startsWith('/api/image?')) return;
  retryTimer = setTimeout(() => { retry.value = Date.now(); failed.value = false; }, 800);
}
function preview() {
  const url = failed.value && props.url.startsWith('/api/image?') ? props.url + '&retry=' + Date.now() : props.url;
  ui.openLightbox({ url, name: props.name });
}
</script>

<template>
  <button
    type="button"
    class="tool-image-preview"
    :aria-label="'预览图片 ' + name"
    :title="'预览图片 ' + name"
    @click="preview"
  >
    <Icon v-if="failed" name="image" :size="13" />
    <img v-else :src="retry ? url + '&retry=' + retry : url" alt="" loading="lazy" decoding="async" @error="onError">
  </button>
</template>

<style scoped>
/* Small enough to sit inside a 26px tool row without stretching it. */
.tool-image-preview { flex: none; width: 32px; height: 20px; padding: 0; border: 1px solid var(--line-2); border-radius: 5px; overflow: hidden; background: var(--surface-2); cursor: zoom-in; display: grid; place-items: center; }
.tool-image-preview img { display: block; width: 100%; height: 100%; object-fit: cover; }
</style>

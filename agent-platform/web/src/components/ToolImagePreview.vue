<script setup lang="ts">
import { ref, watch } from 'vue';
import { useUi } from '../stores/ui';

const props = defineProps<{ url: string; name: string }>();
const ui = useUi();
const failed = ref(false);
watch(() => props.url, () => { failed.value = false; });
</script>

<template>
  <button
    v-if="!failed"
    type="button"
    class="tool-image-preview"
    :aria-label="'预览图片 ' + name"
    :title="'预览图片 ' + name"
    @click="ui.openLightbox({ url, name })"
  >
    <img :src="url" alt="" loading="lazy" decoding="async" @error="failed = true">
  </button>
</template>

<style scoped>
/* Small enough to sit inside a 26px tool row without stretching it. */
.tool-image-preview { flex: none; width: 32px; height: 20px; padding: 0; border: 1px solid var(--line-2); border-radius: 5px; overflow: hidden; background: var(--surface-2); cursor: zoom-in; }
.tool-image-preview img { display: block; width: 100%; height: 100%; object-fit: cover; }
</style>

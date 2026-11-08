<script setup lang="ts">
import { onMounted, ref } from 'vue';
import Icon from './Icon.vue';
import OfficePreview from './OfficePreview.vue';
import { get, setCsrf } from '../services/api';
import type { OpenFileTab } from '../stores/workspace';

// A document can be pulled out into its own browser window, like an artifact:
// the pane keeps following the file and quoting still lands in the main window.
const params = new URLSearchParams(location.search);
const path = ref(params.get('path') || '');
const name = path.value.split('/').pop() || path.value;
const ready = ref(false);
const error = ref('');

const tab: OpenFileTab = {
  path: path.value,
  name,
  size: 0,
  meta: 'Office 文档',
  text: '',
  draft: '',
  revision: null,
  binary: true,
  truncated: false,
  note: '',
  loading: false,
  editing: false,
  saving: false,
  embed: 'office',
  embedUrl: '',
};

onMounted(async () => {
  try {
    const theme = localStorage.getItem('iris-theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  } catch {}
  try {
    const me = await get('/api/me');
    setCsrf(me.csrf);
    ready.value = true;
  } catch {
    error.value = '无法连接 Iris，请确认已登录';
  }
});

function closeWindow() {
  window.close();
}
</script>

<template>
  <div class="office-window">
    <header class="ow-head">
      <Icon name="file-text" :size="15" />
      <span class="ow-name">{{ name }}</span>
      <span class="ow-path" :title="path">{{ path }}</span>
      <button type="button" class="ow-close" title="关闭窗口" aria-label="关闭窗口" @click="closeWindow">
        <Icon name="x" :size="13" />
      </button>
    </header>
    <OfficePreview v-if="ready" :tab="tab" standalone />
    <div v-else-if="error" class="ow-status">{{ error }}</div>
    <div v-else class="ow-status"><span class="spinner"></span>正在载入…</div>
  </div>
</template>

<style scoped>
.office-window { height: 100dvh; display: flex; flex-direction: column; background: var(--surface); color: var(--text); }
.ow-head { flex: none; display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--line); background: var(--surface); }
.ow-name { font-size: 13px; font-weight: 600; }
.ow-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--faint); font-family: var(--font-mono); font-size: 11px; }
.ow-close { flex: none; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; border-radius: 7px; color: var(--muted); }
.ow-close:hover { background: color-mix(in srgb, var(--text) 8%, transparent); color: var(--text); }
.ow-status { flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px; color: var(--muted); font-size: 12.5px; }
</style>

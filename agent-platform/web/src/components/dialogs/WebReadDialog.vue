<script setup lang="ts">
import { ref } from 'vue';
import BaseDialog from './BaseDialog.vue';
import { post } from '../../services/api';
import { useUi } from '../../stores/ui';

const ui = useUi();
const url = ref('');
const busy = ref(false);
const status = ref('');
const statusTone = ref('');
const result = ref<null | { title: string; url: string; text: string }>(null);

async function fetchPage() {
  const value = url.value.trim();
  if (!/^https?:\/\//i.test(value)) { status.value = '请输入 http(s) 网址。'; statusTone.value = 'is-error'; return; }
  busy.value = true; status.value = '正在抓取…'; statusTone.value = '';
  try {
    const r = await post('/api/web-read', { url: value });
    result.value = { title: r.title || value, url: r.url || value, text: r.text || '' };
    status.value = ''; statusTone.value = '';
  } catch (e: any) { status.value = e.message; statusTone.value = 'is-error'; result.value = null; }
  finally { busy.value = false; }
}
function insert() {
  if (!result.value) return;
  const block = '以下是网页「' + result.value.title + '」(' + result.value.url + ') 的内容：\n\n' + result.value.text;
  const el = document.querySelector('.composer textarea') as HTMLTextAreaElement | null;
  if (el) { el.value = (el.value ? el.value + '\n\n' : '') + block; el.dispatchEvent(new Event('input', { bubbles: true })); }
  ui.closeDialog(); ui.toast('已插入网页内容作为上下文', { tone: 'success' });
}
</script>

<template>
  <BaseDialog title="网页阅读" subtitle="经受校验的出口代理抓取网页纯文本，脚本不执行。可将内容插入输入框作为上下文。">
    <form class="webread-bar" @submit.prevent="fetchPage">
      <label class="field webread-url"><span class="sr-only">网址</span>
        <input v-model="url" type="url" inputmode="url" placeholder="https://example.com/article" autocomplete="off" spellcheck="false">
      </label>
      <button class="btn btn-solid" :disabled="busy">抓取</button>
    </form>
    <p v-if="status" class="provider-status" :class="statusTone">{{ status }}</p>
    <article v-if="result" class="webread-body">
      <header class="webread-result-head">
        <h3>{{ result.title }}</h3>
        <a class="md-link" :href="result.url" target="_blank" rel="noopener noreferrer">{{ result.url }}</a>
      </header>
      <pre class="preview-body">{{ result.text }}</pre>
    </article>
    <div class="dialog-actions"><button class="btn btn-quiet" :disabled="!result" @click="insert">插入为上下文</button></div>
  </BaseDialog>
</template>

<style>
.webread-bar { display: flex; gap: 9px; }
.webread-url { flex: 1; }
.webread-body { margin-top: 13px; border: 1px solid var(--line-2); border-radius: 14px; overflow: hidden; }
.webread-result-head { padding: 12px 14px; border-bottom: 1px solid var(--line); background: var(--surface-2); }
.webread-result-head h3 { margin: 0 0 3px; font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.webread-result-head a { font-size: 11px; overflow-wrap: anywhere; }
.webread-body .preview-body { max-height: 42vh; margin: 0; padding: 12px 14px; overflow: auto; background: var(--code-bg); font-family: var(--font-mono); font-size: 11.5px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>

<script setup lang="ts">
import { computed } from 'vue';
import Icon from './Icon.vue';
import MarkdownView from './MarkdownView.vue';
import BlockList from './BlockList.vue';
import { formatClock, textContent, normalizeBlocks } from '../services/format';
import { copyText } from '../services/clipboard';
import { useUi } from '../stores/ui';
import { useSession } from '../stores/session';

const props = defineProps<{ message: any; toolResults?: Record<string, any> }>();
const ui = useUi();
const isUser = computed(() => props.message.role === 'user');
const userText = computed(() => textContent(props.message.content));
const blocks = computed(() => normalizeBlocks(props.message.content, props.toolResults));
const time = computed(() => formatClock(props.message.timestamp || Date.now()));

function plainText() {
  return isUser.value ? userText.value : blocks.value.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n\n');
}
function copyMsg() {
  copyText(plainText()).then(ok => ui.toast(ok ? '已复制消息' : '复制失败', { tone: ok ? 'success' : 'error' }));
}
function onContext(e: MouseEvent) {
  // Let the browser's native menu handle an active text selection.
  if ((window.getSelection()?.toString() || '').trim()) return;
  ui.openContext(e, [
    { icon: 'copy', label: '复制消息', action: copyMsg },
    { icon: 'corner-down-left', label: '引用到输入框', action: quote },
    isUser ? { icon: 'refresh', label: '重新发送', action: resend } : null,
  ]);
}
function quote() {
  const el = document.querySelector('.composer textarea') as HTMLTextAreaElement | null;
  if (!el) return;
  const q = plainText().split('\n').map(l => '> ' + l).join('\n');
  el.value = (el.value ? el.value + '\n\n' : '') + q + '\n\n';
  el.dispatchEvent(new Event('input', { bubbles: true })); el.focus();
}
function resend() { if (isUser.value) useSession().send(userText.value, { retry: true }); }
</script>

<template>
  <article class="message" :class="isUser ? 'message-user' : 'message-assistant'" @contextmenu="onContext">
    <div v-if="!isUser" class="message-avatar"><Icon name="iris" :size="18" /></div>
    <div class="message-inner">
      <div class="message-meta">
        <strong class="message-author">{{ isUser ? '你' : 'Iris' }}</strong>
        <time class="message-time">{{ time }}</time>
        <button class="message-action" aria-label="复制" title="复制" @click="copyMsg"><Icon name="copy" :size="15" /></button>
      </div>
      <div v-if="isUser" class="user-bubble"><MarkdownView :source="userText" /></div>
      <div v-else class="message-content"><BlockList :blocks="blocks" /></div>
    </div>
  </article>
</template>

<style>
.message { min-width: 0; display: flex; align-items: flex-start; gap: 13px; animation: msg-in 300ms var(--ease) both; }
@keyframes msg-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
.message-avatar { width: 26px; height: 26px; flex: none; display: grid; place-items: center; margin-top: 22px; color: var(--ink); }
.message-inner { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.message-user { justify-content: flex-end; }
.message-user .message-inner { flex: 0 1 auto; align-items: flex-end; max-width: min(82%, 640px); }
.message-meta { min-height: 18px; display: flex; align-items: center; gap: 7px; margin-bottom: 6px; color: var(--muted); font-size: 11px; }
.message-author { font-size: 12px; font-weight: 600; color: var(--text-2); }
.message-time { color: var(--faint); font-size: 10.5px; font-variant-numeric: tabular-nums; }
.message-action { display: inline-flex; align-items: center; gap: 4px; height: 25px; padding: 0 7px; border-radius: 7px; color: var(--muted); font-size: 10.5px; opacity: 0; transition: opacity var(--fast), background-color var(--fast), color var(--fast); }
.message:hover .message-action { opacity: 1; }
.message-action:hover { background: color-mix(in srgb, var(--text) 7%, transparent); color: var(--text); }
.user-bubble { max-width: 100%; padding: 11px 15px; border-radius: 18px 18px 5px 18px; background: var(--surface-2); border: 1px solid var(--line-2); color: var(--text); font-size: 15px; line-height: 1.7; overflow-wrap: anywhere; }
.message-content { min-width: 0; width: 100%; color: var(--text); font-size: 15px; line-height: 1.74; overflow-wrap: anywhere; }
@media (max-width: 860px) { .message-action { opacity: 0.7; } }
</style>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';
import MarkdownView from './MarkdownView.vue';
import BlockList from './BlockList.vue';
import { formatClock, textContent, normalizeBlocks } from '../services/format';
import { copyText } from '../services/clipboard';
import { useUi } from '../stores/ui';
import { useSession } from '../stores/session';

const props = defineProps<{ message: any; toolResults?: Record<string, any> }>();
const ui = useUi();
const session = useSession();
const isUser = computed(() => props.message.role === 'user');
const userRawText = computed(() => textContent(props.message.content));
const blocks = computed(() => normalizeBlocks(props.message.content, props.toolResults));
const time = computed(() => formatClock(props.message.timestamp || Date.now()));

const rootRef = ref<HTMLElement | null>(null);
const contentRef = ref<HTMLElement | null>(null);
const copied = ref(false);
const quoteTooltip = ref<{ visible: boolean; x: number; y: number; text: string }>({
  visible: false, x: 0, y: 0, text: '',
});

function isImage(name: string) {
  return /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(name || '');
}

const REF_BLOCK_RE = /^【工作区引用文件】\n((?:- `?\/workspace\/[^\n]+`?\n?)+)\n*/;
const QUOTE_BLOCK_RE = /(?:^|\n\n)【引用内容】\n((?:> [^\n]+\n?)+)/;

const parsedUserRefs = computed(() => {
  if (Array.isArray(props.message?.refs) && props.message.refs.length) {
    return props.message.refs.map((r: any) => {
      const p = typeof r === 'string' ? r : r.path;
      const clean = String(p || '').replace(/^\/workspace\/?/, '');
      return {
        path: clean,
        name: (typeof r === 'object' && r.name) || clean.split('/').pop() || clean,
        isDir: (typeof r === 'object' && r.type === 'dir') || clean.endsWith('/'),
        dir: clean.includes('/') ? clean.split('/').slice(0, -1).join('/') : '',
      };
    });
  }
  const match = userRawText.value.match(REF_BLOCK_RE);
  if (!match) return [];
  const lines = match[1].split('\n').filter(Boolean);
  return lines.map((l: string) => {
    const rawPath = l.replace(/^-\s*`?/, '').replace(/`?\s*$/, '');
    const clean = rawPath.replace(/^\/workspace\/?/, '');
    return {
      path: clean,
      name: clean.split('/').pop() || clean,
      isDir: clean.endsWith('/'),
      dir: clean.includes('/') ? clean.split('/').slice(0, -1).join('/') : '',
    };
  });
});

const parsedUserQuotes = computed(() => {
  if (Array.isArray(props.message?.quotes) && props.message.quotes.length) {
    return props.message.quotes;
  }
  const match = userRawText.value.match(QUOTE_BLOCK_RE);
  if (!match) return [];
  const rawQuoted = match[1];
  const items = rawQuoted.split(/\n+(?=> )/).filter(Boolean);
  return items.map((b, idx) => ({
    id: 'q_' + idx,
    text: b.split('\n').map(l => l.replace(/^>\s?/, '')).join('\n').trim(),
    source: '引用内容',
  })).filter(q => q.text);
});

const userDisplayText = computed(() => {
  let txt = userRawText.value.replace(REF_BLOCK_RE, '');
  txt = txt.replace(QUOTE_BLOCK_RE, '');
  return txt.trim();
});

function plainText() {
  return isUser.value ? (userDisplayText.value || userRawText.value) : blocks.value.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n\n');
}

function copyMsg() {
  copyText(plainText()).then(ok => {
    if (ok) {
      copied.value = true;
      setTimeout(() => { copied.value = false; }, 2000);
      ui.toast('已复制回答', { tone: 'success' });
    } else {
      ui.toast('复制失败', { tone: 'error' });
    }
  });
}

async function retryMsg() {
  if (session.busy) return;
  ui.toast('正在重新生成回答…');
  await session.retryFromMessage(props.message);
}

async function rewindMsg() {
  if (session.busy) return;
  await session.rewindFromMessage(props.message);
  ui.toast('已回退对话，可重新编辑提问', { tone: 'success' });
}

async function forkMsg() {
  if (session.busy) return;
  const res = await session.forkFromMessage(props.message);
  if (res) {
    ui.toast(`已分叉出新任务：${res.title}`, { tone: 'success' });
  }
}

function handleMouseUp() {
  if (isUser.value) return;
  setTimeout(() => {
    const sel = window.getSelection();
    const txt = (sel?.toString() || '').trim();
    if (!txt || txt.length < 2 || !contentRef.value?.contains(sel?.anchorNode || null)) {
      quoteTooltip.value.visible = false;
      return;
    }
    const range = sel!.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const parentRect = rootRef.value?.getBoundingClientRect();
    if (!parentRect || (rect.width === 0 && rect.height === 0)) {
      quoteTooltip.value.visible = false;
      return;
    }
    quoteTooltip.value = {
      visible: true,
      x: rect.left + rect.width / 2 - parentRect.left,
      y: Math.max(0, rect.top - parentRect.top - 36),
      text: txt,
    };
  }, 10);
}

function onSelectionChange() {
  if (!quoteTooltip.value.visible) return;
  const sel = window.getSelection();
  const txt = (sel?.toString() || '').trim();
  if (!txt) quoteTooltip.value.visible = false;
}

function applySelectionQuote() {
  if (!quoteTooltip.value.text) return;
  session.addTextQuote(quoteTooltip.value.text, 'Iris 的回答');
  ui.toast('已引用选中内容到输入框', { tone: 'success' });
  quoteTooltip.value.visible = false;
  window.getSelection()?.removeAllRanges();
  const el = document.querySelector('.composer textarea') as HTMLTextAreaElement | null;
  el?.focus();
}

onMounted(() => {
  document.addEventListener('selectionchange', onSelectionChange);
});
onBeforeUnmount(() => {
  document.removeEventListener('selectionchange', onSelectionChange);
});

function onContext(e: MouseEvent) {
  const selText = (window.getSelection()?.toString() || '').trim();
  if (selText && !isUser.value && contentRef.value?.contains(window.getSelection()?.anchorNode || null)) {
    ui.openContext(e, [
      {
        icon: 'corner-down-left',
        label: '引用选中内容到输入框',
        action: () => {
          session.addTextQuote(selText, 'Iris 的回答');
          ui.toast('已引用选中内容到输入框', { tone: 'success' });
          window.getSelection()?.removeAllRanges();
          quoteTooltip.value.visible = false;
        },
      },
      { icon: 'copy', label: '复制选中文字', action: () => copyText(selText) },
    ]);
    return;
  }
  ui.openContext(e, [
    { icon: 'copy', label: '复制完整回答', action: copyMsg },
    {
      icon: 'corner-down-left',
      label: '引用整条消息到输入框',
      action: () => {
        session.addTextQuote(plainText(), isUser.value ? '你的提问' : 'Iris 的回答');
        ui.toast('已引用到输入框', { tone: 'success' });
      },
    },
    !isUser.value ? { icon: 'refresh', label: '重试回答', action: retryMsg } : null,
    !isUser.value ? { icon: 'rotate-ccw', label: '回退对话', action: rewindMsg } : null,
    !isUser.value ? { icon: 'git-branch', label: '分叉对话', action: forkMsg } : null,
    isUser.value ? { icon: 'refresh', label: '重新发送', action: resend } : null,
  ]);
}
function resend() { if (isUser.value) useSession().send(userDisplayText.value || userRawText.value, { retry: true }); }
</script>

<template>
  <article
    ref="rootRef"
    class="message"
    :class="isUser ? 'message-user' : 'message-assistant'"
    @contextmenu="onContext"
    @mouseup="handleMouseUp"
  >
    <!-- Floating quote-selection tooltip button -->
    <button
      v-if="quoteTooltip.visible"
      type="button"
      class="quote-selection-tip"
      :style="{ left: quoteTooltip.x + 'px', top: quoteTooltip.y + 'px' }"
      aria-label="引用选中内容"
      @mousedown.prevent
      @click="applySelectionQuote"
    >
      <Icon name="corner-down-left" :size="12" />
      <span>引用</span>
    </button>

    <div v-if="!isUser" class="message-avatar"><Icon name="iris" :size="18" /></div>
    <div class="message-inner">
      <div v-if="!isUser" class="message-meta">
        <strong class="message-author">Iris</strong>
      </div>
      <div v-if="isUser" class="user-bubble">
        <!-- GPT-style quoted text preview cards inside user bubble -->
        <div v-if="parsedUserQuotes.length" class="user-bubble-quotes">
          <div v-for="q in parsedUserQuotes" :key="q.id || q.text" class="user-bubble-quote-card">
            <div class="user-bubble-quote-text">{{ q.text }}</div>
            <div class="user-bubble-quote-meta">
              <Icon name="message" :size="10" />
              <span>{{ q.source || '引用内容' }}</span>
            </div>
          </div>
        </div>

        <!-- Referenced workspace file badges -->
        <div v-if="parsedUserRefs.length" class="user-bubble-chips">
          <span
            v-for="r in parsedUserRefs"
            :key="r.path"
            class="user-bubble-chip"
            :class="{ 'is-image': isImage(r.name) }"
            :title="isImage(r.name) ? '点击放大预览 · /workspace/' + r.path : '/workspace/' + r.path"
            @click="isImage(r.name) && ui.openLightbox({ url: '/api/files/download?path=' + encodeURIComponent(r.path) + '&inline=1', name: r.name })"
          >
            <Icon :name="isImage(r.name) ? 'image' : (r.isDir ? 'folder' : 'file')" :size="12" />
            <span class="user-chip-name">{{ r.name }}</span>
            <span v-if="r.dir" class="user-chip-dir">{{ r.dir }}</span>
          </span>
        </div>

        <MarkdownView v-if="userDisplayText" :source="userDisplayText" />
      </div>
      <div v-if="isUser" class="user-bubble-footer"><time class="user-bubble-time">{{ time }}</time></div>
      <div v-if="!isUser" class="assistant-body">
        <div ref="contentRef" class="message-content"><BlockList :blocks="blocks" /></div>
        <footer class="assistant-footer">
          <div class="assistant-actions">
            <button
              type="button"
              class="msg-action-btn"
              :title="copied ? '已复制' : '复制回答'"
              :aria-label="copied ? '已复制' : '复制回答'"
              @click="copyMsg"
            >
              <Icon :name="copied ? 'check' : 'copy'" :size="13.5" />
              <span v-if="copied" class="msg-action-label">已复制</span>
            </button>
            <button
              type="button"
              class="msg-action-btn"
              title="重试 (重新生成本轮回答)"
              aria-label="重试"
              :disabled="session.busy"
              @click="retryMsg"
            >
              <Icon name="refresh" :size="13.5" />
            </button>
            <button
              type="button"
              class="msg-action-btn"
              title="回退到此处 (撤销后续对话并重新编辑此提问)"
              aria-label="回退到此处"
              :disabled="session.busy"
              @click="rewindMsg"
            >
              <Icon name="rotate-ccw" :size="13.5" />
            </button>
            <button
              type="button"
              class="msg-action-btn"
              title="分叉对话 (以此处为基础创建新分支)"
              aria-label="分叉对话"
              :disabled="session.busy"
              @click="forkMsg"
            >
              <Icon name="git-branch" :size="13.5" />
            </button>
          </div>
          <time class="assistant-time" :title="new Date(props.message.timestamp || Date.now()).toLocaleString()">
            {{ time }}
          </time>
        </footer>
      </div>
    </div>
  </article>
</template>

<style>
.message { position: relative; min-width: 0; display: flex; align-items: flex-start; gap: 11px; animation: msg-in 300ms var(--ease) both; }
@keyframes msg-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
.message-avatar { width: 24px; height: 24px; flex: none; display: grid; place-items: center; margin-top: 0; color: var(--ink); }
.message-inner { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.message-user { justify-content: flex-end; }
.message-user .message-inner { flex: 0 1 auto; align-items: flex-end; max-width: min(82%, 640px); }
.message-meta { min-height: 22px; display: flex; align-items: center; gap: 7px; margin-bottom: 4px; color: var(--muted); font-size: 11px; }
.message-author { font-size: 12px; font-weight: 600; color: var(--text-2); }

/* Floating selection quote tooltip (like ChatGPT / Notion quote) */
.quote-selection-tip {
  position: absolute;
  transform: translateX(-50%);
  z-index: 28;
  height: 28px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 10px 0 8px;
  border-radius: 999px;
  background: var(--ink);
  color: var(--surface);
  font-size: 12px;
  font-weight: 560;
  box-shadow: var(--shadow-md);
  user-select: none;
  cursor: pointer;
  animation: quote-tip-in 140ms cubic-bezier(0.16, 1, 0.3, 1);
  transition: transform var(--fast), filter var(--fast);
}
.quote-selection-tip:hover { filter: brightness(1.15); transform: translateX(-50%) translateY(-1px); }
.quote-selection-tip:active { transform: translateX(-50%) scale(0.96); }
.quote-selection-tip::after {
  content: '';
  position: absolute;
  bottom: -4px;
  left: 50%;
  transform: translateX(-50%);
  border-width: 4px 4px 0 4px;
  border-style: solid;
  border-color: var(--ink) transparent transparent transparent;
}
@keyframes quote-tip-in {
  from { opacity: 0; transform: translateX(-50%) translateY(4px) scale(0.92); }
  to { opacity: 1; transform: translateX(-50%) none; }
}

.user-bubble { max-width: 100%; padding: 10px 15px 8px; border-radius: 18px 18px 5px 18px; background: color-mix(in srgb, var(--text) 4.8%, var(--surface)); color: var(--text); font-size: 15px; line-height: 1.7; overflow-wrap: anywhere; }

/* GPT-style quoted cards inside user message bubble */
.user-bubble-quotes { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.user-bubble-quote-card {
  max-width: min(100%, 280px);
  padding: 7px 11px 6px;
  border-radius: 11px;
  background: color-mix(in srgb, var(--surface) 82%, transparent);
  border: 1px solid color-mix(in srgb, var(--text) 11%, transparent);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.02);
}
.user-bubble-quote-text {
  color: var(--text-2);
  font-size: 11.5px;
  line-height: 1.5;
  white-space: pre-line;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.user-bubble-quote-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  color: var(--muted);
  font-size: 10px;
  user-select: none;
}

.user-bubble-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 7px; }
.user-bubble-chip { display: inline-flex; align-items: center; gap: 5px; max-width: 240px; height: 24px; padding: 0 7px; border-radius: 6px; background: color-mix(in srgb, var(--text) 7.5%, transparent); color: var(--text); font-size: 11.5px; font-weight: 520; user-select: none; transition: background-color var(--fast), color var(--fast); }
.user-bubble-chip.is-image { cursor: pointer; }
.user-bubble-chip.is-image:hover { background: color-mix(in srgb, var(--text) 14%, transparent); }
.user-chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.user-chip-dir { color: var(--muted); font-size: 10px; opacity: 0.75; }

.user-bubble-footer { display: flex; justify-content: flex-end; margin-top: 4px; }
.user-bubble-time { font-size: 10px; color: color-mix(in srgb, var(--text) 44%, transparent); font-variant-numeric: tabular-nums; user-select: none; }

.assistant-body { width: 100%; min-width: 0; display: flex; flex-direction: column; }
.message-content { min-width: 0; width: 100%; color: var(--text); font-size: 15px; line-height: 1.74; overflow-wrap: anywhere; }

/* Editorial assistant footer: action buttons + timestamp */
.assistant-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 10px;
  min-height: 28px;
}
.assistant-actions {
  display: flex;
  align-items: center;
  gap: 3px;
  opacity: 0;
  transition: opacity var(--fast);
}
.message:hover .assistant-actions,
.message:focus-within .assistant-actions {
  opacity: 1;
}
.msg-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 7px;
  border-radius: 7px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 500;
  transition: background-color var(--fast), color var(--fast);
}
.msg-action-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--text) 6.5%, transparent);
  color: var(--text);
}
.msg-action-btn:disabled {
  opacity: 0.35;
}
.msg-action-label {
  color: var(--ok);
  font-size: 11px;
}
.assistant-time {
  flex: none;
  color: var(--faint);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  user-select: none;
}

@media (max-width: 860px) {
  .assistant-actions { opacity: 0.85; }
}
</style>

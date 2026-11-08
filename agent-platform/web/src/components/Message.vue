<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';
import BrandMark from './BrandMark.vue';
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
const turnState = computed(() => props.message._vm || null);
// An interrupted turn keeps its reason on the message (live view-model while
// streaming, note attached from the server after a reload). Never silent.
const failure = computed(() => String(props.message.error || turnState.value?.error || ''));
const stopped = computed(() => props.message.stopped === true || turnState.value?.stopped === true);
const outputLimited = computed(() => props.message.stopReason === 'length' || turnState.value?.stopReason === 'length');
const time = computed(() => formatClock(props.message.timestamp || Date.now()));

const durationText = computed(() => {
  if (isUser.value) return '';
  let ms = Number(props.message.durationMs) || 0;
  if (!ms && props.message.timestamp) {
    const list = session.messages || [];
    const idx = list.findIndex((m: any) => m === props.message || (m.timestamp === props.message.timestamp && m.role === 'assistant'));
    if (idx > 0) {
      for (let i = idx - 1; i >= 0; i--) {
        if (list[i]?.role === 'user' && list[i]?.timestamp) {
          const diff = props.message.timestamp - list[i].timestamp;
          if (diff > 0 && diff < 3600000) {
            ms = diff;
            break;
          }
        }
      }
    }
  }
  if (!ms || ms <= 0) return '';
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}分${secs ? ' ' + secs + '秒' : ''}`;
});

const rootRef = ref<HTMLElement | null>(null);
const contentRef = ref<HTMLElement | null>(null);
const copied = ref(false);
const quoteTooltip = ref<{ visible: boolean; x: number; y: number; text: string }>({
  visible: false, x: 0, y: 0, text: '',
});

function isImage(name: string) {
  return /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(name || '');
}

function previewRef(r: any) {
  if (!isImage(r.name)) return;
  const url = r.previewUrl || (r.path ? '/api/files/download?path=' + encodeURIComponent(r.path) + '&inline=1' : '');
  if (url) ui.openLightbox({ url, name: r.name });
}

function refTitle(r: any) {
  if (isImage(r.name)) return '点击放大预览' + (r.inline || !r.path ? '' : ' · /workspace/' + r.path);
  return r.inline ? r.name : '/workspace/' + r.path;
}

const REF_BLOCK_RE = /^【工作区引用文件】\n((?:- `?\/workspace\/[^\n]+`?\n?)+)\n*/;
const QUOTE_BLOCK_RE = /(?:^|\n\n)【引用内容】\n(> [^\n]*(?:\n(?:\n)?(?=> )> [^\n]*)*)/;

function refRecord(raw: any) {
  const p = typeof raw === 'string' ? raw : raw?.path;
  const clean = String(p || '').replace(/^\/workspace\/?/, '');
  const inline = typeof raw === 'object' && raw?.inline === true;
  const name = (typeof raw === 'object' && raw?.name) || clean.split('/').pop() || clean;
  return {
    path: clean,
    name,
    type: typeof raw === 'object' ? raw?.type : undefined,
    previewUrl: typeof raw === 'object' ? raw?.previewUrl : undefined,
    inline,
    isDir: (typeof raw === 'object' && raw?.type === 'dir') || (!inline && clean.endsWith('/')),
    dir: inline || !clean.includes('/') ? '' : clean.split('/').slice(0, -1).join('/'),
  };
}
const parsedUserRefs = computed(() => {
  if (Array.isArray(props.message?.refs) && props.message.refs.length) {
    return props.message.refs.map(refRecord).filter((r: { path: string; previewUrl?: string; inline?: boolean }) => r.path || r.previewUrl || r.inline);
  }
  const match = userRawText.value.match(REF_BLOCK_RE);
  if (!match) return [];
  return match[1].split('\n').filter(Boolean).map((l: string) => {
    const rawPath = l.replace(/^-\s*`?/, '').replace(/`?\s*$/, '');
    return refRecord(rawPath);
  }).filter((r: { path: string }) => r.path);
});
const inlineImages = computed(() => {
  const message = props.message;
  const hasImageRefs = parsedUserRefs.value.some(isImageRef);
  const content = Array.isArray(message?.content) ? message.content : hasImageRefs ? [] : message?._promptImages;
  if (!Array.isArray(content)) return [] as Array<{ key: string; url: string; name: string }>;
  const out: Array<{ key: string; url: string; name: string }> = [];
  content.forEach((part: any, index: number) => {
    if (!part || part.type !== 'image') return;
    const mime = part.mimeType || part.mime || 'image/png';
    const data = part.data || part.source?.data;
    if (typeof data === 'string' && data) {
      out.push({ key: 'inline-' + index, name: part.name || '图片', url: data.startsWith('data:') ? data : `data:${mime};base64,${data}` });
    } else if (typeof part.url === 'string' && part.url) {
      out.push({ key: 'inline-' + index, name: part.name || '图片', url: part.url });
    }
  });
  return out;
});
function fileUrl(path: string) {
  return '/api/files/download?path=' + encodeURIComponent(path) + '&inline=1';
}
function isImageRef(r: { name?: string; type?: string; previewUrl?: string }) {
  return r.type === 'image' || !!r.previewUrl || isImage(r.name || '');
}
const imageAttachments = computed(() => {
  const fromRefs = parsedUserRefs.value.filter(isImageRef).map((r: any) => ({
    key: r.path || r.name,
    url: r.previewUrl || fileUrl(r.path),
    name: r.name,
    path: r.path,
  }));
  return [...fromRefs, ...inlineImages.value.map(img => ({ ...img, path: '' }))];
});
const fileAttachments = computed(() => parsedUserRefs.value.filter((r: any) => !isImageRef(r)));

const parsedUserQuotes = computed(() => {
  if (Array.isArray(props.message?.quotes) && props.message.quotes.length) {
    return props.message.quotes;
  }
  const match = userRawText.value.match(QUOTE_BLOCK_RE);
  if (!match) return [];
  const rawQuoted = match[1];
  const items = rawQuoted.split(/\n(?:> \n|\n)(?=> )/).filter(Boolean);
  return items.map((b, idx) => ({
    id: 'q_' + idx,
    text: b.split('\n').map(l => l.replace(/^>\s?/, '')).join('\n').trim(),
    source: '引用内容',
  })).filter(q => q.text);
});

const userDisplayText = computed(() => {
  let txt = userRawText.value.replace(REF_BLOCK_RE, '');
  txt = txt.replace(QUOTE_BLOCK_RE, '');
  txt = txt.trim();
  // Older image-only sends stored a filler sentence as the whole prompt.
  if (imageAttachments.value.length && txt === '请查看并分析我发送的图片。') return '';
  if ((imageAttachments.value.length || parsedUserQuotes.value.length || parsedUserRefs.value.length) && txt === '请根据以上引用内容进行分析并回答。') return '';
  return txt;
});

function plainText() {
  return isUser.value ? (userDisplayText.value || userRawText.value) : blocks.value.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n\n');
}

function copyMsg() {
  copyText(plainText()).then(ok => {
    if (ok) {
      copied.value = true;
      setTimeout(() => { copied.value = false; }, 2000);
      ui.toast(isUser.value ? '已复制消息' : '已复制回答', { tone: 'success' });
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
    { icon: 'copy', label: isUser.value ? '复制消息' : '复制完整回答', action: copyMsg },
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

    <div v-if="!isUser" class="message-avatar"><BrandMark :size="18" /></div>
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

        <div v-if="imageAttachments.length" class="user-bubble-images">
          <button
            v-for="img in imageAttachments"
            :key="img.key"
            type="button"
            class="user-bubble-image"
            :title="'点击放大预览' + (img.name ? ' · ' + img.name : '')"
            @click="ui.openLightbox({ url: img.path ? fileUrl(img.path) : img.url, name: img.name || '图片' })"
          >
            <img :src="img.url" :alt="img.name || '图片'" />
          </button>
        </div>

        <!-- Referenced workspace files that are not images -->
        <div v-if="fileAttachments.length" class="user-bubble-chips">
          <span
            v-for="r in fileAttachments"
            :key="r.path"
            class="user-bubble-chip"
            :class="{ 'is-image': isImage(r.name) }"
            :title="refTitle(r)"
            @click="previewRef(r)"
          >
            <img v-if="r.previewUrl" :src="r.previewUrl" alt="" class="user-chip-thumb" />
            <Icon v-else :name="isImage(r.name) ? 'image' : (r.isDir ? 'folder' : 'file')" :size="12" />
            <span class="user-chip-name">{{ r.name }}</span>
            <span v-if="r.dir" class="user-chip-dir">{{ r.dir }}</span>
          </span>
        </div>

        <MarkdownView v-if="userDisplayText" :source="userDisplayText" />
      </div>
      <div v-if="isUser" class="user-actions">
        <button
          type="button"
          class="msg-action-btn"
          :title="copied ? '已复制' : '复制消息'"
          :aria-label="copied ? '已复制' : '复制消息'"
          @click="copyMsg"
        >
          <Icon :name="copied ? 'check' : 'copy'" :size="13" />
          <span v-if="copied" class="msg-action-label">已复制</span>
        </button>
      </div>
      <div v-if="!isUser" class="assistant-body">
        <div ref="contentRef" class="message-content"><BlockList :blocks="blocks" /></div>
        <div v-if="failure" class="assistant-failure" role="alert">
          <Icon class="assistant-failure-icon" name="alert-circle" :size="14" />
          <span class="assistant-failure-text">{{ failure }}</span>
          <button
            type="button"
            class="assistant-retry"
            :disabled="session.busy"
            title="重新生成本轮回答"
            @click="retryMsg"
          >
            <Icon name="refresh" :size="12" />
            <span>重试</span>
          </button>
        </div>
        <p v-else-if="!blocks.length && stopped" class="assistant-note">已停止生成</p>
        <p v-else-if="!blocks.length" class="assistant-note">这次没有收到模型回复。如果发送了图片或附件，可能是当前模型不支持这类输入，换一个模型或补充文字说明后再试。</p>
        <p v-if="outputLimited" class="assistant-limit">输出已达上限，可继续</p>
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
          <div class="assistant-meta-time">
            <span v-if="durationText" class="assistant-duration" :title="'本轮耗时 ' + durationText">耗时 {{ durationText }}</span>
            <span class="assistant-meta-dot" aria-hidden="true">·</span>
            <time class="assistant-time" :title="new Date(props.message.timestamp || Date.now()).toLocaleString()">
              {{ time }}
            </time>
          </div>
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

.user-bubble-images { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
.user-bubble-image { padding: 0; border: 0; border-radius: 12px; overflow: hidden; background: color-mix(in srgb, var(--text) 4%, transparent); cursor: pointer; max-width: min(100%, 280px); }
.user-bubble-image img { display: block; width: auto; max-width: 100%; max-height: 220px; object-fit: contain; }
.user-bubble-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 7px; }
.user-bubble-chip { display: inline-flex; align-items: center; gap: 5px; max-width: 240px; height: 24px; padding: 0 7px; border-radius: 6px; background: color-mix(in srgb, var(--text) 7.5%, transparent); color: var(--text); font-size: 11.5px; font-weight: 520; user-select: none; transition: background-color var(--fast), color var(--fast); }
.user-bubble-chip.is-image { cursor: pointer; }
.user-bubble-chip.is-image:hover { background: color-mix(in srgb, var(--text) 14%, transparent); }
.user-chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.user-chip-thumb { width: 16px; height: 16px; flex: none; border-radius: 4px; object-fit: cover; }
.user-chip-dir { color: var(--muted); font-size: 10px; opacity: 0.75; }

/* Assistant footer: quiet action row plus a single muted meta line */
.assistant-note { margin: 2px 0 0; color: var(--muted); font-size: 12.5px; line-height: 1.6; }
.assistant-note.is-error { color: var(--danger); }
/* Interrupted turn: reason + the retry that used to hide in the hover footer. */
.assistant-failure {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 8px 0 0;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--danger) 26%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--danger) 7%, transparent);
  color: var(--danger);
  font-size: 12.5px;
  line-height: 1.55;
}
.assistant-failure-icon { flex: none; margin-top: 1px; }
.assistant-failure-text { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.assistant-retry {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 9px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--danger) 13%, transparent);
  color: var(--danger);
  font-size: 11.5px;
  font-weight: 560;
  transition: background-color var(--fast), opacity var(--fast);
}
.assistant-retry:hover:not(:disabled) { background: color-mix(in srgb, var(--danger) 22%, transparent); }
.assistant-retry:disabled { opacity: 0.45; }
.assistant-limit { margin: 6px 0 0; color: var(--muted); font-size: 12px; line-height: 1.5; font-weight: 400; }
.assistant-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
  min-height: 26px;
}
.assistant-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: -7px;
  opacity: 0;
  transition: opacity var(--fast);
}
.user-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
  margin-top: 2px;
  margin-right: 2px;
  min-height: 24px;
  opacity: 0;
  transition: opacity var(--fast);
}
.message:hover .assistant-actions,
.message:focus-within .assistant-actions,
.message-user:hover .user-actions,
.message-user:focus-within .user-actions {
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

.assistant-meta-time {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--faint);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  user-select: none;
}
.assistant-duration { white-space: nowrap; }
.assistant-meta-dot { opacity: 0.6; }
.assistant-time {
  flex: none;
  color: inherit;
  font: inherit;
  font-variant-numeric: tabular-nums;
  user-select: none;
}

@media (max-width: 860px) {
  .assistant-actions,
  .user-actions { opacity: 0.85; }
}
@media (max-width: 640px) {
  .message { gap: 0; }
  .message-avatar { display: none; }
  .message-meta { min-height: 18px; margin-bottom: 2px; }
  .user-bubble { padding: 8px 12px 7px; }
}
</style>

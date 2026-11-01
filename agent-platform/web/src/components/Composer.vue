<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import Icon from './Icon.vue';
import ModelMenu from './ModelMenu.vue';
import { useSession } from '../stores/session';
import { useUi } from '../stores/ui';
import { post } from '../services/api';
import { formatBytes } from '../services/format';

const session = useSession();
const ui = useUi();
const text = ref('');
const area = ref<HTMLTextAreaElement | null>(null);
const chipEl = ref<HTMLElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const modelOpen = ref(false);
const uploading = ref(false);
const dragOver = ref(false);

const workspaceRefs = computed(() => session.workspaceRefs || []);
const textQuotes = computed(() => session.textQuotes || []);

const canSend = computed(() => !session.busy && session.canExecute && (text.value.trim().length > 0 || workspaceRefs.value.length > 0 || textQuotes.value.length > 0));
const placeholder = computed(() => {
  if (!session.canExecute) return '此账户尚未获得 Iris 执行权限';
  if (textQuotes.value.length > 0) return '描述针对引用内容的要求，或直接发送…';
  if (workspaceRefs.value.length > 0) return '描述针对引用文件的要求，或直接发送…';
  return '描述任务，或直接粘贴图片、拖入文件…';
});
const stateText = computed(() => session.busy ? (session.stopping ? '正在停止任务…' : 'Iris 正在处理任务…') : (session.canExecute ? '' : '尚未开通执行权限'));
const effortLabel = computed(() => ({ off: '', low: '低', medium: '中', high: '高', max: '极高' }[ui.thinkingLevel] || ''));

function autosize() {
  const el = area.value; if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 260) + 'px';
}
function onInput() { autosize(); }

async function submit() {
  if (!canSend.value) return;
  const value = text.value;
  text.value = '';
  await nextTick(); autosize();
  await session.send(value);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Backspace' && !text.value) {
    if (session.workspaceRefs && session.workspaceRefs.length > 0) {
      session.workspaceRefs.pop();
      return;
    }
    if (session.textQuotes && session.textQuotes.length > 0) {
      session.textQuotes.pop();
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
}

function pathDir(p: string) {
  const parts = (p || '').split('/').filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
}

function isImage(name: string) {
  return /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(name || '');
}

function onChipClick(r: any) {
  if (r.previewUrl || isImage(r.name) || r.type === 'image') {
    ui.openLightbox({
      url: r.previewUrl || ('/api/files/download?path=' + encodeURIComponent(r.path) + '&inline=1'),
      name: r.name,
      size: r.size,
    });
  }
}

// Convert a File to Base64 data string
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result || '');
      const comma = res.indexOf(',');
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function triggerUpload() {
  if (!session.canExecute || uploading.value) return;
  fileInput.value?.click();
}

async function uploadFiles(files: File[]) {
  if (!files || !files.length || !session.canExecute) return;
  uploading.value = true;
  let count = 0;
  for (const file of files) {
    if (file.size > 15 * 1024 * 1024) {
      ui.toast(`文件 ${file.name} 超过 15MB 上限`, { tone: 'error' });
      continue;
    }
    try {
      const base64 = await fileToBase64(file);
      const isImg = isImage(file.name) || file.type.startsWith('image/');
      let safeName = file.name.replace(/[^\w\.\-一-龥]/g, '_');
      if (safeName.startsWith('image.') || safeName === 'image.png') {
        safeName = `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}.png`;
      }
      const targetPath = `uploads/${safeName}`;

      await post('/api/files/upload', {
        path: targetPath,
        content: base64,
        encoding: 'base64',
        overwrite: true,
      });

      session.addWorkspaceRef({
        path: targetPath,
        name: file.name,
        type: isImg ? 'image' : 'file',
        size: file.size,
        previewUrl: isImg ? URL.createObjectURL(file) : undefined,
      });
      count++;
    } catch (err: any) {
      ui.toast(`上传 ${file.name} 失败: ${err.message || '网络错误'}`, { tone: 'error' });
    }
  }
  uploading.value = false;
  if (count > 0) {
    ui.toast(count === 1 ? '附件已上传到工作区' : `已上传 ${count} 个附件到工作区`, { tone: 'success' });
  }
}

function onFilesSelected(e: Event) {
  const input = e.target as HTMLInputElement;
  if (input.files && input.files.length) {
    uploadFiles(Array.from(input.files));
    input.value = '';
  }
}

async function onPaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items;
  if (!items || !items.length) return;
  const files: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length > 0) {
    await uploadFiles(files);
    // If only image/file was pasted (no text), prevent default paste
    if (!e.clipboardData.getData('text/plain')) {
      e.preventDefault();
    }
  }
}

function onDrop(e: DragEvent) {
  dragOver.value = false;
  if (e.dataTransfer?.files && e.dataTransfer.files.length) {
    uploadFiles(Array.from(e.dataTransfer.files));
  }
}

// Watch draft text from rewind
watch(() => session.draftText, (val) => {
  if (val !== undefined && val !== null && val !== '') {
    text.value = val;
    session.draftText = '';
    nextTick(() => {
      autosize();
      area.value?.focus();
    });
  }
});
</script>

<template>
  <footer class="composer-area" :class="{ 'is-welcome': session.isEmpty }">
    <form
      class="composer"
      :class="{ 'is-disabled': !session.canExecute, 'is-dragover': dragOver }"
      @submit.prevent="submit"
      @dragover.prevent="dragOver = true"
      @dragleave="dragOver = false"
      @drop.prevent="onDrop"
    >
      <!-- Hidden file input for attachment upload -->
      <input
        ref="fileInput"
        type="file"
        multiple
        class="composer-hidden-input"
        aria-hidden="true"
        tabindex="-1"
        @change="onFilesSelected"
      />

      <!-- GPT-style quoted text cards -->
      <div v-if="textQuotes.length" class="composer-quotes">
        <div
          v-for="q in textQuotes"
          :key="q.id"
          class="composer-quote-card"
        >
          <div class="composer-quote-text">{{ q.text }}</div>
          <div class="composer-quote-meta">
            <span class="composer-quote-icon"><Icon name="message" :size="11" /></span>
            <span class="composer-quote-source">{{ q.source || '引用内容' }}</span>
          </div>
          <button
            type="button"
            class="composer-quote-remove"
            aria-label="移除引用"
            title="移除"
            @click.stop="session.removeTextQuote(q.id)"
          >
            <Icon name="x" :size="11" />
          </button>
        </div>
      </div>

      <!-- Referenced & uploaded workspace files pills with image thumbnail -->
      <div v-if="workspaceRefs.length" class="composer-chips">
        <div
          v-for="r in workspaceRefs"
          :key="r.path"
          class="composer-chip"
          :class="{ 'is-image': isImage(r.name) || r.type === 'image' || r.previewUrl }"
          :title="(isImage(r.name) || r.type === 'image' || r.previewUrl) ? '点击放大预览 · /workspace/' + r.path : '/workspace/' + r.path"
          @click="onChipClick(r)"
        >
          <span class="composer-chip-icon">
            <img v-if="r.previewUrl" :src="r.previewUrl" class="composer-chip-thumb" alt="" />
            <Icon v-else :name="isImage(r.name) ? 'image' : (r.type === 'dir' ? 'folder' : 'file')" :size="12" />
          </span>
          <span class="composer-chip-name">{{ r.name }}</span>
          <span v-if="r.size" class="composer-chip-size">{{ formatBytes(r.size) }}</span>
          <span v-else-if="pathDir(r.path)" class="composer-chip-dir">{{ pathDir(r.path) }}</span>
          <button
            type="button"
            class="composer-chip-remove"
            aria-label="移除附件"
            title="移除"
            @click.stop="session.removeWorkspaceRef(r.path)"
          >
            <Icon name="x" :size="11" />
          </button>
        </div>
      </div>

      <textarea
        ref="area"
        v-model="text"
        rows="1"
        maxlength="20000"
        :placeholder="placeholder"
        :disabled="!session.canExecute"
        aria-label="给 Iris 的任务"
        @input="onInput"
        @keydown="onKeydown"
        @paste="onPaste"
      ></textarea>

      <div class="composer-bar">
        <!-- Revamped '+' button: Upload attachments / photos / PDF / docs directly to workspace -->
        <button
          type="button"
          class="composer-icon-btn"
          :class="{ 'is-uploading': uploading }"
          aria-label="上传附件"
          title="上传附件 (支持图片、PDF、Word文档等)"
          :disabled="uploading"
          @click="triggerUpload"
        >
          <span v-if="uploading" class="composer-upload-spin" aria-hidden="true"></span>
          <Icon v-else name="plus" :size="18" />
        </button>

        <span class="composer-spacer"></span>
        <span v-if="text.length > 16000" class="composer-count">{{ text.length }} / 20000</span>
        <button ref="chipEl" type="button" class="model-chip" title="切换模型与思考强度" @click="modelOpen = !modelOpen">
          <span class="model-chip-label">{{ session.modelLabel }}</span>
          <span v-if="effortLabel" class="model-chip-effort">{{ effortLabel }}</span>
          <Icon name="chevron-down" :size="12" />
        </button>
        <button v-if="!session.busy" type="submit" class="send" :disabled="!canSend" aria-label="发送任务" title="发送任务"><Icon name="arrow-up" :size="17" /></button>
        <button v-else type="button" class="stop" :disabled="session.stopping" @click="session.stop()"><Icon name="square" :size="14" /><span>停止</span></button>
      </div>
    </form>
    <div class="composer-footer"><span class="task-state">{{ stateText }}</span></div>
    <ModelMenu v-if="modelOpen && chipEl" :anchor="chipEl" @close="modelOpen = false" />
  </footer>
</template>

<style>
.composer-area { flex: none; padding: 6px clamp(16px, 4vw, 40px) max(10px, env(safe-area-inset-bottom)); background: linear-gradient(to top, var(--bg) 70%, transparent); transition: padding-bottom 350ms var(--ease); }
.composer-area.is-welcome { padding-bottom: clamp(60px, calc(50dvh - 145px), 320px); }
@media (max-width: 860px) {
  .composer-area.is-welcome { padding-bottom: max(20px, calc(50dvh - 142px)); }
}
.composer { max-width: 760px; margin: 0 auto; padding: 11px 13px 9px 17px; border: 1px solid var(--line-2); border-radius: 24px; background: var(--surface); box-shadow: var(--shadow); transition: border-color var(--fast), box-shadow var(--fast), background-color var(--fast); }
.composer:focus-within { border-color: var(--line-focus); }
.composer.is-dragover { border-color: var(--accent); background: var(--accent-softer); box-shadow: 0 0 0 3px var(--accent-soft); }
.composer-hidden-input { display: none; }

.composer-quotes { display: flex; flex-wrap: wrap; align-items: stretch; gap: 7px; padding: 2px 1px 8px; animation: comp-chips-in 160ms var(--ease); }
.composer-quote-card {
  position: relative;
  flex: 0 1 250px;
  max-width: 320px;
  min-width: 140px;
  padding: 8px 24px 7px 11px;
  border-radius: 12px;
  border: 1px solid var(--line-2);
  background: color-mix(in srgb, var(--surface) 65%, var(--sidebar));
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03);
  transition: border-color var(--fast), background-color var(--fast);
}
.composer-quote-card:hover { border-color: var(--line-strong); }
.composer-quote-text {
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-line;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.composer-quote-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 5px;
  color: var(--muted);
  font-size: 11px;
  user-select: none;
}
.composer-quote-icon { display: grid; place-items: center; color: var(--faint); }
.composer-quote-source { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.composer-quote-remove {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  color: var(--faint);
  transition: background-color var(--fast), color var(--fast);
}
.composer-quote-remove:hover {
  background: color-mix(in srgb, var(--text) 10%, transparent);
  color: var(--text);
}

.composer-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; padding: 1px 1px 7px; animation: comp-chips-in 160ms var(--ease); }
@keyframes comp-chips-in { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }
.composer-chip { display: inline-flex; align-items: center; gap: 5px; max-width: 260px; height: 26px; padding: 0 5px 0 8px; border-radius: 8px; border: 1px solid var(--line-2); background: color-mix(in srgb, var(--surface) 60%, var(--sidebar)); color: var(--text-2); font-size: 12px; font-weight: 520; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03); transition: border-color var(--fast), background-color var(--fast); }
.composer-chip:hover { border-color: var(--line-strong); color: var(--text); }
.composer-chip.is-image { cursor: pointer; }
.composer-chip.is-image:hover { border-color: var(--line-focus); }
.composer-chip-icon { flex: none; display: grid; place-items: center; color: var(--muted); }
.composer-chip-thumb { width: 18px; height: 18px; object-fit: cover; border-radius: 4px; }
.composer-chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.composer-chip-size { flex: none; color: var(--faint); font-size: 10.5px; font-variant-numeric: tabular-nums; }
.composer-chip-dir { flex: none; color: var(--faint); font-size: 10.5px; }
.composer-chip-remove { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 17px; height: 17px; margin-left: 2px; border-radius: 5px; color: var(--faint); transition: background-color var(--fast), color var(--fast); }
.composer-chip-remove:hover { background: color-mix(in srgb, var(--text) 10%, transparent); color: var(--text); }

.composer textarea { display: block; width: 100%; min-height: 28px; max-height: 260px; padding: 2px 1px; border: 0; outline: 0; resize: none; overflow-y: auto; background: transparent; color: var(--text); font-size: 15px; line-height: 1.65; }
.composer textarea::placeholder { color: var(--muted); }
.composer textarea:disabled { opacity: 0.6; }
.composer-bar { display: flex; align-items: center; gap: 8px; min-height: 36px; margin-top: 6px; }
.composer-spacer { flex: 1; }
.composer-icon-btn { width: 32px; height: 32px; flex: none; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); transition: background-color var(--fast), color var(--fast), border-color var(--fast); }
.composer-icon-btn:hover { background: color-mix(in srgb, var(--text) 5%, transparent); color: var(--text); border-color: var(--line-2); }
.composer-icon-btn.is-uploading { pointer-events: none; opacity: 0.7; }
.composer-upload-spin { width: 14px; height: 14px; border: 1.8px solid var(--muted); border-top-color: transparent; border-radius: 50%; animation: comp-spin 0.65s linear infinite; }
@keyframes comp-spin { to { transform: rotate(360deg); } }

.composer-count { flex: none; color: var(--faint); font-size: 10px; font-variant-numeric: tabular-nums; }
.model-chip { display: inline-flex; align-items: center; gap: 6px; max-width: 256px; height: 30px; padding: 0 9px 0 10px; overflow: hidden; border: 1px solid var(--line); border-radius: 999px; background: transparent; color: var(--text-2); font-size: 11.5px; font-weight: 520; transition: border-color var(--fast), background-color var(--fast); }
.model-chip:hover { border-color: var(--line-2); background: color-mix(in srgb, var(--text) 4%, transparent); }
.model-chip-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-chip-effort { flex: none; padding: 1px 5.5px; border-radius: 5px; background: color-mix(in srgb, var(--text) 5.5%, transparent); color: var(--muted); font-size: 10px; font-weight: 600; line-height: 1.35; }
.model-chip svg { color: var(--faint); }
.send { flex: none; width: 36px; height: 36px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; background: var(--ink); color: var(--surface); transition: transform var(--fast), opacity var(--fast), filter var(--fast); }
.send:hover:not(:disabled) { filter: brightness(1.12); }
.send:active:not(:disabled) { transform: scale(0.94); }
.send:disabled { opacity: 0.25; }
.stop { flex: none; height: 36px; display: inline-flex; align-items: center; gap: 6px; padding: 0 14px; border-radius: 12px; font-size: 13px; font-weight: 600; background: var(--danger-soft); color: var(--danger); border: 1px solid color-mix(in srgb, var(--danger) 22%, transparent); }
.stop:hover:not(:disabled) { background: color-mix(in srgb, var(--danger) 16%, transparent); }
.composer-footer { max-width: 760px; margin: 0 auto; display: flex; align-items: center; height: 0; overflow: visible; padding: 0 4px; }
.composer-footer:not(:empty) { min-height: 0; }
.task-state { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 11px; line-height: 16px; margin-top: 4px; }
.task-state:empty { display: none; }
</style>

<script setup lang="ts">
import { ref, computed, nextTick } from 'vue';
import Icon from './Icon.vue';
import ModelMenu from './ModelMenu.vue';
import { useSession } from '../stores/session';
import { useUi } from '../stores/ui';

const session = useSession();
const ui = useUi();
const text = ref('');
const area = ref<HTMLTextAreaElement | null>(null);
const chipEl = ref<HTMLElement | null>(null);
const modelOpen = ref(false);

const canSend = computed(() => !session.busy && session.canExecute && text.value.trim().length > 0);
const placeholder = computed(() => session.canExecute ? '描述任务，或接着聊…' : '此账户尚未获得 Iris 执行权限');
const stateText = computed(() => session.busy ? (session.stopping ? '正在停止任务…' : 'Iris 正在处理任务…') : (session.canExecute ? '' : '尚未开通执行权限'));

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
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
}
</script>

<template>
  <footer class="composer-area" :class="{ 'is-welcome': session.isEmpty }">
    <form class="composer" @submit.prevent="submit" :class="{ 'is-disabled': !session.canExecute }">
      <textarea ref="area" v-model="text" rows="1" maxlength="20000" :placeholder="placeholder"
        :disabled="!session.canExecute" @input="onInput" @keydown="onKeydown" aria-label="给 Iris 的任务"></textarea>
      <div class="composer-bar">
        <button type="button" class="composer-icon-btn" aria-label="添加文件引用" title="引用工作区文件" @click="ui.setWorkspaceOpen(true)"><Icon name="plus" :size="18" /></button>
        <span class="composer-spacer"></span>
        <span v-if="text.length > 16000" class="composer-count">{{ text.length }} / 20000</span>
        <button ref="chipEl" type="button" class="model-chip" title="模型与供应商" @click="modelOpen = !modelOpen">
          <span class="model-dot"></span>
          <span class="model-chip-label">{{ session.modelLabel }}</span>
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
.composer-area { flex: none; padding: 6px clamp(16px, 4vw, 40px) max(10px, env(safe-area-inset-bottom)); background: linear-gradient(to top, var(--bg) 70%, transparent); transition: padding-bottom var(--dur) var(--ease); }
.composer-area.is-welcome { padding-bottom: clamp(32px, 11vh, 120px); }
.composer { max-width: 760px; margin: 0 auto; padding: 13px 13px 9px 17px; border: 1px solid var(--line-strong); border-radius: 24px; background: var(--surface); box-shadow: var(--shadow); transition: border-color var(--fast), box-shadow var(--fast); }
.composer:focus-within { border-color: color-mix(in srgb, var(--accent) 55%, var(--line-strong)); box-shadow: var(--shadow), var(--ring); }
.composer textarea { display: block; width: 100%; min-height: 28px; max-height: 260px; padding: 2px 1px; border: 0; outline: 0; resize: none; overflow-y: auto; background: transparent; color: var(--text); font-size: 15px; line-height: 1.65; }
.composer textarea::placeholder { color: var(--muted); }
.composer textarea:disabled { opacity: 0.6; }
.composer-bar { display: flex; align-items: center; gap: 8px; min-height: 36px; margin-top: 6px; }
.composer-spacer { flex: 1; }
.composer-icon-btn { width: 34px; height: 34px; flex: none; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--line-2); border-radius: 10px; color: var(--muted); transition: background-color var(--fast), color var(--fast), border-color var(--fast); }
.composer-icon-btn:hover { background: color-mix(in srgb, var(--text) 5%, transparent); color: var(--text); border-color: var(--line-strong); }
.composer-count { flex: none; color: var(--faint); font-size: 10px; font-variant-numeric: tabular-nums; }
.model-chip { display: inline-flex; align-items: center; gap: 6px; max-width: 220px; height: 30px; padding: 0 9px 0 10px; overflow: hidden; border: 1px solid var(--line-2); border-radius: 999px; background: var(--surface); color: var(--text-2); font-size: 11.5px; font-weight: 520; transition: border-color var(--fast), background-color var(--fast); }
.model-chip:hover { border-color: var(--line-strong); background: color-mix(in srgb, var(--text) 3%, transparent); }
.model-chip-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-chip .model-dot { width: 6px; height: 6px; flex: none; border-radius: 50%; background: var(--ok); }
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

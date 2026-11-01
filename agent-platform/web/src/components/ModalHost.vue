<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { useUi } from '../stores/ui';

const ui = useUi();
const inputEl = ref<HTMLInputElement | null>(null);
const draft = ref('');

watch(
  () => ui.modal,
  (m) => {
    if (!m) return;
    draft.value = m.defaultValue ?? '';
    if (m.kind === 'prompt') {
      nextTick(() => {
        inputEl.value?.focus();
        inputEl.value?.select();
      });
    }
  },
  { immediate: true },
);

function cancel() {
  if (!ui.modal) return;
  ui.resolveModal(ui.modal.kind === 'confirm' ? false : null);
}

function submit() {
  if (!ui.modal) return;
  if (ui.modal.kind === 'confirm') {
    ui.resolveModal(true);
  } else {
    ui.resolveModal(draft.value);
  }
}

function onKey(e: KeyboardEvent) {
  if (!ui.modal) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopImmediatePropagation();
    cancel();
  } else if (e.key === 'Enter' && ui.modal.kind === 'confirm') {
    e.preventDefault();
    submit();
  }
}

onMounted(() => document.addEventListener('keydown', onKey, true));
onBeforeUnmount(() => document.removeEventListener('keydown', onKey, true));
</script>

<template>
  <teleport to="body">
    <div v-if="ui.modal" class="iris-modal-backdrop" @click.self="cancel">
      <form class="iris-modal" role="dialog" aria-modal="true" :aria-label="ui.modal.title" @submit.prevent="submit">
        <h3 class="iris-modal-title">{{ ui.modal.title }}</h3>
        <p v-if="ui.modal.message" class="iris-modal-msg">{{ ui.modal.message }}</p>

        <input
          v-if="ui.modal.kind === 'prompt'"
          ref="inputEl"
          v-model="draft"
          type="text"
          class="iris-modal-input"
          :placeholder="ui.modal.placeholder"
          :maxlength="ui.modal.maxLength || 240"
          autocomplete="off"
          spellcheck="false"
        >

        <div class="iris-modal-actions">
          <button type="button" class="btn btn-quiet btn-sm" @click="cancel">{{ ui.modal.cancelText || '取消' }}</button>
          <button
            type="submit"
            class="btn btn-sm"
            :class="ui.modal.danger ? 'btn-danger' : 'btn-solid'"
          >
            {{ ui.modal.confirmText || '确定' }}
          </button>
        </div>
      </form>
    </div>
  </teleport>
</template>

<style>
.iris-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 220;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(12, 13, 18, 0.46);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  animation: fade-in 130ms var(--ease);
}
.iris-modal {
  width: min(410px, 100%);
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 20px 22px 18px;
  border: 1px solid var(--line-2);
  border-radius: 18px;
  background: var(--surface);
  color: var(--text);
  box-shadow: var(--shadow-lg);
  animation: dialog-in 160ms var(--ease);
}
.iris-modal-title {
  margin: 0;
  font-size: 15.5px;
  font-weight: 650;
  line-height: 1.4;
  letter-spacing: -0.01em;
}
.iris-modal-msg {
  margin: 0;
  color: var(--text-2);
  font-size: 13px;
  line-height: 1.6;
}
.iris-modal-input {
  width: 100%;
  min-height: 39px;
  margin-top: 2px;
  padding: 8px 12px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  outline: 0;
  background: var(--surface-2);
  color: var(--text);
  font-size: 13.5px;
  transition: border-color var(--fast), box-shadow var(--fast), background-color var(--fast);
}
.iris-modal-input:focus {
  border-color: var(--accent);
  box-shadow: var(--ring);
  background: var(--surface);
}
.iris-modal-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}
</style>

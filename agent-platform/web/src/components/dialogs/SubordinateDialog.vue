<script setup lang="ts">
import { computed, ref } from 'vue';
import BaseDialog from './BaseDialog.vue';
import Icon from '../Icon.vue';
import { useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';
const session = useSession(), ui = useUi();
const primary = session.currentProjectId;
const selected = ref<string[]>([]), saving = ref(false), error = ref('');
const choices = computed(() => session.projects.filter(p => p.id !== primary && !session.currentChatPermission.extraProjects?.[p.id]));
async function add() {
  if (saving.value || !selected.value.length || session.busy) return;
  saving.value = true; error.value = '';
  try {
    if (session.currentProjectId !== primary) throw new Error('主项目已变化，请重新打开选择窗口');
    const extra = { ...session.currentChatPermission.extraProjects };
    for (const id of selected.value) if (choices.value.some(p => p.id === id)) extra[id] = 'read';
    const next = { ...session.currentChatPermission, scope: 'scoped' as const, extraProjects: extra };
    if (session.chatId && session.currentChat) await session.setChatPermission(session.chatId, next);
    else session.newChatPermission = next;
    ui.toast('已添加从属项目（只读），可在项目菜单切换读写', { tone: 'success' });
    ui.closeDialog();
  } catch (e: any) { error.value = e.message || '添加失败，请重试'; }
  finally { saving.value = false; }
}
</script>

<template>
  <BaseDialog title="选择从属项目" subtitle="选择要授权的项目，添加后默认只读，可在项目菜单中切换读写。">
    <form novalidate @submit.prevent="add">
      <div class="subordinate-choices">
        <label v-for="p in choices" :key="p.id" class="subordinate-choice">
          <input v-model="selected" type="checkbox" :value="p.id" :disabled="saving">
          <Icon name="folder" :size="17" />
          <span><strong>{{ p.name }}</strong><small>/workspace/{{ p.id }}</small></span>
        </label>
        <p v-if="!choices.length" class="hint">没有可添加的其他项目。请先创建项目空间。</p>
      </div>
      <p v-if="error" class="field-error" role="alert">{{ error }}</p>
      <div class="dialog-actions">
        <button type="button" class="btn btn-quiet" :disabled="saving" @click="ui.closeDialog">取消</button>
        <button type="submit" class="btn btn-solid" :disabled="saving || !selected.length || session.busy">{{ saving ? '正在添加…' : '添加所选项目' }}</button>
      </div>
    </form>
  </BaseDialog>
</template>

<style>
.subordinate-choices { display: flex; flex-direction: column; gap: 8px; }
.subordinate-choice { display: flex; gap: 12px; align-items: center; padding: 12px; border: 1px solid var(--line); border-radius: 10px; cursor: pointer; }
.subordinate-choice:hover { background: var(--surface-2); }
.subordinate-choice span { min-width: 0; }
.subordinate-choice strong { display: block; font-size: 13px; }
.subordinate-choice small { display: block; color: var(--muted); overflow-wrap: anywhere; font-family: var(--font-mono); }
</style>

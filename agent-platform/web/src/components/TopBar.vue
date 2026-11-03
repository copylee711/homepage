<script setup lang="ts">
import { computed, ref, nextTick } from 'vue';
import Icon from './Icon.vue';
import DropMenu from './DropMenu.vue';
import type { MenuItem } from './DropMenu.vue';
import { useSession } from '../stores/session';
import { useUi } from '../stores/ui';
import { post } from '../services/api';

const session = useSession();
const ui = useUi();
const title = computed(() => session.currentChat?.title || (session.canExecute ? '新任务' : 'Iris'));
const subtitle = computed(() => session.busyHere ? '正在生成回复…' : session.currentChat?.archived ? '已归档' : !session.canExecute ? '暂无执行权限' : '');
const chatMenu = ref<{ anchor: HTMLElement; items: MenuItem[] } | null>(null);

const isEditing = ref(false);
const editValue = ref('');
const titleInput = ref<HTMLInputElement | null>(null);

function startRename() {
  if (!session.currentChat || session.busy) return;
  editValue.value = session.currentChat.title || '新任务';
  isEditing.value = true;
  nextTick(() => {
    titleInput.value?.focus();
    titleInput.value?.select();
  });
}

async function commitRename() {
  if (!isEditing.value) return;
  isEditing.value = false;
  const newTitle = editValue.value.replace(/\s+/g, ' ').trim();
  if (!newTitle || !session.currentChat || newTitle === session.currentChat.title) return;
  try {
    const ok = await session.renameChat(session.currentChat.id, newTitle);
    if (ok) ui.toast('会话已重命名', { tone: 'success' });
  } catch (err: any) {
    ui.toast(err.message || '重命名失败', { tone: 'error' });
  }
}

function cancelRename() {
  isEditing.value = false;
}

function openChatMenu(e: MouseEvent) {
  const c = session.currentChat; if (!c) return;
  chatMenu.value = { anchor: e.currentTarget as HTMLElement, items: [
    { icon: 'edit', label: '重命名', action: startRename },
    { icon: 'download', label: '导出 Markdown', action: () => exp(c.id, 'md') },
    { icon: 'download', label: '导出 JSON', action: () => exp(c.id, 'json') },
    { icon: 'archive', label: c.archived ? '取消归档' : '归档对话', action: () => arch(c.id, !c.archived) },
  ] };
}
function exp(id: string, format: string) { const a = document.createElement('a'); a.href = '/api/chats/export?chat=' + encodeURIComponent(id) + '&format=' + format; a.click(); }
async function arch(id: string, archived: boolean) { try { await post('/api/chats/archive', { thread: id, archived }); await session.loadChats(); } catch (e: any) { ui.toast(e.message, { tone: 'error' }); } }
function toggleWorkspace() {
  if (window.innerWidth <= 1180) ui.mobileDrawer = 'workspace';
  else ui.setWorkspaceOpen(!ui.workspaceOpen);
}
</script>

<template>
  <header class="topbar">
    <button v-if="!ui.sidebarOpen" class="icon-button" aria-label="显示导航" title="显示导航" @click="ui.setSidebarOpen(true)"><Icon name="panel-left" /></button>
    <button class="icon-button only-mobile" aria-label="显示导航" @click="ui.mobileDrawer = 'sidebar'"><Icon name="menu" /></button>
    <div class="chat-heading">
      <div class="chat-heading-row">
        <form novalidate v-if="isEditing" class="chat-title-form" @submit.prevent="commitRename">
          <input
            ref="titleInput"
            v-model="editValue"
            type="text"
            class="chat-title-input"
            maxlength="80"
            placeholder="输入任务标题"
            @blur="commitRename"
            @keydown.esc.prevent="cancelRename"
          />
        </form>
        <button
          v-else
          type="button"
          class="chat-title-btn"
          :class="{ 'is-clickable': !!session.currentChat }"
          :title="session.currentChat ? '单击直接重命名任务' : ''"
          :disabled="!session.currentChat"
          @click="startRename"
        >
          <span class="chat-title-text">{{ title }}</span>
          <Icon v-if="session.currentChat" name="edit" :size="12" class="chat-title-icon" />
        </button>
      </div>
      <p v-if="subtitle">{{ subtitle }}</p>
    </div>
    <div class="topbar-actions">
      <button v-if="session.canExecute" class="icon-button" aria-label="联网搜索" title="联网搜索" @click="ui.openSettings('search')"><Icon name="globe" /></button>
      <button v-if="session.canExecute" class="icon-button" :disabled="!session.currentChat" aria-label="对话操作" title="对话操作" @click="openChatMenu"><Icon name="more-horizontal" /></button>
      <button class="icon-button theme-btn" :aria-label="ui.theme === 'dark' ? '切换到浅色' : '切换到深色'" :title="ui.theme === 'dark' ? '浅色' : '深色'" @click="ui.toggleTheme($event)">
        <Icon :key="ui.theme" :name="ui.theme === 'dark' ? 'sun' : 'moon'" />
      </button>
      <button v-if="session.canExecute" class="icon-button" aria-label="workspace" title="/workspace" @click="toggleWorkspace"><Icon name="panel-right" /></button>
    </div>
    <DropMenu v-if="chatMenu" :anchor="chatMenu.anchor" :items="chatMenu.items" label="对话操作" @close="chatMenu = null" />
  </header>
</template>

<style>
.topbar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: var(--header-h);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px;
  background: transparent;
  z-index: 10;
  pointer-events: none;
}
.chat-heading,
.topbar-actions {
  pointer-events: auto;
}
.chat-heading { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; padding-left: 2px; }
.chat-heading-row { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }

.chat-title-form { display: flex; align-items: center; margin-left: -5px; }
.chat-title-input { height: 26px; padding: 0 7px; font-size: 14.5px; font-weight: 650; color: var(--text); border: 1px solid var(--accent); border-radius: 7px; background: var(--surface); outline: none; box-shadow: 0 0 0 2.5px var(--accent-soft); max-width: min(100%, 420px); font-family: inherit; }

.chat-title-btn { display: inline-flex; align-items: center; gap: 6px; padding: 2px 6px; margin-left: -6px; border-radius: 7px; max-width: min(100%, 480px); text-align: left; transition: background-color var(--fast), color var(--fast); font-size: 15px; font-weight: 650; line-height: 1.35; letter-spacing: -0.01em; color: var(--text); border: 0; background: transparent; cursor: default; }
.chat-title-btn.is-clickable { cursor: pointer; }
.chat-title-btn.is-clickable:hover { background: color-mix(in srgb, var(--text) 6%, transparent); }
.chat-title-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-title-icon { flex: none; color: var(--faint); opacity: 0; transition: opacity var(--fast), color var(--fast); }
.chat-title-btn:hover .chat-title-icon { opacity: 1; color: var(--muted); }

.chat-heading p { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 11px; line-height: 1.3; }
.topbar-actions { display: flex; align-items: center; gap: 3px; flex: none; }
.theme-btn svg { animation: theme-icon-in 260ms var(--ease); }
@keyframes theme-icon-in { from { opacity: 0.4; transform: rotate(-45deg) scale(0.82); } to { opacity: 1; transform: none; } }
.only-mobile { display: none; }
@media (max-width: 860px) { .only-mobile { display: inline-flex; } }
</style>

<script setup lang="ts">
import { computed, ref } from 'vue';
import Icon from './Icon.vue';
import DropMenu from './DropMenu.vue';
import type { MenuItem } from './DropMenu.vue';
import { useSession } from '../stores/session';
import { useUi } from '../stores/ui';
import { post } from '../services/api';

const session = useSession();
const ui = useUi();
const title = computed(() => session.currentChat?.title || '新对话');
const subtitle = computed(() => session.busy ? '正在生成回复…' : session.currentChat?.archived ? '已归档' : !session.canExecute ? '暂无执行权限' : '');
const chatMenu = ref<{ anchor: HTMLElement; items: MenuItem[] } | null>(null);

function openChatMenu(e: MouseEvent) {
  const c = session.currentChat; if (!c) return;
  chatMenu.value = { anchor: e.currentTarget as HTMLElement, items: [
    { icon: 'download', label: '导出 Markdown', action: () => exp(c.id, 'md') },
    { icon: 'download', label: '导出 JSON', action: () => exp(c.id, 'json') },
    { icon: session.currentChat?.archived ? 'archive' : 'archive', label: c.archived ? '取消归档' : '归档对话', action: () => arch(c.id, !c.archived) },
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
      <h1>{{ title }}</h1>
      <p>{{ subtitle }}</p>
    </div>
    <div class="topbar-actions">
      <button v-if="session.canExecute" class="icon-button" aria-label="网页阅读" title="网页阅读" @click="ui.openDialog('webread')"><Icon name="globe" /></button>
      <button class="icon-button" :disabled="!session.currentChat" aria-label="对话操作" title="对话操作" @click="openChatMenu"><Icon name="more-horizontal" /></button>
      <button class="icon-button" :aria-label="ui.theme === 'dark' ? '切换到浅色' : '切换到深色'" :title="ui.theme === 'dark' ? '浅色' : '深色'" @click="ui.toggleTheme()">
        <Icon :name="ui.theme === 'dark' ? 'sun' : 'moon'" />
      </button>
      <button v-if="session.canExecute" class="icon-button" aria-label="工作区" title="工作区" @click="toggleWorkspace"><Icon name="panel-right" /></button>
    </div>
    <DropMenu v-if="chatMenu" :anchor="chatMenu.anchor" :items="chatMenu.items" label="对话操作" @close="chatMenu = null" />
  </header>
</template>

<style>
.topbar { min-width: 0; height: var(--header-h); display: flex; align-items: center; gap: 8px; padding: 0 16px; background: color-mix(in srgb, var(--bg) 82%, transparent); backdrop-filter: blur(18px) saturate(1.1); -webkit-backdrop-filter: blur(18px) saturate(1.1); z-index: 5; }
.chat-heading { flex: 1; min-width: 0; display: flex; flex-direction: column; padding-left: 2px; }
.chat-heading h1 { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; font-weight: 650; line-height: 1.35; letter-spacing: -0.01em; }
.chat-heading p { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 11px; line-height: 1.3; }
.topbar-actions { display: flex; align-items: center; gap: 3px; flex: none; }
.only-mobile { display: none; }
@media (max-width: 860px) { .only-mobile { display: inline-flex; } }
</style>

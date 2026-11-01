<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import Icon from './Icon.vue';
import DropMenu from './DropMenu.vue';
import type { MenuItem } from './DropMenu.vue';
import { useSession, type Chat } from '../stores/session';
import { useUi } from '../stores/ui';
import { groupChats, formatShort } from '../services/format';
import { post } from '../services/api';

const session = useSession();
const ui = useUi();

const query = ref('');
const searchOpen = ref(false);
const searchInput = ref<HTMLInputElement | null>(null);

function openSearch() {
  searchOpen.value = true;
  nextTick(() => searchInput.value?.focus());
}

function closeSearch() {
  searchOpen.value = false;
  query.value = '';
}

function onSearchBlur() {
  if (!query.value.trim()) {
    closeSearch();
  }
}

const groups = computed(() => {
  const q = query.value.trim().toLowerCase();
  const filtered = session.chats
    .filter(c => c.archived !== true)
    .filter(c => !q || (c.title || '').toLowerCase().includes(q));
  return groupChats(filtered, ui.chatGroupByDate);
});

const accountMenuAnchor = ref<HTMLElement | null>(null);
const chatMenu = ref<{ anchor: HTMLElement; items: MenuItem[] } | null>(null);
const accountMenu = ref<MenuItem[] | null>(null);

function pickChat(c: Chat) { void session.selectChat(c.id); if (ui.mobileDrawer) ui.mobileDrawer = null; }

async function rename(c: Chat) {
  const title = await ui.prompt({ title: '重命名对话', defaultValue: c.title || '', placeholder: '输入对话标题', confirmText: '保存', maxLength: 80 });
  if (title == null) return;
  const t = title.replace(/\s+/g, ' ').trim();
  if (!t || t.length > 80) return;
  try { await post('/api/chats/rename', { thread: c.id, title: t }); await session.loadChats(); }
  catch (e: any) { ui.toast(e.message, { tone: 'error' }); }
}
async function togglePin(c: Chat) { try { await post('/api/chats/pin', { thread: c.id, pinned: !c.pinned }); await session.loadChats(); } catch (e: any) { ui.toast(e.message, { tone: 'error' }); } }
async function toggleArchive(c: Chat) { try { await post('/api/chats/archive', { thread: c.id, archived: !c.archived }); await session.loadChats(); ui.toast(c.archived ? '已恢复对话' : '已归档对话', { tone: 'success' }); } catch (e: any) { ui.toast(e.message, { tone: 'error' }); } }
function exportChat(c: Chat, format: string) { const a = document.createElement('a'); a.href = '/api/chats/export?chat=' + encodeURIComponent(c.id) + '&format=' + format; a.click(); ui.toast('已开始导出 ' + (format === 'json' ? 'JSON' : 'Markdown'), { tone: 'success' }); }
async function removeChat(c: Chat) {
  if (!(await ui.confirm({ title: '删除对话', message: `删除“${c.title || '新对话'}”？此操作无法撤销，但会保留工作区文件。`, confirmText: '删除', danger: true }))) return;
  try { await post('/api/chats/delete', { thread: c.id }); session.chats = session.chats.filter(x => x.id !== c.id); if (session.chatId === c.id) session.startNew(); ui.toast('对话已删除', { tone: 'success' }); }
  catch (e: any) { ui.toast(e.message, { tone: 'error' }); }
}

function chatItems(c: Chat): MenuItem[] {
  return [
    { icon: 'edit', label: '重命名', action: () => rename(c) },
    { icon: 'pin', label: c.pinned ? '取消置顶' : '置顶对话', action: () => togglePin(c) },
    { icon: 'download', label: '导出 Markdown', action: () => exportChat(c, 'md') },
    { icon: 'download', label: '导出 JSON', action: () => exportChat(c, 'json') },
    { icon: 'archive', label: c.archived ? '取消归档' : '归档对话', action: () => toggleArchive(c) },
    { icon: 'trash', label: '删除对话', danger: true, action: () => removeChat(c) },
  ];
}
function openChatMenu(e: MouseEvent, c: Chat) { chatMenu.value = { anchor: e.currentTarget as HTMLElement, items: chatItems(c) }; }
function chatContext(e: MouseEvent, c: Chat) { ui.openContext(e, [{ header: c.title || '对话' }, ...chatItems(c)]); }

function openAccountMenu() {
  accountMenu.value = [
    { icon: 'settings', label: '设置', action: () => { if (ui.mobileDrawer) ui.mobileDrawer = null; ui.openSettings('general'); } },
    { icon: 'logout', label: '退出登录', danger: true, action: logout },
  ];
}
async function logout() { try { await post('/auth/logout', {}); location.assign('/auth/login'); } catch (e: any) { ui.toast(e.message, { tone: 'error' }); } }

function startResize(e: PointerEvent) {
  e.preventDefault();
  const move = (ev: PointerEvent) => ui.setSidebarW(ev.clientX);
  const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.body.style.cursor = ''; };
  document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  document.body.style.cursor = 'col-resize';
}

const avatarError = ref(false);
const avatarUrl = computed(() => session.auth?.user?.avatar || '');
watch(avatarUrl, () => { avatarError.value = false; });
</script>

<template>
  <aside class="sidebar" aria-label="对话导航">
    <div class="sidebar-head">
      <a class="brand" href="/" aria-label="Iris 首页" @click.prevent="session.startNew()">
        <span class="brand-mark"><Icon name="iris" :size="21" /></span>
        <span class="brand-name">Iris</span>
      </a>
      <button class="icon-button" aria-label="收起导航" title="收起导航" @click="ui.mobileDrawer ? (ui.mobileDrawer = null) : ui.setSidebarOpen(false)"><Icon name="panel-left" /></button>
    </div>

    <button class="new-chat" :disabled="session.busy || !session.canExecute" @click="session.startNew(); if (ui.mobileDrawer) ui.mobileDrawer = null">
      <Icon name="plus" :size="18" /><span>新对话</span>
    </button>

    <button class="command-trigger" @click="ui.openCommand()">
      <span class="search-icon"><Icon name="search" :size="15" /></span>
      <span>搜索与命令</span><kbd>⌘K</kbd>
    </button>

    <div class="chat-list-head" :class="{ 'is-searching': searchOpen }">
      <span v-if="!searchOpen" class="chat-list-label">对话</span>
      <div class="chat-list-filter" :class="{ 'is-open': searchOpen }">
        <input
          v-if="searchOpen"
          ref="searchInput"
          v-model="query"
          type="search"
          placeholder="筛选对话…"
          autocomplete="off"
          spellcheck="false"
          maxlength="80"
          aria-label="筛选对话"
          @blur="onSearchBlur"
          @keydown.esc="closeSearch"
        >
        <button
          v-if="searchOpen"
          type="button"
          class="icon-button mini"
          aria-label="关闭筛选"
          title="关闭筛选"
          @mousedown.prevent
          @click="closeSearch"
        >
          <Icon name="x" :size="15" />
        </button>
        <template v-else>
          <button
            type="button"
            class="icon-button mini"
            :aria-label="ui.chatGroupByDate ? '取消按时间分组 (平铺显示)' : '按时间分组显示'"
            :title="ui.chatGroupByDate ? '时间分组 (开)' : '时间分组 (关)'"
            :class="{ 'is-dim': !ui.chatGroupByDate }"
            @click="ui.toggleChatGroupByDate()"
          >
            <Icon name="calendar" :size="15" />
          </button>
          <button
            type="button"
            class="icon-button mini"
            :aria-label="ui.chatDensity === 'compact' ? '切换为舒适视图' : '切换为紧凑视图'"
            :title="ui.chatDensity === 'compact' ? '紧凑视图' : '舒适视图'"
            @click="ui.toggleChatDensity()"
          >
            <Icon :name="ui.chatDensity === 'compact' ? 'list-compact' : 'list'" :size="15" />
          </button>
          <button
            type="button"
            class="icon-button mini"
            aria-label="筛选对话"
            title="筛选对话"
            @click="openSearch"
          >
            <Icon name="search" :size="15" />
          </button>
        </template>
      </div>
    </div>

    <nav class="chat-list" :class="{ 'is-compact': ui.chatDensity === 'compact' }" aria-label="对话列表">
      <div v-if="session.chatsLoading" class="list-state"><span class="spinner"></span><span>正在读取对话…</span></div>
      <p v-else-if="session.chatsError" class="list-empty">{{ session.chatsError }}</p>
      <p v-else-if="!groups.length" class="list-empty">{{ query ? '没有匹配的对话。' : '还没有对话，发送第一条消息后会出现在这里。' }}</p>
      <section v-for="g in groups" :key="g.key" class="chat-group">
        <h2 v-if="g.label" class="chat-group-title">{{ g.label }}</h2>
        <ul class="chat-items">
          <li v-for="c in g.chats" :key="c.id" class="chat-item" :class="{ 'is-active': c.id === session.chatId }">
            <button class="chat-select" :aria-current="c.id === session.chatId ? 'page' : undefined" :title="c.title" @click="pickChat(c)" @contextmenu="e => chatContext(e, c)">
              <span class="chat-title">{{ c.title || '新对话' }}</span>
              <span class="chat-meta"><span class="chat-time">{{ formatShort(c.updated) }}</span><Icon v-if="c.pinned" name="pin" :size="12" /><Icon v-if="c.archived" name="archive" :size="12" /></span>
            </button>
            <button class="icon-button chat-more" aria-label="对话操作" @click="e => openChatMenu(e, c)"><Icon name="more-horizontal" /></button>
          </li>
        </ul>
      </section>
    </nav>

    <div class="sidebar-foot">
      <button ref="accountMenuAnchor" class="account" aria-haspopup="menu" @click="openAccountMenu">
        <span class="account-avatar" :class="{ 'has-image': avatarUrl && !avatarError }">
          <img v-if="avatarUrl && !avatarError" :src="avatarUrl" alt="" class="account-avatar-img" @error="avatarError = true">
          <template v-else>{{ (session.auth?.user?.name || '·').slice(0, 1) }}</template>
        </span>
        <span class="account-copy">
          <strong>{{ session.auth?.user?.name || '账户' }}</strong>
          <small v-if="session.auth && !session.canExecute">暂无执行权限</small>
        </span>
        <span class="account-caret"><Icon name="settings" :size="15" /></span>
      </button>
    </div>

    <div class="resize-handle resize-sidebar" role="separator" aria-orientation="vertical" aria-label="调整导航宽度" @pointerdown="startResize"></div>

    <DropMenu v-if="chatMenu" :anchor="chatMenu.anchor" :items="chatMenu.items" label="对话操作" @close="chatMenu = null" />
    <DropMenu v-if="accountMenu && accountMenuAnchor" :anchor="accountMenuAnchor" :items="accountMenu" label="账户菜单" up @close="accountMenu = null" />
  </aside>
</template>

<style src="./sidebar.css"></style>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import Icon from './Icon.vue';
import SlimScrollRail from './SlimScrollRail.vue';
import DropMenu from './DropMenu.vue';
import type { MenuItem } from './DropMenu.vue';
import { useSession, type Chat } from '../stores/session';
import { useWorkspace } from '../stores/workspace';
import { useUi } from '../stores/ui';
import { groupChats, formatShort } from '../services/format';
import { post } from '../services/api';

const session = useSession();
const ws = useWorkspace();
const ui = useUi();

const chatList = ref<HTMLElement | null>(null);
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
  const res = groupChats(filtered, ui.chatGroupMode, session.projects);
  return q ? res.filter(g => g.chats.length > 0) : res;
});

const groupModeIcon = computed(() => {
  if (ui.chatGroupMode === 'project') return 'folder';
  if (ui.chatGroupMode === 'date') return 'calendar';
  return 'layers';
});

const groupModeTitle = computed(() => {
  if (ui.chatGroupMode === 'project') return '分组规则：按项目空间 (点击切换)';
  if (ui.chatGroupMode === 'date') return '分组规则：按时间 (点击切换)';
  return '分组规则：平铺不分组 (点击切换)';
});

function cycleGroupMode() {
  const next = ui.cycleChatGroupMode();
  const labelMap: Record<string, string> = {
    date: '已切换为按时间分组',
    project: '已切换为按项目空间分组',
    none: '已切换为平铺不分组',
  };
  ui.toast(labelMap[next] || '已切换分组规则', { tone: 'info', duration: 1800 });
}

const collapsedGroups = ref<Record<string, boolean>>({});
watch(()=>[session.chatId,session.chats.length],()=>{for(const group of groups.value)if(group.chats.some(c=>c.id===session.chatId))collapsedGroups.value[group.key]=false;});
function toggleGroup(key: string) {
  collapsedGroups.value[key] = !collapsedGroups.value[key];
}
function isGroupCollapsed(key: string) {
  return !!collapsedGroups.value[key];
}

function startNewInGroup(g: { key: string; label: string }) {
  const pid = g.key.startsWith('proj:') ? g.key.replace(/^proj:/, '') : undefined;
  session.startNew(pid);
  if (pid) {
    ws.setTerminalCwd(`/workspace/${pid}`);
    ui.toast(`已在“${g.label}”中开启新任务`, { tone: 'info', duration: 1800 });
  }
  if (ui.mobileDrawer) ui.mobileDrawer = null;
}

const projectMenu = ref<{ anchor: HTMLElement; items: MenuItem[] } | null>(null);

function openProjectMenu(e: MouseEvent, g: { key: string; label: string }) {
  const pid = g.key.replace(/^proj:/, '');
  const items: MenuItem[] = [
    { icon: 'plus', label: '以该空间为主空间新建任务', action: () => startNewInGroup(g) },
    { icon: 'edit', label: '重命名项目', action: () => renameProjectPrompt(pid, g.label) },
    { icon: 'plus', label: '新建其他项目空间', action: createNewProject },
  ];
  if (pid !== 'default') {
    items.push({ icon: 'trash', label: '删除项目空间', danger: true, action: () => deleteProjectPrompt(pid, g.label) });
  }
  projectMenu.value = { anchor: e.currentTarget as HTMLElement, items };
}

async function createNewProject() {
  const nameOrId = await ui.prompt({
    title: '新建项目空间',
    message: '输入项目标识（字母、数字、短横线、中文，1–40 字符）',
    placeholder: '例如 app-backend 或 数据分析',
    confirmText: '创建项目',
  });
  if (!nameOrId?.trim()) return;
  const clean = nameOrId.trim();
  try {
    const created = await session.createProject(clean, clean);
    ui.toast(`已创建项目空间“${created.name}”`, { tone: 'success' });
    if (ui.chatGroupMode !== 'project') {
      ui.setChatGroupMode('project');
    }
  } catch (err: any) {
    ui.toast(err.message || '创建项目空间失败', { tone: 'error' });
  }
}

async function renameProjectPrompt(projectId: string, currentName: string) {
  const newName = await ui.prompt({
    title: '重命名项目空间',
    message: `修改“${currentName}”的显示名称`,
    defaultValue: currentName,
    placeholder: '输入新的项目名称',
    confirmText: '保存名称',
    maxLength: 40,
  });
  if (!newName?.trim() || newName.trim() === currentName) return;
  try {
    await session.renameProject(projectId, newName.trim());
    ui.toast('项目空间已重命名', { tone: 'success' });
  } catch (err: any) {
    ui.toast(err.message || '重命名失败', { tone: 'error' });
  }
}

async function deleteProjectPrompt(projectId: string, currentName: string) {
  if (projectId === 'default') {
    ui.toast('默认项目空间不可删除', { tone: 'warning' });
    return;
  }
  const ok = await ui.confirm({
    title: '删除项目空间',
      message: `确定删除项目“${currentName}”？请先删除关联对话；工作区文件夹会保留。`,
    confirmText: '删除空间',
    danger: true,
  });
  if (!ok) return;
  try {
    await session.deleteProject(projectId);
    ui.toast(`已删除项目空间“${currentName}”`, { tone: 'success' });
  } catch (err: any) {
    ui.toast(err.message || '删除失败', { tone: 'error' });
  }
}

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
// Admin-only: the full diagnostic bundle (session, turn events, runtime) for
// sending a bad turn back for investigation.
function exportBundle(c: Chat) { const a = document.createElement('a'); a.href = '/api/chats/export-bundle?chat=' + encodeURIComponent(c.id); a.click(); ui.toast('已开始导出完整日志包', { tone: 'success' }); }
async function removeChat(c: Chat) {
  if (!(await ui.confirm({ title: '删除任务', message: `删除“${c.title || '新任务'}”？此操作无法撤销，但会保留工作区文件。`, confirmText: '删除', danger: true }))) return;
  try { await post('/api/chats/delete', { thread: c.id }); session.chats = session.chats.filter(x => x.id !== c.id); if (session.chatId === c.id) session.startNew(); ui.toast('任务已删除', { tone: 'success' }); }
  catch (e: any) { ui.toast(e.message, { tone: 'error' }); }
}

function chatItems(c: Chat): MenuItem[] {
  return [
    { icon: 'edit', label: '重命名', action: () => rename(c) },
    { icon: 'pin', label: c.pinned ? '取消置顶' : '置顶对话', action: () => togglePin(c) },
    { icon: 'download', label: '导出 Markdown', action: () => exportChat(c, 'md') },
    { icon: 'download', label: '导出 JSON', action: () => exportChat(c, 'json') },
    ...(session.isAdmin ? [{ icon: 'package', label: '导出完整日志 (ZIP)', action: () => exportBundle(c) }] : []),
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

    <button class="new-chat" :disabled="!session.canExecute" @click="session.startNew(); if (ui.mobileDrawer) ui.mobileDrawer = null">
      <Icon name="plus" :size="18" /><span>新任务</span>
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
            v-if="ui.chatGroupMode === 'project'"
            type="button"
            class="icon-button mini"
            aria-label="新建项目空间"
            title="新建项目空间"
            @click="createNewProject"
          >
            <Icon name="plus" :size="15" />
          </button>
          <button
            type="button"
            class="icon-button mini"
            :aria-label="groupModeTitle"
            :title="groupModeTitle"
            :class="{ 'is-dim': ui.chatGroupMode === 'none' }"
            @click="cycleGroupMode"
          >
            <Icon :name="groupModeIcon" :size="15" />
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
            aria-label="筛选任务"
            title="筛选任务"
            @click="openSearch"
          >
            <Icon name="search" :size="15" />
          </button>
        </template>
      </div>
    </div>

    <div class="chat-list-shell">
    <nav ref="chatList" class="chat-list slim-scroll-target" :class="{ 'is-compact': ui.chatDensity === 'compact' }" aria-label="对话列表">
      <div v-if="session.chatsLoading && !session.chats.length" class="list-state"><span class="spinner"></span><span>正在读取对话…</span></div>
      <p v-else-if="session.chatsError && !session.chats.length" class="list-empty">{{ session.chatsError }}</p>
      <p v-else-if="!groups.length" class="list-empty">{{ !session.canExecute ? '开通执行权限后，可在这里管理对话。' : query ? '没有匹配的对话。' : '还没有对话，发送第一条消息后会出现在这里。' }}</p>
      <section v-for="g in groups" :key="g.key" class="chat-group">
        <header
          v-if="g.label"
          class="chat-group-head"
          :class="{ 'is-collapsed': isGroupCollapsed(g.key) }"
          @click="toggleGroup(g.key)"
        >
          <div class="chat-group-left">
            <Icon
              :name="isGroupCollapsed(g.key) ? 'chevron-right' : 'chevron-down'"
              :size="11"
              class="chat-group-caret"
            />
            <h2 class="chat-group-title">{{ g.label }}</h2>
            <span class="chat-group-count">{{ g.chats.length }}</span>
          </div>
          <div v-if="g.key.startsWith('proj:')" class="chat-group-actions" @click.stop>
            <button
              type="button"
              class="group-action-btn"
              :title="'以“' + g.label + '”为主空间新建任务'"
              :aria-label="'以“' + g.label + '”为主空间新建任务'"
              @click="startNewInGroup(g)"
            >
              <Icon name="plus" :size="12" />
            </button>
            <button
              type="button"
              class="group-action-btn"
              title="项目空间选项"
              aria-label="项目空间选项"
              @click="openProjectMenu($event, g)"
            >
              <Icon name="more-horizontal" :size="12" />
            </button>
          </div>
        </header>

        <ul v-show="!isGroupCollapsed(g.key)" class="chat-items">
          <li v-if="!g.chats.length" class="chat-group-empty" @click="startNewInGroup(g)">
            <span>暂无任务，点击开启</span>
          </li>
          <li v-for="c in g.chats" :key="c.id" class="chat-item" :class="{ 'is-active': c.id === session.chatId }">
            <button class="chat-select" :aria-current="c.id === session.chatId ? 'page' : undefined" :title="c.title" @click="pickChat(c)" @contextmenu="e => chatContext(e, c)">
              <span class="chat-title">{{ c.title || '新任务' }}</span>
              <span class="chat-meta"><span v-if="session.liveThread === c.id" class="chat-live-dot" title="正在生成回复" aria-label="正在生成回复"></span><span class="chat-time">{{ formatShort(c.updated) }}</span><Icon v-if="c.pinned" name="pin" :size="12" /><Icon v-if="c.archived" name="archive" :size="12" /></span>
            </button>
            <button class="icon-button chat-more" aria-label="对话操作" @click="e => openChatMenu(e, c)"><Icon name="more-horizontal" /></button>
          </li>
        </ul>
      </section>
    </nav>
    <SlimScrollRail :target="chatList" />
    </div>

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
    <DropMenu v-if="projectMenu" :anchor="projectMenu.anchor" :items="projectMenu.items" label="项目选项" @close="projectMenu = null" />
    <DropMenu v-if="accountMenu && accountMenuAnchor" :anchor="accountMenuAnchor" :items="accountMenu" label="账户菜单" up @close="accountMenu = null" />
  </aside>
</template>

<style src="./sidebar.css"></style>

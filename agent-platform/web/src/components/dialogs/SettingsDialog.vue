<script setup lang="ts">
import { computed } from 'vue';
import BaseDialog from './BaseDialog.vue';
import Icon from '../Icon.vue';
import ProvidersPanel from '../settings/ProvidersPanel.vue';
import GrantsPanel from '../settings/GrantsPanel.vue';
import PackagesPanel from '../settings/PackagesPanel.vue';
import ToolchainsPanel from '../settings/ToolchainsPanel.vue';
import { useUi, type SettingsTab, type ThinkingLevel } from '../../stores/ui';
import { useSession } from '../../stores/session';
import { post } from '../../services/api';
import { formatShort } from '../../services/format';

const ui = useUi();
const session = useSession();

const navItems = computed(() => {
  const items: { id: SettingsTab; icon: string; label: string; show: boolean }[] = [
    { id: 'general', icon: 'settings', label: '通用', show: true },
    { id: 'providers', icon: 'sparkle', label: '模型与供应商', show: session.isAdmin },
    { id: 'grants', icon: 'users', label: '执行授权与配额', show: session.isAdmin },
    { id: 'packages', icon: 'package', label: '扩展市场', show: session.isAdmin },
    { id: 'toolchains', icon: 'terminal', label: '工具链', show: session.canExecute },
    { id: 'archived', icon: 'archive', label: '已归档对话', show: true },
    { id: 'shortcuts', icon: 'keyboard', label: '快捷键', show: true },
  ];
  return items.filter(i => i.show);
});

const archived = computed(() => session.chats.filter(c => c.archived === true));
const thinkingOptions: { value: ThinkingLevel; label: string }[] = [
  { value: 'off', label: '关' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'max', label: '极高' },
];

const shortcutRows = [
  ['⌘ / Ctrl + K', '打开命令面板'],
  ['⌘ / Ctrl + ,', '打开设置'],
  ['⌘ / Ctrl + Shift + O', '新建对话'],
  ['Enter', '发送消息'],
  ['Shift + Enter', '输入换行'],
  ['⌘ / Ctrl + S', '在工作区编辑器中保存文件'],
  ['Esc', '关闭弹窗或菜单'],
];

async function unarchive(c: any) {
  try {
    await post('/api/chats/archive', { thread: c.id, archived: false });
    await session.loadChats();
    ui.toast('已恢复对话', { tone: 'success' });
  } catch (e: any) {
    ui.toast(e.message, { tone: 'error' });
  }
}
async function remove(c: any) {
  if (!(await ui.confirm({ title: '永久删除对话', message: `永久删除“${c.title || '新对话'}”？此操作无法撤销。`, confirmText: '删除', danger: true }))) return;
  try {
    await post('/api/chats/delete', { thread: c.id });
    session.chats = session.chats.filter(x => x.id !== c.id);
    ui.toast('对话已删除', { tone: 'success' });
  } catch (e: any) {
    ui.toast(e.message, { tone: 'error' });
  }
}
</script>

<template>
  <BaseDialog title="设置" xl>
    <div class="settings-shell">
      <nav class="settings-nav" aria-label="设置分类">
        <button
          v-for="item in navItems"
          :key="item.id"
          type="button"
          class="settings-tab"
          :class="{ 'is-active': ui.settingsTab === item.id }"
          @click="ui.settingsTab = item.id"
        >
          <Icon :name="item.icon" :size="16" />
          <span>{{ item.label }}</span>
        </button>
      </nav>

      <div class="settings-stage">
        <div v-if="ui.settingsTab === 'general'" class="settings-pad">
          <div class="setting-row">
            <div class="setting-info">
              <strong>外观主题</strong>
              <span>切换浅色或深色界面</span>
            </div>
            <div class="seg">
              <button type="button" :class="{ 'is-on': ui.theme === 'light' }" @click="ui.setTheme('light', $event)">浅色</button>
              <button type="button" :class="{ 'is-on': ui.theme === 'dark' }" @click="ui.setTheme('dark', $event)">深色</button>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <strong>对话列表视图</strong>
              <span>选择侧边栏对话记录的显示密度</span>
            </div>
            <div class="seg">
              <button type="button" :class="{ 'is-on': ui.chatDensity !== 'compact' }" @click="ui.setChatDensity('cozy')">舒适</button>
              <button type="button" :class="{ 'is-on': ui.chatDensity === 'compact' }" @click="ui.setChatDensity('compact')">紧凑</button>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <strong>按时间分组</strong>
              <span>将对话按今天、昨天、最近等时间段分组显示</span>
            </div>
            <div class="seg">
              <button type="button" :class="{ 'is-on': ui.chatGroupByDate }" @click="ui.setChatGroupByDate(true)">分组</button>
              <button type="button" :class="{ 'is-on': !ui.chatGroupByDate }" @click="ui.setChatGroupByDate(false)">平铺</button>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <strong>思考强度</strong>
              <span>控制支持推理的模型的默认思考深度</span>
            </div>
            <div class="seg">
              <button
                v-for="opt in thinkingOptions"
                :key="opt.value"
                type="button"
                :class="{ 'is-on': ui.thinkingLevel === opt.value }"
                @click="ui.setThinkingLevel(opt.value)"
              >{{ opt.label }}</button>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <strong>workspace 布局</strong>
              <span>打开文件时使用单栏标签页或双右栏并排预览</span>
            </div>
            <div class="seg">
              <button type="button" :class="{ 'is-on': !ui.workspaceDual }" @click="ui.setWorkspaceDual(false)">标签页</button>
              <button type="button" :class="{ 'is-on': ui.workspaceDual }" @click="ui.setWorkspaceDual(true)">双右栏</button>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <strong>账户</strong>
              <span>{{ session.auth?.user?.name || '当前登录用户' }}</span>
            </div>
          </div>
        </div>

        <ProvidersPanel v-else-if="ui.settingsTab === 'providers' && session.isAdmin" />
        <GrantsPanel v-else-if="ui.settingsTab === 'grants' && session.isAdmin" />
        <PackagesPanel v-else-if="ui.settingsTab === 'packages' && session.isAdmin" />
        <ToolchainsPanel v-else-if="ui.settingsTab === 'toolchains' && session.canExecute" />

        <div v-else-if="ui.settingsTab === 'archived'" class="settings-pad">
          <p v-if="!archived.length" class="list-empty-plain">没有已归档的对话。可在侧边栏对话菜单中归档。</p>
          <div v-else class="archive-list">
            <div v-for="c in archived" :key="c.id" class="archive-row">
              <div class="archive-info">
                <strong>{{ c.title || '新对话' }}</strong>
                <span>{{ formatShort(c.updated) }}</span>
              </div>
              <div class="archive-actions">
                <button type="button" class="btn btn-quiet btn-sm" @click="unarchive(c)">恢复</button>
                <button type="button" class="btn btn-quiet btn-sm is-danger" @click="remove(c)">删除</button>
              </div>
            </div>
          </div>
        </div>

        <div v-else-if="ui.settingsTab === 'shortcuts'" class="settings-pad">
          <div class="shortcut-list">
            <div v-for="[keys, desc] in shortcutRows" :key="keys" class="setting-row">
              <span class="shortcut-desc">{{ desc }}</span>
              <kbd class="shortcut-kbd">{{ keys }}</kbd>
            </div>
          </div>
        </div>
      </div>
    </div>
  </BaseDialog>
</template>

<style>
.settings-shell { flex: 1; min-height: 0; display: grid; grid-template-columns: 192px minmax(0, 1fr); overflow: hidden; }
.settings-nav { display: flex; flex-direction: column; gap: 3px; padding: 14px 10px; border-right: 1px solid var(--line); background: var(--sidebar); overflow-y: auto; }
.settings-tab { display: flex; align-items: center; gap: 10px; padding: 9px 11px; border-radius: 10px; color: var(--text-2); text-align: left; font-size: 13px; font-weight: 520; transition: background-color var(--fast), color var(--fast); }
.settings-tab:hover { background: color-mix(in srgb, var(--text) 5%, transparent); color: var(--text); }
.settings-tab.is-active { background: var(--surface); color: var(--text); font-weight: 600; box-shadow: var(--shadow-sm); }
.settings-tab svg { color: var(--muted); flex: none; }
.settings-tab.is-active svg { color: var(--ink); }

.settings-stage { min-width: 0; min-height: 0; height: 100%; overflow: hidden; display: flex; flex-direction: column; }
.settings-pad { padding: 18px 22px; overflow-y: auto; flex: 1; min-height: 0; }

.setting-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 0; border-bottom: 1px solid var(--line); }
.setting-row:last-child { border-bottom: 0; }
.setting-info { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.setting-info strong { font-size: 13.5px; font-weight: 600; }
.setting-info span { color: var(--muted); font-size: 12px; }

.seg { display: inline-flex; gap: 2px; padding: 3px; border-radius: 10px; background: color-mix(in srgb, var(--text) 4.8%, transparent); }
.seg button { height: 28px; padding: 0 12px; border-radius: 7px; color: var(--muted); font-size: 12px; font-weight: 540; transition: background-color var(--fast), color var(--fast); }
.seg button.is-on { background: var(--surface); color: var(--text); box-shadow: var(--shadow-sm); }

.archive-list { display: flex; flex-direction: column; }
.archive-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--line); }
.archive-row:last-child { border-bottom: 0; }
.archive-info { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.archive-info strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; font-weight: 600; }
.archive-info span { color: var(--muted); font-size: 11.5px; }
.archive-actions { display: flex; gap: 7px; flex: none; }

.shortcut-list { display: flex; flex-direction: column; }
.shortcut-desc { font-size: 13px; color: var(--text); }
.shortcut-kbd { padding: 4px 9px; border: 1px solid var(--line-2); border-radius: 7px; background: var(--surface-2); color: var(--text-2); font-family: var(--font-mono); font-size: 11.5px; }

@media (max-width: 720px) {
  .settings-shell { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
  .settings-nav { flex-direction: row; overflow-x: auto; overflow-y: hidden; scrollbar-width: none; -webkit-overflow-scrolling: touch; border-right: 0; border-bottom: 1px solid var(--line); padding: 7px 10px; gap: 4px; }
  .settings-nav::-webkit-scrollbar { display: none; }
  .settings-tab { flex: none; white-space: nowrap; padding: 6px 12px; font-size: 12.5px; }
}

@media (max-width: 640px) {
  .settings-pad { padding: 12px 16px 36px; }
  .setting-row {
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
    padding: 13px 0;
  }
  .setting-row .seg {
    width: 100%;
    display: flex;
  }
  .setting-row .seg button {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    text-align: center;
    padding: 0 4px;
    font-size: 12px;
    height: 32px;
  }
  .archive-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
  .archive-actions {
    width: 100%;
    justify-content: flex-end;
  }
}
</style>

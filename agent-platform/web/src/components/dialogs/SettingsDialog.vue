<script setup lang="ts">
import { ref, computed } from 'vue';
import BaseDialog from './BaseDialog.vue';
import Icon from '../Icon.vue';
import { useUi } from '../../stores/ui';
import { useSession } from '../../stores/session';
import { post } from '../../services/api';
import { formatShort } from '../../services/format';

const ui = useUi();
const session = useSession();
const tab = ref<'general' | 'archived' | 'about'>('general');

const archived = computed(() => session.chats.filter(c => c.archived === true));

async function unarchive(c: any) {
  try { await post('/api/chats/archive', { thread: c.id, archived: false }); await session.loadChats(); ui.toast('已恢复对话', { tone: 'success' }); }
  catch (e: any) { ui.toast(e.message, { tone: 'error' }); }
}
async function remove(c: any) {
  if (!confirm('永久删除“' + c.title + '”？此操作无法撤销。')) return;
  try { await post('/api/chats/delete', { thread: c.id }); session.chats = session.chats.filter(x => x.id !== c.id); ui.toast('对话已删除', { tone: 'success' }); }
  catch (e: any) { ui.toast(e.message, { tone: 'error' }); }
}
</script>

<template>
  <BaseDialog title="设置" wide>
    <div class="settings-layout">
      <nav class="settings-nav">
        <button class="settings-tab" :class="{ 'is-active': tab === 'general' }" @click="tab = 'general'"><Icon name="settings" :size="16" /><span>通用</span></button>
        <button class="settings-tab" :class="{ 'is-active': tab === 'archived' }" @click="tab = 'archived'"><Icon name="archive" :size="16" /><span>已归档对话</span></button>
        <button v-if="session.isAdmin" class="settings-tab" :class="{ 'is-active': false }" @click="ui.openDialog('provider')"><Icon name="code" :size="16" /><span>模型与供应商</span></button>
        <button class="settings-tab" :class="{ 'is-active': tab === 'about' }" @click="tab = 'about'"><Icon name="info" :size="16" /><span>关于</span></button>
      </nav>
      <div class="settings-panel">
        <template v-if="tab === 'general'">
          <div class="setting-row">
            <div class="setting-info"><strong>主题</strong><span>浅色 / 深色外观</span></div>
            <div class="seg">
              <button :class="{ 'is-on': ui.theme === 'light' }" @click="ui.theme === 'dark' && ui.toggleTheme()">浅色</button>
              <button :class="{ 'is-on': ui.theme === 'dark' }" @click="ui.theme === 'light' && ui.toggleTheme()">深色</button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-info"><strong>当前模型</strong><span>{{ session.modelLabel }}</span></div>
            <button class="btn btn-quiet" @click="session.isAdmin ? ui.openDialog('provider') : null" :disabled="!session.isAdmin">{{ session.isAdmin ? '管理' : '由管理员配置' }}</button>
          </div>
          <div class="setting-row">
            <div class="setting-info"><strong>快捷键</strong><span>查看全部键盘快捷键</span></div>
            <button class="btn btn-quiet" @click="ui.openDialog('shortcuts')">查看</button>
          </div>
        </template>

        <template v-else-if="tab === 'archived'">
          <p v-if="!archived.length" class="hint">没有已归档的对话。在对话右键或菜单里可归档。</p>
          <div v-else class="archive-list">
            <div v-for="c in archived" :key="c.id" class="archive-row">
              <div class="archive-info"><strong>{{ c.title || '新对话' }}</strong><span>{{ formatShort(c.updated) }}</span></div>
              <div class="archive-actions">
                <button class="btn btn-quiet" @click="unarchive(c)">恢复</button>
                <button class="btn btn-quiet is-danger" @click="remove(c)">删除</button>
              </div>
            </div>
          </div>
        </template>

        <template v-else>
          <div class="about">
            <span class="about-mark"><Icon name="iris" :size="40" /></span>
            <h3>Iris</h3>
            <p class="hint">Agent 工作台 · 在独立沙箱中完成文件与代码任务。</p>
          </div>
        </template>
      </div>
    </div>
  </BaseDialog>
</template>

<style>
.settings-layout { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 0; margin: -18px -21px -20px; min-height: 340px; }
.settings-nav { display: flex; flex-direction: column; gap: 2px; padding: 15px 12px; border-right: 1px solid var(--line); background: var(--surface-2); }
.settings-tab { display: flex; align-items: center; gap: 10px; padding: 9px 11px; border-radius: 10px; color: var(--text-2); text-align: left; font-size: 13px; transition: background-color var(--fast), color var(--fast); }
.settings-tab:hover { background: color-mix(in srgb, var(--text) 5%, transparent); color: var(--text); }
.settings-tab.is-active { background: var(--accent-soft); color: var(--text); }
.settings-tab svg { color: var(--muted); }
.settings-tab.is-active svg { color: var(--accent); }
.settings-panel { padding: 18px 20px; overflow-y: auto; }
.setting-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 13px 0; border-bottom: 1px solid var(--line); }
.setting-row:last-child { border-bottom: 0; }
.setting-info { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.setting-info strong { font-size: 13.5px; font-weight: 600; }
.setting-info span { color: var(--muted); font-size: 11.5px; }
.seg { display: flex; gap: 2px; padding: 3px; border-radius: 10px; background: var(--surface-2); border: 1px solid var(--line-2); }
.seg button { height: 28px; padding: 0 12px; border-radius: 7px; color: var(--muted); font-size: 12px; }
.seg button.is-on { background: var(--surface); color: var(--text); box-shadow: var(--shadow-sm); }
.archive-list { display: flex; flex-direction: column; }
.archive-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 0; border-bottom: 1px solid var(--line); }
.archive-row:last-child { border-bottom: 0; }
.archive-info { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.archive-info strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 600; }
.archive-info span { color: var(--muted); font-size: 11px; }
.archive-actions { display: flex; gap: 7px; flex: none; }
.archive-actions .btn { min-height: 30px; padding: 0 12px; font-size: 12px; }
.about { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 30px 0; color: var(--ink); }
.about-mark { color: var(--ink); margin-bottom: 10px; }
.about h3 { margin: 0 0 6px; font-family: var(--font-display); font-size: 22px; font-weight: 650; }
@media (max-width: 640px) { .settings-layout { grid-template-columns: minmax(0, 1fr); } .settings-nav { flex-direction: row; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--line); } }
</style>

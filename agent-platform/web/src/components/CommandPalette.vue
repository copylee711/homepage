<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import Icon from './Icon.vue';
import { useSession } from '../stores/session';
import { useUi } from '../stores/ui';

const session = useSession();
const ui = useUi();
const query = ref('');
const active = ref(0);
const input = ref<HTMLInputElement | null>(null);

interface Cmd { id: string; icon: string; label: string; hint?: string; run: () => void; }

const commands = computed<Cmd[]>(() => {
  const a = session.auth;
  const base: Cmd[] = [
    { id: 'new', icon: 'plus', label: '新建对话', hint: '⌘⇧O', run: () => session.startNew() },
    { id: 'theme', icon: ui.theme === 'dark' ? 'sun' : 'moon', label: ui.theme === 'dark' ? '切换到浅色主题' : '切换到深色主题', run: () => ui.toggleTheme() },
    a?.can_execute ? { id: 'workspace', icon: 'panel-right', label: ui.workspaceOpen ? '关闭工作区' : '打开工作区', run: () => ui.setWorkspaceOpen(!ui.workspaceOpen) } : null,
    a?.can_execute ? { id: 'webread', icon: 'globe', label: '网页阅读', run: () => ui.openDialog('webread') } : null,
    { id: 'settings', icon: 'settings', label: '打开设置', run: () => ui.openSettings('general') },
    a?.admin ? { id: 'providers', icon: 'sparkle', label: '设置 · 模型与供应商', run: () => ui.openSettings('providers') } : null,
    a?.admin ? { id: 'grants', icon: 'users', label: '设置 · 执行授权与配额', run: () => ui.openSettings('grants') } : null,
    a?.admin ? { id: 'packages', icon: 'package', label: '设置 · 扩展市场', run: () => ui.openSettings('packages') } : null,
    a?.can_execute ? { id: 'toolchains', icon: 'terminal', label: '设置 · 工具链', run: () => ui.openSettings('toolchains') } : null,
    { id: 'archived', icon: 'archive', label: '设置 · 已归档对话', run: () => ui.openSettings('archived') },
    { id: 'shortcuts', icon: 'keyboard', label: '设置 · 键盘快捷键', run: () => ui.openSettings('shortcuts') },
  ].filter(Boolean) as Cmd[];
  const q = query.value.trim().toLowerCase();
  const chatCmds: Cmd[] = session.chats
    .filter(c => !c.archived)
    .filter(c => !q || (c.title || '').toLowerCase().includes(q))
    .slice(0, 6)
    .map(c => ({ id: 'chat:' + c.id, icon: 'message', label: c.title || '新对话', hint: '对话', run: () => session.selectChat(c.id) }));
  const filteredBase = base.filter(c => !q || c.label.toLowerCase().includes(q));
  return [...filteredBase, ...chatCmds];
});

function choose(i: number) {
  const cmd = commands.value[i]; if (!cmd) return;
  ui.closeCommand(); cmd.run();
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') { e.preventDefault(); active.value = Math.min(active.value + 1, commands.value.length - 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); active.value = Math.max(active.value - 1, 0); }
  else if (e.key === 'Enter') { e.preventDefault(); choose(active.value); }
  else if (e.key === 'Escape') { e.preventDefault(); ui.closeCommand(); }
}
onMounted(() => { setTimeout(() => input.value?.focus(), 30); });
</script>

<template>
  <teleport to="body">
    <div class="command-palette" @click.self="ui.closeCommand()">
      <div class="command-panel" role="dialog" aria-modal="true" aria-label="命令面板" @keydown="onKey">
        <div class="command-field">
          <span class="search-icon"><Icon name="search" :size="17" /></span>
          <input ref="input" v-model="query" type="text" placeholder="搜索对话、运行命令…" autocomplete="off" spellcheck="false" @input="active = 0">
          <kbd>Esc</kbd>
        </div>
        <div class="command-results" role="listbox">
          <p v-if="!commands.length" class="command-empty">没有匹配的命令。</p>
          <button v-for="(c, i) in commands" :key="c.id" type="button" class="command-item" :class="{ 'is-active': i === active }" role="option" :aria-selected="i === active" @mouseenter="active = i" @click="choose(i)">
            <span class="c-icon"><Icon :name="c.icon" :size="15" /></span>
            <span class="c-label">{{ c.label }}</span>
            <span v-if="c.hint" class="c-hint">{{ c.hint }}</span>
          </button>
        </div>
        <div class="command-foot"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>↵</kbd> 执行</span><span><kbd>Esc</kbd> 关闭</span></div>
      </div>
    </div>
  </teleport>
</template>

<style>
.command-palette { position: fixed; inset: 0; z-index: 150; display: flex; align-items: flex-start; justify-content: center; padding: clamp(44px, 13vh, 150px) 16px 16px; background: rgba(12, 13, 18, 0.5); backdrop-filter: blur(5px); -webkit-backdrop-filter: blur(5px); animation: fade-in 140ms var(--ease); }
.command-panel { position: relative; width: min(640px, 100%); max-height: min(70dvh, 560px); display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--line-2); border-radius: 20px; background: var(--surface); box-shadow: var(--shadow-lg); animation: command-in 200ms var(--ease); }
@keyframes command-in { from { opacity: 0; transform: translateY(-10px) scale(0.98); } to { opacity: 1; transform: none; } }
.command-field { display: flex; align-items: center; gap: 10px; padding: 15px 16px; border-bottom: 1px solid var(--line); }
.command-field .search-icon { color: var(--muted); display: flex; }
.command-field input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--text); font-size: 16px; }
.command-field input::placeholder { color: var(--muted); }
.command-results { flex: 1; min-height: 0; overflow-y: auto; padding: 7px; }
.command-item { width: 100%; display: flex; align-items: center; gap: 11px; padding: 10px 11px; border-radius: 11px; color: var(--text-2); text-align: left; font-size: 13.5px; }
.command-item .c-icon { width: 28px; height: 28px; flex: none; display: grid; place-items: center; border-radius: 9px; background: color-mix(in srgb, var(--text) 5%, transparent); color: var(--muted); }
.command-item .c-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.command-item .c-hint { flex: none; color: var(--faint); font-size: 10.5px; }
.command-item.is-active { background: color-mix(in srgb, var(--text) 6%, transparent); color: var(--text); }
.command-item.is-active .c-icon { background: var(--ink); color: var(--surface); }
.command-empty { padding: 26px; text-align: center; color: var(--muted); font-size: 13px; }
.command-foot { display: flex; align-items: center; gap: 15px; padding: 9px 16px; border-top: 1px solid var(--line); color: var(--faint); font-size: 10.5px; }
.command-foot span { display: inline-flex; align-items: center; gap: 5px; }
</style>

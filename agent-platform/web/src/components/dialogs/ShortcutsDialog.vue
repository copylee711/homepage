<script setup lang="ts">
import BaseDialog from './BaseDialog.vue';
const mac = /Mac|iPhone|iPad/.test(navigator.platform || '');
const mod = mac ? '⌘' : 'Ctrl+';
const rows = [
  [mod + 'K', '搜索与命令面板'],
  [mod + 'Shift+O', '新建对话'],
  ['Enter', '发送任务'],
  ['Shift+Enter', '换行'],
  ['Esc', '关闭菜单、对话框或抽屉'],
];
</script>

<template>
  <BaseDialog title="键盘快捷键" subtitle="在输入框外也可以使用。">
    <div class="shortcut-list">
      <div v-for="(r, i) in rows" :key="i" class="shortcut-row"><span>{{ r[1] }}</span><kbd>{{ r[0] }}</kbd></div>
    </div>
  </BaseDialog>
</template>

<style>
.shortcut-list { display: flex; flex-direction: column; }
.shortcut-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 38px; border-bottom: 1px solid var(--line); font-size: 13px; color: var(--text-2); }
.shortcut-row:last-child { border-bottom: 0; }
</style>

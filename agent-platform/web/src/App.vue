<script setup lang="ts">
import { onMounted, computed, ref } from 'vue';
import Sidebar from './components/Sidebar.vue';
import TopBar from './components/TopBar.vue';
import Conversation from './components/Conversation.vue';
import Composer from './components/Composer.vue';
import Workspace from './components/Workspace.vue';
import Toasts from './components/Toasts.vue';
import ContextMenu from './components/ContextMenu.vue';
import CommandPalette from './components/CommandPalette.vue';
import ModalHost from './components/ModalHost.vue';
import SettingsDialog from './components/dialogs/SettingsDialog.vue';
import SubordinateDialog from './components/dialogs/SubordinateDialog.vue';
import { useSession } from './stores/session';
import { useUi } from './stores/ui';

const session = useSession();
const ui = useUi();

const wide = ref(window.innerWidth > 1180);

const shellStyle = computed(() => ({
  '--sidebar-w': ui.sidebarW + 'px',
  '--workspace-w': ui.workspaceW + 'px',
}));
const workspaceVisible = computed(() => session.canExecute && ui.workspaceOpen && wide.value);

function onResize() {
  wide.value = window.innerWidth > 1180;
  if (wide.value && ui.mobileDrawer === 'workspace') { ui.mobileDrawer = null; ui.setWorkspaceOpen(true); }
  if (window.innerWidth > 860 && ui.mobileDrawer === 'sidebar') ui.mobileDrawer = null;
}

onMounted(() => {
  session.boot();
  window.addEventListener('resize', onResize, { passive: true });
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); ui.commandOpen ? ui.closeCommand() : ui.openCommand(); }
    if (mod && e.key === ',') { e.preventDefault(); ui.dialog === 'settings' ? ui.closeDialog() : ui.openSettings('general'); }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); session.startNew(); }
  });
});
</script>

<template>
  <div class="app" :style="shellStyle" :data-sidebar="ui.sidebarOpen ? 'open' : 'closed'" :data-workspace="workspaceVisible ? 'open' : 'closed'">
    <Sidebar class="app-sidebar" />
    <main class="main-col">
      <TopBar />
      <Conversation />
      <Composer v-if="session.canExecute" />
    </main>
    <Workspace v-if="session.canExecute" class="app-workspace" :aria-hidden="!workspaceVisible" :inert="!workspaceVisible" />

    <!-- mobile drawers -->
    <div v-if="ui.mobileDrawer" class="scrim" @click="ui.mobileDrawer = null"></div>
    <div v-if="ui.mobileDrawer === 'sidebar'" class="mobile-drawer left"><Sidebar /></div>
    <div v-if="ui.mobileDrawer === 'workspace'" class="mobile-drawer right"><Workspace /></div>

    <Toasts />
    <ContextMenu />
    <CommandPalette v-if="ui.commandOpen" />
    <SettingsDialog v-if="ui.dialog === 'settings'" />
    <SubordinateDialog v-if="ui.dialog === 'add-subordinate'" />
    <ModalHost />
  </div>
</template>

<style>
.app {
  height: 100dvh;
  display: grid;
  grid-template-columns: var(--sidebar-w) minmax(0, 1fr) var(--workspace-w);
  overflow: hidden;
  transition: grid-template-columns var(--slow) var(--ease);
}
.app[data-sidebar='closed'] {
  grid-template-columns: 0 minmax(0, 1fr) var(--workspace-w);
}
.app[data-workspace='closed'] {
  grid-template-columns: var(--sidebar-w) minmax(0, 1fr) 0;
}
.app[data-sidebar='closed'][data-workspace='closed'] {
  grid-template-columns: 0 minmax(0, 1fr) 0;
}

.app-sidebar {
  min-width: 0;
  overflow: hidden;
  transition: opacity var(--dur) var(--ease);
}
.app[data-sidebar='closed'] .app-sidebar {
  opacity: 0;
  pointer-events: none;
}

.main-col {
  position: relative;
  min-width: 0;
  min-height: 0;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg);
}

.app-workspace {
  min-width: 0;
  overflow: hidden;
  transition: opacity var(--dur) var(--ease), border-color var(--dur) var(--ease);
}
.app[data-workspace='closed'] .app-workspace {
  opacity: 0;
  pointer-events: none;
  border-left-color: transparent;
}

.scrim { position: fixed; inset: 0; z-index: 50; background: rgba(12, 13, 18, 0.48); backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px); }
.mobile-drawer { position: fixed; top: 0; bottom: 0; z-index: 60; box-shadow: 0 18px 56px rgba(0, 0, 0, 0.42), var(--shadow-lg); animation: drawer-in var(--slow) var(--ease); overflow: hidden; }
.mobile-drawer.left { left: 0; width: min(86vw, 320px); border-radius: 0 22px 22px 0; border-right: 1px solid var(--line); }
.mobile-drawer.right { right: 0; width: min(92vw, 404px); border-radius: 22px 0 0 22px; border-left: 1px solid var(--line); }
.mobile-drawer .sidebar, .mobile-drawer .workspace { border-radius: inherit; width: 100%; }
@keyframes drawer-in { from { transform: translateX(var(--from, -104%)); } to { transform: translateX(0); } }
.mobile-drawer.right { --from: 104%; }

@media (max-width: 860px) {
  .app,
  .app[data-sidebar='open'],
  .app[data-sidebar='closed'],
  .app[data-workspace='open'],
  .app[data-workspace='closed'],
  .app[data-sidebar='closed'][data-workspace='closed'] {
    grid-template-columns: 1fr;
  }
  .app-sidebar { display: none; }
  .app-workspace { display: none; }
  .main-col { width: 100%; }
}
</style>

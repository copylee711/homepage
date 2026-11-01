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
import WebReadDialog from './components/dialogs/WebReadDialog.vue';
import SettingsDialog from './components/dialogs/SettingsDialog.vue';
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

function onResize() { wide.value = window.innerWidth > 1180; }

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
    <main class="main">
      <div class="main-col">
        <TopBar />
        <Conversation />
        <Composer />
      </div>
      <Workspace v-if="workspaceVisible" />
    </main>

    <!-- mobile drawers -->
    <div v-if="ui.mobileDrawer" class="scrim" @click="ui.mobileDrawer = null"></div>
    <div v-if="ui.mobileDrawer === 'sidebar'" class="mobile-drawer left"><Sidebar /></div>
    <div v-if="ui.mobileDrawer === 'workspace'" class="mobile-drawer right"><Workspace /></div>

    <Toasts />
    <ContextMenu />
    <CommandPalette v-if="ui.commandOpen" />
    <SettingsDialog v-if="ui.dialog === 'settings'" />
    <WebReadDialog v-if="ui.dialog === 'webread'" />
    <ModalHost />
  </div>
</template>

<style>
.app { height: 100dvh; display: grid; grid-template-columns: var(--sidebar-w) minmax(0, 1fr); overflow: hidden; transition: grid-template-columns var(--slow) var(--ease); }
.app[data-sidebar='closed'] { grid-template-columns: 0 minmax(0, 1fr); }
.app-sidebar { min-width: 0; }
.app[data-sidebar='closed'] .app-sidebar { opacity: 0; pointer-events: none; }
.main { grid-column: 2; min-width: 0; min-height: 0; height: 100dvh; display: flex; overflow: hidden; background: var(--bg); }
.main-col { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }

.scrim { position: fixed; inset: 0; z-index: 50; background: rgba(12, 13, 18, 0.48); backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px); }
.mobile-drawer { position: fixed; top: 0; bottom: 0; z-index: 60; box-shadow: var(--shadow-lg); animation: drawer-in var(--slow) var(--ease); }
.mobile-drawer.left { left: 0; width: min(86vw, 316px); }
.mobile-drawer.right { right: 0; width: min(92vw, 404px); }
@keyframes drawer-in { from { transform: translateX(var(--from, -104%)); } to { transform: translateX(0); } }
.mobile-drawer.right { --from: 104%; }

@media (max-width: 860px) {
  .app { grid-template-columns: minmax(0, 1fr); }
  .app[data-sidebar] { grid-template-columns: minmax(0, 1fr); }
  .app > .app-sidebar { display: none; }
}
</style>

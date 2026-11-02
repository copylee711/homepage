<script setup lang="ts">
import { useUi } from '../stores/ui';
import Icon from './Icon.vue';
const ui = useUi();
</script>

<template>
  <div class="toasts" aria-label="通知">
    <transition-group name="toast">
      <div v-for="t in ui.toasts" :key="t.id" class="toast" :class="'tone-' + t.tone" :role="t.tone === 'error' ? 'alert' : 'status'">
        <span class="toast-text">{{ t.message }}</span>
        <button v-if="t.action" type="button" class="toast-action" @click="() => { ui.dismissToast(t.id); t.action!.run(); }">{{ t.action.label }}</button>
        <button type="button" class="toast-close" aria-label="关闭通知" @click="ui.dismissToast(t.id)"><Icon name="x" :size="15" /></button>
      </div>
    </transition-group>
  </div>
</template>

<style>
.toasts { position: fixed; right: max(18px, env(safe-area-inset-right)); bottom: max(18px, env(safe-area-inset-bottom)); z-index: 120; width: min(392px, calc(100vw - 24px)); display: flex; flex-direction: column; gap: 9px; pointer-events: none; }
.toast { display: flex; align-items: center; gap: 9px; padding: 12px 11px 12px 14px; border: 1px solid var(--line-2); border-radius: 14px; background: var(--surface); color: var(--text-2); font-size: 12.5px; box-shadow: var(--shadow-lg); pointer-events: auto; }
.toast::before { content: ''; width: 4px; align-self: stretch; border-radius: 4px; background: var(--muted); flex: none; }
.toast.tone-success::before { background: var(--ok); }
.toast.tone-warning::before { background: var(--warn); }
.toast.tone-error::before { background: var(--danger); }
.toast-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.toast-action { flex: none; color: var(--accent-ink); font-size: 12px; font-weight: 600; padding: 2px 3px; border-radius: 5px; }
.toast-action:hover { text-decoration: underline; text-underline-offset: 2px; }
.toast-close { width: 23px; height: 23px; flex: none; display: inline-flex; align-items: center; justify-content: center; border-radius: 7px; color: var(--muted); }
.toast-close:hover { background: color-mix(in srgb, var(--text) 7%, transparent); color: var(--text); }
.toast-enter-active, .toast-leave-active { transition: opacity 180ms var(--ease), transform 200ms var(--ease); }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateY(10px) scale(0.98); }
</style>

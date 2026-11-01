<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue';
import Icon from '../Icon.vue';
import { useUi } from '../../stores/ui';

defineProps<{ title: string; subtitle?: string; wide?: boolean; xl?: boolean }>();
const ui = useUi();
function onKey(e: KeyboardEvent) {
  if (e.defaultPrevented || ui.modal || ui.context) return;
  if (document.querySelector('.iris-select-pop, .drop-menu, .model-menu')) return;
  if (e.key === 'Escape') { e.preventDefault(); ui.closeDialog(); }
}
onMounted(() => document.addEventListener('keydown', onKey));
onBeforeUnmount(() => document.removeEventListener('keydown', onKey));
</script>

<template>
  <teleport to="body">
    <div class="dialog-backdrop" @click.self="ui.closeDialog()">
      <div class="dialog" :class="{ 'dialog-wide': wide, 'dialog-xl': xl }" role="dialog" aria-modal="true">
        <div class="dialog-heading">
          <div><h2>{{ title }}</h2><p v-if="subtitle">{{ subtitle }}</p></div>
          <button class="icon-button" aria-label="关闭" title="关闭" @click="ui.closeDialog()"><Icon name="x" /></button>
        </div>
        <div class="dialog-body"><slot /></div>
      </div>
    </div>
  </teleport>
</template>

<style>
.dialog-backdrop { position: fixed; inset: 0; z-index: 140; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(12, 13, 18, 0.48); backdrop-filter: blur(5px); -webkit-backdrop-filter: blur(5px); animation: fade-in 160ms var(--ease); }
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
.dialog { width: min(580px, 100%); max-height: min(88dvh, 840px); display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--line-2); border-radius: 20px; background: var(--surface); color: var(--text); box-shadow: var(--shadow-lg); animation: dialog-in 180ms var(--ease); }
.dialog-wide { width: min(800px, 100%); }
.dialog-xl { width: min(940px, 100%); height: min(84dvh, 720px); }
@keyframes dialog-in { from { opacity: 0; transform: translateY(8px) scale(0.99); } to { opacity: 1; transform: none; } }
.dialog-heading { flex: none; display: flex; align-items: center; gap: 11px; padding: 16px 16px 14px 22px; border-bottom: 1px solid var(--line); }
.dialog-heading > div { flex: 1; min-width: 0; }
.dialog-heading h2 { margin: 0; font-family: var(--font-display); font-size: 18px; font-weight: 640; line-height: 1.35; letter-spacing: -0.005em; }
.dialog-heading p { margin: 4px 0 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
.dialog-heading .icon-button { width: 34px; height: 34px; flex: none; display: inline-flex; align-items: center; justify-content: center; border-radius: 10px; color: var(--text-2); }
.dialog-heading .icon-button:hover { background: color-mix(in srgb, var(--text) 7%, transparent); color: var(--text); }
.dialog-body { flex: 1; min-height: 0; padding: 18px 22px 20px; overflow-y: auto; }
.dialog-xl .dialog-body { padding: 0; overflow: hidden; display: flex; flex-direction: column; }
.dialog-actions { display: flex; align-items: center; justify-content: flex-end; gap: 9px; margin-top: 18px; padding-top: 15px; border-top: 1px solid var(--line); }

.field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.field + .field, .field-grid + .field, .field + .field-grid { margin-top: 14px; }
.field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; align-items: start; }
.field-grid > .field { margin-top: 0; }
.field-label { color: var(--text-2); font-size: 12px; font-weight: 560; line-height: 1.4; }
.field input:not([type="checkbox"]):not([type="radio"]):not([type="file"]), .field textarea { width: 100%; min-height: 39px; padding: 8px 12px; border: 1px solid var(--line-strong); border-radius: 10px; outline: 0; background: var(--surface-2); color: var(--text); font-size: 13px; transition: border-color var(--fast), box-shadow var(--fast), background-color var(--fast); }
.field input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):focus, .field textarea:focus { border-color: var(--accent); box-shadow: var(--ring); background: var(--surface); }
.field input[aria-invalid="true"] { border-color: var(--danger); }
.field-error { color: var(--danger); font-size: 11px; }
.hint { margin: 0; color: var(--muted); font-size: 11.5px; line-height: 1.55; }
.btn { min-height: 36px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 0 14px; border: 1px solid transparent; border-radius: 10px; font-size: 13px; font-weight: 560; white-space: nowrap; transition: background-color var(--fast), border-color var(--fast), color var(--fast), filter var(--fast), opacity var(--fast); }
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
.btn-solid { background: var(--ink); color: var(--surface); }
.btn-solid:hover:not(:disabled) { filter: brightness(1.12); }
.btn-quiet { border-color: var(--line-2); background: var(--surface); color: var(--text-2); }
.btn-quiet:hover:not(:disabled) { background: color-mix(in srgb, var(--text) 4%, transparent); color: var(--text); border-color: var(--line-strong); }
.btn-quiet.is-danger { color: var(--danger); }
.btn-quiet.is-danger:hover:not(:disabled) { background: var(--danger-soft); border-color: color-mix(in srgb, var(--danger) 30%, transparent); }
.btn-danger { background: var(--danger); color: #fff; }
.provider-status { margin: 11px 0 0; color: var(--muted); font-size: 12px; line-height: 1.55; }
.provider-status.is-success { color: var(--ok); }
.provider-status.is-error { color: var(--danger); }
@media (max-width: 600px) {
  .field-grid { grid-template-columns: minmax(0, 1fr); }
  .dialog-xl { height: 92dvh; }
}
</style>

<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import Icon from './Icon.vue';
import { useUi } from '../stores/ui';

export interface MenuItem {
  icon?: string;
  label?: string;
  danger?: boolean;
  disabled?: boolean;
  divider?: boolean;
  header?: string;
  type?: 'default' | 'subordinate';
  permission?: 'read' | 'write';
  onSetPermission?: (perm: 'read' | 'write') => void;
  onRemove?: () => void;
  action?: () => void;
}
const props = defineProps<{ anchor: HTMLElement; items: MenuItem[]; label?: string; up?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const ui = useUi();
const root = ref<HTMLElement | null>(null);
const pos = ref({ left: 0, top: 0 });

watch(() => [ui.dialog, ui.modal], ([d, m]) => {
  if (d || m) emit('close');
});

function place() {
  const el = root.value; if (!el) return;
  const r = props.anchor.getBoundingClientRect();
  const w = el.offsetWidth || 200, h = el.offsetHeight || 240;
  // Open to the right of the anchor when that fits; the anchored chip is often
  // near the left edge, where right-aligning would push the menu off-screen.
  let left = r.left;
  if (left + w > window.innerWidth - 8) left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
  left = Math.max(8, left);
  let top = props.up ? r.top - h - 6 : r.bottom + 6;
  if (!props.up && top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  if (props.up && top < 8) top = Math.min(r.bottom + 6, window.innerHeight - h - 8);
  pos.value = { left: Math.round(left), top: Math.round(top) };
}
function onDocPointer(e: PointerEvent) {
  if (!root.value) return;
  if (!root.value.contains(e.target as Node) && !props.anchor.contains(e.target as Node)) emit('close');
}
function onResize() { emit('close'); }
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); emit('close'); props.anchor.focus(); return; }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const buttons = Array.from(root.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []);
  if (!buttons.length) return;
  e.preventDefault();
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1
    : (index + (e.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
  buttons[next].focus();
}

onMounted(async () => {
  await nextTick(); place();
  setTimeout(() => document.addEventListener('pointerdown', onDocPointer, true), 0);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onResize, { passive: true });
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointer, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', onResize);
});
</script>

<template>
  <teleport to="body">
    <div class="menu" ref="root" role="menu" :aria-label="label" :style="{ left: pos.left + 'px', top: pos.top + 'px' }">
      <template v-for="(it, i) in items" :key="i">
        <div v-if="it.header" class="menu-header">{{ it.header }}</div>
        <div v-else-if="it.divider" class="menu-divider" role="separator"></div>
        <div v-else-if="it.type === 'subordinate'" class="menu-sub-row" role="none">
          <div class="menu-sub-info">
            <Icon :name="it.icon || 'folder'" :size="15" />
            <span class="menu-sub-name" :title="it.label">{{ it.label }}</span>
          </div>
          <div class="menu-sub-controls" @click.stop>
            <div class="menu-sub-seg" role="group" aria-label="从属空间权限">
              <button
                type="button"
                class="menu-sub-seg-btn"
                :disabled="it.disabled"
                :class="{ 'is-active': it.permission === 'read' }"
                @click="it.onSetPermission?.('read')"
              >只读</button>
              <button
                type="button"
                class="menu-sub-seg-btn"
                :disabled="it.disabled"
                :class="{ 'is-active': it.permission === 'write' }"
                @click="it.onSetPermission?.('write')"
              >读写</button>
            </div>
            <button
              type="button"
              class="menu-sub-remove-btn"
              :disabled="it.disabled"
              title="移除该从属空间授权"
              aria-label="移除该从属空间授权"
              @click="it.onRemove?.()"
            >
              <Icon name="x" :size="12" />
            </button>
          </div>
        </div>
        <button v-else type="button" class="menu-item" :class="{ 'is-danger': it.danger }"
          :disabled="it.disabled" role="menuitem" @click="() => { if (!it.disabled) { emit('close'); it.action?.(); } }">
          <Icon v-if="it.icon" :name="it.icon" :size="16" />
          <span class="menu-label">{{ it.label }}</span>
        </button>
      </template>
    </div>
  </teleport>
</template>

<style>
.menu { position: fixed; z-index: 160; min-width: 250px; padding: 6px; border: 1px solid var(--line-2); border-radius: 14px; background: var(--surface); box-shadow: var(--shadow-lg); animation: menu-in 130ms var(--ease); }
@keyframes menu-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
.menu-divider { height: 1px; margin: 5px -6px; background: var(--line-2); }
.menu-header { padding: 6px 9px 4px; font-size: 11px; font-weight: 650; color: var(--muted); letter-spacing: 0.02em; user-select: none; }
.menu-item { width: 100%; min-height: 34px; display: flex; align-items: center; gap: 10px; padding: 7px 9px; border-radius: 9px; color: var(--text-2); text-align: left; font-size: 13px; transition: background-color var(--fast), color var(--fast); }
.menu-item:hover:not(:disabled), .menu-item:focus-visible { background: color-mix(in srgb, var(--text) 6%, transparent); color: var(--text); outline: 0; }
.menu-item:disabled { opacity: 0.45; }
.menu-item svg { color: var(--muted); }
.menu-item.is-danger { color: var(--danger); }
.menu-item.is-danger svg { color: var(--danger); }
.menu-label { flex: 1; }

.menu-sub-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 36px;
  padding: 5px 8px;
  border-radius: 9px;
  transition: background-color var(--fast);
}
.menu-sub-row:hover {
  background: color-mix(in srgb, var(--text) 4%, transparent);
}
.menu-sub-info {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
.menu-sub-info svg {
  color: var(--muted);
  flex: none;
}
.menu-sub-name {
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.menu-sub-controls {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: none;
}
.menu-sub-seg {
  display: inline-flex;
  padding: 2px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--text) 6%, transparent);
}
.menu-sub-seg-btn {
  height: 22px;
  padding: 0 7px;
  border-radius: 5px;
  border: 0;
  background: transparent;
  color: var(--muted);
  font-size: 11px;
  font-weight: 550;
  cursor: pointer;
  transition: background-color var(--fast), color var(--fast), box-shadow var(--fast);
}
.menu-sub-seg-btn:hover {
  color: var(--text);
}
.menu-sub-seg-btn.is-active {
  background: var(--surface);
  color: var(--text);
  box-shadow: var(--shadow-sm);
}
.menu-sub-remove-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: background-color var(--fast), color var(--fast);
}
.menu-sub-remove-btn:hover {
  background: var(--danger-soft);
  color: var(--danger);
}
</style>

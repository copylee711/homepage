<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue';
import Icon from './Icon.vue';

export interface MenuItem { icon?: string; label: string; danger?: boolean; disabled?: boolean; action: () => void; }
const props = defineProps<{ anchor: HTMLElement; items: MenuItem[]; label?: string; up?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const root = ref<HTMLElement | null>(null);
const pos = ref({ left: 0, top: 0 });

function place() {
  const el = root.value; if (!el) return;
  const r = props.anchor.getBoundingClientRect();
  const w = el.offsetWidth || 200, h = el.offsetHeight || 240;
  let left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
  let top = props.up ? r.top - h - 6 : r.bottom + 6;
  if (!props.up && top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  if (props.up && top < 8) top = Math.min(r.bottom + 6, window.innerHeight - h - 8);
  pos.value = { left: Math.round(left), top: Math.round(top) };
}
function onDocPointer(e: PointerEvent) {
  if (!root.value) return;
  if (!root.value.contains(e.target as Node) && !props.anchor.contains(e.target as Node)) emit('close');
}
function onKey(e: KeyboardEvent) { if (e.key === 'Escape') { e.preventDefault(); emit('close'); } }

onMounted(async () => {
  await nextTick(); place();
  setTimeout(() => document.addEventListener('pointerdown', onDocPointer, true), 0);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', () => emit('close'), { passive: true });
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointer, true);
  document.removeEventListener('keydown', onKey, true);
});
</script>

<template>
  <teleport to="body">
    <div class="menu" ref="root" role="menu" :aria-label="label" :style="{ left: pos.left + 'px', top: pos.top + 'px' }">
      <button v-for="(it, i) in items" :key="i" type="button" class="menu-item" :class="{ 'is-danger': it.danger }"
        :disabled="it.disabled" role="menuitem" @click="() => { if (!it.disabled) { emit('close'); it.action(); } }">
        <Icon v-if="it.icon" :name="it.icon" :size="16" />
        <span class="menu-label">{{ it.label }}</span>
      </button>
    </div>
  </teleport>
</template>

<style>
.menu { position: fixed; z-index: 160; min-width: 196px; padding: 6px; border: 1px solid var(--line-2); border-radius: 14px; background: var(--surface); box-shadow: var(--shadow-lg); animation: menu-in 130ms var(--ease); }
@keyframes menu-in { from { opacity: 0; transform: translateY(-4px) scale(0.98); } to { opacity: 1; transform: none; } }
.menu-item { width: 100%; min-height: 34px; display: flex; align-items: center; gap: 10px; padding: 7px 9px; border-radius: 9px; color: var(--text-2); text-align: left; font-size: 13px; transition: background-color var(--fast), color var(--fast); }
.menu-item:hover:not(:disabled), .menu-item:focus-visible { background: color-mix(in srgb, var(--text) 6%, transparent); color: var(--text); outline: 0; }
.menu-item:disabled { opacity: 0.45; }
.menu-item svg { color: var(--muted); }
.menu-item.is-danger { color: var(--danger); }
.menu-item.is-danger svg { color: var(--danger); }
.menu-label { flex: 1; }
</style>

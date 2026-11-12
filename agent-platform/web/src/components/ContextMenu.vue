<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import Icon from './Icon.vue';
import { useUi } from '../stores/ui';

const ui = useUi();
const root = ref<HTMLElement | null>(null);
const pos = ref({ left: 0, top: 0 });

async function place() {
  await nextTick();
  const el = root.value; const ctx = ui.context; if (!el || !ctx) return;
  const w = el.offsetWidth || 200, h = el.offsetHeight || 240;
  let left = Math.min(ctx.x, window.innerWidth - w - 8);
  let top = Math.min(ctx.y, window.innerHeight - h - 8);
  pos.value = { left: Math.max(8, left), top: Math.max(8, top) };
}
function onDown(e: PointerEvent) { if (root.value && !root.value.contains(e.target as Node)) ui.closeContext(); }
function onKey(e: KeyboardEvent) { if (e.key === 'Escape') ui.closeContext(); }
function run(item: any) { if (item.disabled) return; ui.closeContext(); item.action?.(); }

watch(() => ui.context, (v) => { if (v) place(); });
onMounted(() => {
  if (ui.context) place();
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', () => ui.closeContext(), { passive: true });
  window.addEventListener('scroll', () => ui.closeContext(), { passive: true, capture: true });
});
onBeforeUnmount(() => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey, true); });
</script>

<template>
  <teleport to="body">
    <Transition name="iris-pop">
    <div v-if="ui.context" class="ctx-menu" ref="root" role="menu" :style="{ left: pos.left + 'px', top: pos.top + 'px' }">
      <template v-for="(it, i) in ui.context.items" :key="i">
        <div v-if="it.separator" class="ctx-sep"></div>
        <div v-else-if="it.header" class="ctx-header">{{ it.header }}</div>
        <button v-else type="button" class="ctx-item" :class="{ 'is-danger': it.danger }" :disabled="it.disabled" role="menuitem" @click="run(it)">
          <Icon v-if="it.icon" :name="it.icon" :size="15" />
          <span class="ctx-label">{{ it.label }}</span>
          <span v-if="it.hint" class="ctx-hint">{{ it.hint }}</span>
        </button>
      </template>
    </div>
    </Transition>
  </teleport>
</template>

<style>
.ctx-menu { position: fixed; z-index: 170; min-width: 180px; max-width: 260px; padding: 6px; border: 1px solid var(--line-2); border-radius: 13px; background: var(--surface); box-shadow: var(--shadow-lg); animation: ctx-in 120ms var(--ease); }
@keyframes ctx-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
.ctx-item { width: 100%; min-height: 32px; display: flex; align-items: center; gap: 10px; padding: 6px 9px; border-radius: 8px; color: var(--text-2); text-align: left; font-size: 13px; }
.ctx-item:hover:not(:disabled), .ctx-item:focus-visible { background: color-mix(in srgb, var(--text) 6%, transparent); color: var(--text); outline: 0; }
.ctx-item:disabled { opacity: 0.4; }
.ctx-item svg { color: var(--muted); }
.ctx-item.is-danger { color: var(--danger); }
.ctx-item.is-danger svg { color: var(--danger); }
.ctx-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ctx-hint { flex: none; color: var(--faint); font-size: 10.5px; }
.ctx-sep { height: 1px; margin: 5px 6px; background: var(--line); }
.ctx-header { padding: 6px 9px 3px; color: var(--faint); font-size: 10px; font-weight: 650; letter-spacing: 0.04em; text-transform: uppercase; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>

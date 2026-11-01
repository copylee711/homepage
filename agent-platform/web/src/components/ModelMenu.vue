<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, nextTick, computed } from 'vue';
import Icon from './Icon.vue';
import { get } from '../services/api';
import { useSession } from '../stores/session';
import { useUi } from '../stores/ui';

const props = defineProps<{ anchor: HTMLElement }>();
const emit = defineEmits<{ close: [] }>();
const session = useSession();
const ui = useUi();

const root = ref<HTMLElement | null>(null);
const pos = ref({ left: 0, top: 0, maxH: 420 });
const query = ref('');
const configs = ref<any>(null);
const loading = ref(true);

// Each saved provider contributes one group; its models[] (fallback to [model])
// are the switchable entries. Active = provider id + model.
const groups = computed(() => {
  if (!configs.value) return [];
  const q = query.value.trim().toLowerCase();
  const out: any[] = [];
  for (const p of configs.value.providers || []) {
    const models: string[] = (Array.isArray(p.models) && p.models.length ? p.models : [p.model]).filter(Boolean);
    const items = models
      .filter(m => !q || (p.name + ' ' + m).toLowerCase().includes(q))
      .map(m => ({ provider: p, model: m }));
    if (items.length) out.push({ key: p.id, label: p.name, items });
  }
  return out;
});
const activeModel = computed(() => configs.value?.activeModel || configs.value?.providers?.find((p: any) => p.id === configs.value.active)?.model);

function isActive(p: any, model: string) { return p.id === configs.value.active && model === activeModel.value; }

async function pick(p: any, model: string) {
  if (isActive(p, model)) { emit('close'); return; }
  if (!session.isAdmin) { ui.toast('模型由管理员配置，无法切换。', { tone: 'info' }); return; }
  try { await session.activateModel(p.id, model); ui.toast('已切换到 ' + model, { tone: 'success' }); emit('close'); }
  catch (e: any) { ui.toast(e.message, { tone: 'error' }); }
}
function manage() { emit('close'); ui.openDialog('provider'); }

function place() {
  const el = root.value; if (!el) return;
  const r = props.anchor.getBoundingClientRect();
  const margin = 10;
  const spaceAbove = r.top - margin * 2;
  const spaceBelow = window.innerHeight - r.bottom - margin * 2;
  const up = spaceAbove >= Math.min(spaceBelow, 420) || spaceAbove > spaceBelow;
  const maxH = Math.max(180, Math.min(420, up ? spaceAbove : spaceBelow));
  const w = el.offsetWidth || 320;
  const h = Math.min(el.offsetHeight || 360, maxH);
  let left = Math.max(margin, Math.min(r.right - w, window.innerWidth - w - margin));
  let top = up ? r.top - h - 8 : r.bottom + 8;
  top = Math.max(margin, Math.min(top, window.innerHeight - h - margin));
  pos.value = { left: Math.round(left), top: Math.round(top), maxH };
}
function onDoc(e: PointerEvent) { if (root.value && !root.value.contains(e.target as Node) && !props.anchor.contains(e.target as Node)) emit('close'); }
function onKey(e: KeyboardEvent) { if (e.key === 'Escape') { e.preventDefault(); emit('close'); } }

onMounted(async () => {
  try { configs.value = await get('/api/providers'); } catch {} finally { loading.value = false; }
  await nextTick(); place();
  setTimeout(() => document.addEventListener('pointerdown', onDoc, true), 0);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place, { passive: true });
});
onBeforeUnmount(() => { document.removeEventListener('pointerdown', onDoc, true); document.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', place); });
</script>

<template>
  <teleport to="body">
    <div class="model-menu" ref="root" role="dialog" aria-label="模型选择" :style="{ left: pos.left + 'px', top: pos.top + 'px', maxHeight: pos.maxH + 'px' }">
      <div class="model-menu-field">
        <span class="search-icon"><Icon name="search" :size="15" /></span>
        <input v-model="query" type="text" placeholder="搜索模型…" autocomplete="off" spellcheck="false" aria-label="搜索模型" autofocus>
      </div>
      <div class="model-menu-list" role="listbox">
        <p v-if="loading" class="model-menu-empty">正在读取…</p>
        <p v-else-if="!groups.length" class="model-menu-empty">没有匹配的模型。</p>
        <template v-for="g in groups" :key="g.key">
          <div class="model-menu-group">{{ g.label }}</div>
          <button v-for="it in g.items" :key="it.provider.id + ':' + it.model" type="button" class="model-menu-item" :class="{ 'is-active': isActive(it.provider, it.model) }" role="option" :aria-selected="isActive(it.provider, it.model)" @click="pick(it.provider, it.model)">
            <span class="mm-body"><span class="mm-name">{{ it.model }}</span></span>
            <span v-if="isActive(it.provider, it.model)" class="mm-check"><Icon name="check" :size="15" /></span>
          </button>
        </template>
      </div>
      <button type="button" class="model-menu-manage" :disabled="!session.isAdmin" @click="manage">
        <Icon name="settings" :size="15" /><span>{{ session.isAdmin ? '管理供应商…' : '模型由管理员配置' }}</span>
      </button>
    </div>
  </teleport>
</template>

<style>
.model-menu { position: fixed; z-index: 160; width: min(320px, calc(100vw - 24px)); display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--line-2); border-radius: 15px; background: var(--surface); box-shadow: var(--shadow-lg); animation: menu-in 140ms var(--ease); }
.model-menu-field { display: flex; align-items: center; gap: 8px; padding: 11px 13px; border-bottom: 1px solid var(--line); }
.model-menu-field .search-icon { color: var(--muted); display: flex; }
.model-menu-field input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--text); font-size: 13.5px; }
.model-menu-field input::placeholder { color: var(--muted); }
.model-menu-list { flex: 1; min-height: 0; overflow-y: auto; padding: 7px; }
.model-menu-group { padding: 9px 11px 5px; color: var(--faint); font-size: 10px; font-weight: 650; letter-spacing: 0.05em; text-transform: uppercase; }
.model-menu-item { width: 100%; display: flex; align-items: center; gap: 10px; padding: 8px 9px; border-radius: 9px; color: var(--text-2); text-align: left; transition: background-color var(--fast); }
.model-menu-item:hover { background: color-mix(in srgb, var(--text) 6%, transparent); color: var(--text); }
.model-menu-item.is-active { background: color-mix(in srgb, var(--text) 5%, transparent); color: var(--text); }
.model-menu-item .mm-body { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.model-menu-item .mm-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 550; }
.model-menu-item .mm-model { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; color: var(--muted); font-family: var(--font-mono); }
.model-menu-item .mm-check { flex: none; color: var(--ink); display: flex; }
.model-menu-empty { padding: 18px; text-align: center; color: var(--muted); font-size: 12.5px; }
.model-menu-manage { display: flex; align-items: center; gap: 8px; padding: 10px 13px; border-top: 1px solid var(--line); color: var(--text-2); font-size: 12.5px; }
.model-menu-manage:hover:not(:disabled) { background: color-mix(in srgb, var(--text) 5%, transparent); }
.model-menu-manage:disabled { color: var(--muted); cursor: default; }
.model-menu-manage svg { color: var(--muted); }
</style>

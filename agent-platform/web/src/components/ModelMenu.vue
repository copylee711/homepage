<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, nextTick, computed, watch } from 'vue';
import Icon from './Icon.vue';
import { get } from '../services/api';
import { useSession } from '../stores/session';
import { useUi, type ThinkingLevel } from '../stores/ui';

const props = defineProps<{ anchor: HTMLElement }>();
const emit = defineEmits<{ close: [] }>();
const session = useSession();
const ui = useUi();

const root = ref<HTMLElement | null>(null);

const thinkingOptions: { value: ThinkingLevel; label: string }[] = [
  { value: 'off', label: '关' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'max', label: '极高' },
];

function calcPos(el?: HTMLElement | null) {
  const r = props.anchor.getBoundingClientRect();
  const margin = 10;
  const w = el?.offsetWidth || Math.min(324, window.innerWidth - 24);
  const spaceAbove = r.top - margin - 8;
  const spaceBelow = window.innerHeight - r.bottom - margin - 8;
  const up = spaceAbove >= Math.min(spaceBelow, 400) || spaceAbove > spaceBelow;
  const maxH = Math.max(200, Math.min(440, Math.floor(up ? spaceAbove : spaceBelow)));
  const left = Math.round(Math.max(margin, Math.min(r.right - w, window.innerWidth - w - margin)));
  if (up) {
    return { left, top: 'auto', bottom: Math.round(window.innerHeight - r.top + 8) + 'px', maxH };
  }
  return { left, top: Math.round(r.bottom + 8) + 'px', bottom: 'auto', maxH };
}

const pos = ref(calcPos(null));
const query = ref('');
const configs = ref<any>(null);
const loading = ref(true);

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
function manage() { emit('close'); ui.openSettings('providers'); }

function place() { pos.value = calcPos(root.value); }
function onDoc(e: PointerEvent) { if (root.value && !root.value.contains(e.target as Node) && !props.anchor.contains(e.target as Node)) emit('close'); }
function onKey(e: KeyboardEvent) { if (e.key === 'Escape') { e.preventDefault(); emit('close'); } }

watch([loading, query], () => { void nextTick(place); });

onMounted(async () => {
  place();
  setTimeout(() => document.addEventListener('pointerdown', onDoc, true), 0);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place, { passive: true });
  try { configs.value = await get('/api/providers'); } catch {} finally { loading.value = false; }
  await nextTick();
  place();
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDoc, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', place);
});
</script>

<template>
  <teleport to="body">
    <div
      class="model-menu"
      ref="root"
      role="dialog"
      aria-label="模型与思考强度"
      :style="{ left: pos.left + 'px', top: pos.top, bottom: pos.bottom, maxHeight: pos.maxH + 'px' }"
    >
      <div class="model-menu-field">
        <span class="search-icon"><Icon name="search" :size="15" /></span>
        <input v-model="query" type="text" placeholder="搜索已启用模型…" autocomplete="off" spellcheck="false" aria-label="搜索模型" autofocus>
      </div>
      <div class="model-menu-list" role="listbox">
        <p v-if="loading" class="model-menu-empty"><span class="spinner"></span><span>正在读取…</span></p>
        <p v-else-if="!groups.length" class="model-menu-empty">没有匹配的模型。</p>
        <template v-for="g in groups" :key="g.key">
          <div class="model-menu-group">{{ g.label }}</div>
          <button v-for="it in g.items" :key="it.provider.id + ':' + it.model" type="button" class="model-menu-item" :class="{ 'is-active': isActive(it.provider, it.model) }" role="option" :aria-selected="isActive(it.provider, it.model)" @click="pick(it.provider, it.model)">
            <span class="mm-body"><span class="mm-name">{{ it.model }}</span></span>
            <span v-if="isActive(it.provider, it.model)" class="mm-check"><Icon name="check" :size="15" /></span>
          </button>
        </template>
      </div>

      <div class="model-menu-thinking">
        <div class="mm-thinking-head">
          <Icon name="sparkle" :size="13" />
          <span>思考强度</span>
        </div>
        <div class="thinking-seg" role="radiogroup" aria-label="思考强度">
          <button
            v-for="opt in thinkingOptions"
            :key="opt.value"
            type="button"
            role="radio"
            :aria-checked="ui.thinkingLevel === opt.value"
            :class="{ 'is-on': ui.thinkingLevel === opt.value }"
            @click="ui.setThinkingLevel(opt.value)"
          >{{ opt.label }}</button>
        </div>
      </div>

      <button type="button" class="model-menu-manage" :disabled="!session.isAdmin" @click="manage">
        <Icon name="settings" :size="15" /><span>{{ session.isAdmin ? '模型与供应商设置…' : '模型由管理员配置' }}</span>
      </button>
    </div>
  </teleport>
</template>

<style>
.model-menu { position: fixed; z-index: 160; width: min(324px, calc(100vw - 24px)); display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--line-2); border-radius: 15px; background: var(--surface); box-shadow: var(--shadow-lg); transform-origin: bottom right; animation: menu-in 140ms var(--ease); }
.model-menu-field { display: flex; align-items: center; gap: 8px; padding: 10px 13px; border-bottom: 1px solid var(--line); }
.model-menu-field .search-icon { color: var(--muted); display: flex; }
.model-menu-field input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--text); font-size: 13.5px; }
.model-menu-field input::placeholder { color: var(--muted); }
.model-menu-list { flex: 1; min-height: 0; overflow-y: auto; padding: 6px; }
.model-menu-group { padding: 8px 10px 4px; color: var(--faint); font-size: 10.5px; font-weight: 650; letter-spacing: 0.04em; text-transform: uppercase; }
.model-menu-item { width: 100%; display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 9px; color: var(--text-2); text-align: left; transition: background-color var(--fast); }
.model-menu-item:hover { background: color-mix(in srgb, var(--text) 6%, transparent); color: var(--text); }
.model-menu-item.is-active { background: color-mix(in srgb, var(--text) 5%, transparent); color: var(--text); }
.model-menu-item .mm-body { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.model-menu-item .mm-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 540; font-family: var(--font-mono); }
.model-menu-item .mm-check { flex: none; color: var(--ink); display: flex; }
.model-menu-empty { margin: 0; padding: 18px 14px; display: flex; align-items: center; justify-content: center; gap: 8px; text-align: center; color: var(--muted); font-size: 12.5px; }

.model-menu-thinking { flex: none; display: flex; flex-direction: column; gap: 7px; padding: 9px 12px 10px; border-top: 1px solid var(--line); }
.mm-thinking-head { display: flex; align-items: center; gap: 5px; padding: 0 1px; color: var(--muted); font-size: 11px; font-weight: 580; }
.mm-thinking-head svg { color: var(--muted); }
.thinking-seg { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 2px; padding: 2.5px; border-radius: 9px; background: color-mix(in srgb, var(--text) 4.8%, transparent); }
.thinking-seg button { height: 26px; border-radius: 6.5px; color: var(--muted); font-size: 11.5px; font-weight: 550; transition: background-color var(--fast), color var(--fast), box-shadow var(--fast); }
.thinking-seg button:hover { color: var(--text); }
.thinking-seg button.is-on { background: var(--surface); color: var(--text); font-weight: 620; box-shadow: var(--shadow-sm); }

.model-menu-manage { flex: none; display: flex; align-items: center; gap: 8px; padding: 10px 13px; border-top: 1px solid var(--line); color: var(--text-2); font-size: 12.5px; }
.model-menu-manage:hover:not(:disabled) { background: color-mix(in srgb, var(--text) 5%, transparent); color: var(--text); }
.model-menu-manage:disabled { color: var(--muted); cursor: default; }
.model-menu-manage svg { color: var(--muted); }
</style>

<script setup lang="ts">
import { ref, computed, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';

export interface SelectOption {
  value: string | number;
  label: string;
}

const props = defineProps<{
  modelValue: string | number;
  options: SelectOption[];
  size?: 'md' | 'sm';
  ariaLabel?: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string | number): void;
}>();

const trigger = ref<HTMLButtonElement | null>(null);
const menuEl = ref<HTMLElement | null>(null);
const open = ref(false);
const activeIdx = ref(0);
const posStyle = ref<Record<string, string>>({});

const selectedLabel = computed(() => {
  const hit = props.options.find(o => o.value === props.modelValue);
  return hit ? hit.label : String(props.modelValue ?? '');
});

function updatePos() {
  if (!trigger.value) return;
  const r = trigger.value.getBoundingClientRect();
  const estH = Math.min(280, props.options.length * 36 + 12);
  const spaceBelow = window.innerHeight - r.bottom - 12;
  const minW = Math.max(Math.round(r.width), 120);
  const left = Math.max(8, Math.min(Math.round(r.left), window.innerWidth - minW - 8));
  if (spaceBelow >= estH || spaceBelow >= r.top) {
    posStyle.value = { left: left + 'px', top: Math.round(r.bottom + 5) + 'px', minWidth: minW + 'px' };
  } else {
    posStyle.value = { left: left + 'px', bottom: Math.round(window.innerHeight - r.top + 5) + 'px', minWidth: minW + 'px' };
  }
}

function toggle() {
  if (props.disabled) return;
  if (open.value) {
    close();
    return;
  }
  const idx = props.options.findIndex(o => o.value === props.modelValue);
  activeIdx.value = idx >= 0 ? idx : 0;
  updatePos();
  open.value = true;
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onDocKey, true);
  window.addEventListener('resize', close);
  window.addEventListener('scroll', updatePos, true);
}

function close() {
  if (!open.value) return;
  open.value = false;
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onDocKey, true);
  window.addEventListener('resize', close);
  window.removeEventListener('scroll', updatePos, true);
}

function onDocKey(e: KeyboardEvent) {
  if (!open.value) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopImmediatePropagation();
    close();
    trigger.value?.focus();
  }
}

function onOutside(e: PointerEvent) {
  const t = e.target as Node;
  if (trigger.value?.contains(t) || menuEl.value?.contains(t)) return;
  close();
}

function pick(opt: SelectOption) {
  emit('update:modelValue', opt.value);
  close();
  trigger.value?.focus();
}

function onKey(e: KeyboardEvent) {
  if (props.disabled) return;
  if (!open.value) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      toggle();
    }
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    close();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeIdx.value = (activeIdx.value + 1) % props.options.length;
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeIdx.value = (activeIdx.value - 1 + props.options.length) % props.options.length;
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    const opt = props.options[activeIdx.value];
    if (opt) pick(opt);
  }
}

onBeforeUnmount(close);
</script>

<template>
  <button
    ref="trigger"
    type="button"
    class="iris-select"
    :class="[size === 'sm' ? 'is-sm' : 'is-md', { 'is-open': open }]"
    role="combobox"
    :aria-expanded="open"
    :aria-label="ariaLabel"
    :disabled="disabled"
    @click="toggle"
    @keydown="onKey"
  >
    <span class="iris-select-label">{{ selectedLabel }}</span>
    <span class="iris-select-chevron"><Icon name="chevron-down" :size="14" /></span>
  </button>

  <teleport to="body">
    <div
      v-if="open"
      ref="menuEl"
      class="iris-select-pop"
      role="listbox"
      :aria-label="ariaLabel"
      :style="posStyle"
    >
      <button
        v-for="(opt, i) in options"
        :key="String(opt.value)"
        type="button"
        role="option"
        class="iris-select-opt"
        :class="{ 'is-selected': opt.value === modelValue, 'is-active': i === activeIdx }"
        :aria-selected="opt.value === modelValue"
        @mouseenter="activeIdx = i"
        @click="pick(opt)"
      >
        <span class="iris-select-opt-text">{{ opt.label }}</span>
        <span class="iris-select-check">
          <Icon v-if="opt.value === modelValue" name="check" :size="14" />
        </span>
      </button>
    </div>
  </teleport>
</template>

<style>
.iris-select {
  width: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--surface-2);
  color: var(--text);
  text-align: left;
  transition: border-color var(--fast), box-shadow var(--fast), background-color var(--fast);
}
.iris-select.is-md {
  min-height: 39px;
  padding: 8px 11px 8px 12px;
  font-size: 13px;
}
.iris-select.is-sm {
  width: auto;
  height: 32px;
  padding: 0 9px 0 10px;
  border-radius: 8px;
  font-size: 12px;
}
.iris-select:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--text) 28%, var(--line-strong));
  background: var(--surface);
}
.iris-select.is-open,
.iris-select:focus-visible {
  outline: 0;
  border-color: var(--accent);
  box-shadow: var(--ring);
  background: var(--surface);
}
.iris-select:disabled {
  opacity: 0.45;
}
.iris-select-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.iris-select-chevron {
  flex: none;
  display: inline-flex;
  color: var(--muted);
  transition: transform var(--fast);
}
.iris-select.is-open .iris-select-chevron {
  transform: rotate(180deg);
  color: var(--text);
}

.iris-select-pop {
  position: fixed;
  z-index: 205;
  max-height: 280px;
  overflow-y: auto;
  padding: 5px;
  border: 1px solid var(--line-2);
  border-radius: 12px;
  background: var(--surface);
  color: var(--text);
  box-shadow: var(--shadow-lg);
  animation: fade-in 120ms var(--ease);
}
.iris-select-opt {
  width: 100%;
  min-height: 34px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 10px;
  border-radius: 8px;
  color: var(--text-2);
  font-size: 13px;
  text-align: left;
  transition: background-color var(--fast), color var(--fast);
}
.iris-select-opt.is-active,
.iris-select-opt:hover {
  background: color-mix(in srgb, var(--text) 6%, transparent);
  color: var(--text);
}
.iris-select-opt.is-selected {
  color: var(--text);
  font-weight: 580;
}
.iris-select-opt-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.iris-select-check {
  width: 16px;
  height: 16px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--ink);
}
</style>

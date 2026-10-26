<script setup lang="ts">
import { computed, ref } from 'vue'
import { SelectContent, SelectItem, SelectItemIndicator, SelectItemText, SelectPortal, SelectRoot, SelectTrigger, SelectValue, SelectViewport } from 'reka-ui'

/**
 * 站内样式的下拉选择，替代原生 select。与 AnimatedSelect 相比没有外置标签，用 label 提供无障碍名称；
 * compact 用于代码块语言这类嵌在内容里的小控件。
 */
const props = withDefaults(defineProps<{
  modelValue: string
  options: { value: string; label: string }[]
  label: string
  compact?: boolean
  disabled?: boolean
}>(), { compact: false, disabled: false })
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const open = ref(false)
// Reka 的空字符串值用于占位，这里用内部哨兵表示空值（如“纯文本”）。
const EMPTY = '__empty__'
const value = computed({
  get: () => props.modelValue || EMPTY,
  set: (next: string) => emit('update:modelValue', next === EMPTY ? '' : next),
})
</script>

<template>
  <SelectRoot v-model="value" v-model:open="open" :disabled="disabled">
    <SelectTrigger class="menu-select" :class="{ compact }" :aria-label="label" @mousedown.stop>
      <SelectValue /><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 8 5 5 5-5" /></svg>
    </SelectTrigger>
    <SelectPortal>
      <SelectContent class="menu-select-content" :class="{ compact }" position="popper" :body-lock="false" :side-offset="6" :collision-padding="16">
        <SelectViewport class="menu-select-viewport">
          <SelectItem v-for="option in options" :key="option.value" class="menu-select-option" :value="option.value || EMPTY">
            <SelectItemText>{{ option.label }}</SelectItemText>
            <SelectItemIndicator class="menu-select-check" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="m3.5 8.5 3 3 6-6.5" /></svg></SelectItemIndicator>
          </SelectItem>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>

<style>
.menu-select { display:inline-flex; align-items:center; justify-content:space-between; gap:10px; min-width:0; padding:9px 12px; border:1px solid var(--line); border-radius:10px; background:var(--surface); color:var(--text); font:14px var(--font); text-align:left; white-space:nowrap; cursor:pointer; transition:border-color .2s,box-shadow .25s,background .2s; }
.menu-select:hover:not([data-disabled]) { border-color:var(--line-strong); }
.menu-select[data-state=open], .menu-select:focus-visible { outline:none; border-color:var(--field-focus-border); box-shadow:var(--field-focus-shadow); }
.menu-select[data-disabled] { opacity:.5; cursor:default; }
.menu-select > span { overflow:hidden; text-overflow:ellipsis; }
.menu-select svg { flex:none; width:16px; height:16px; fill:none; stroke:var(--muted); stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round; transition:transform .3s var(--ease); }
.menu-select[data-state=open] svg { transform:rotate(180deg); }
.menu-select.compact { gap:4px; padding:3px 6px 3px 8px; border-color:transparent; border-radius:6px; background:transparent; color:var(--muted); font:12px var(--font-mono); }
.menu-select.compact:hover, .menu-select.compact[data-state=open] { border-color:transparent; box-shadow:none; background:color-mix(in srgb,var(--text) 6%,transparent); color:var(--text); }
.menu-select.compact svg { width:13px; height:13px; }
.menu-select-content { z-index:90; min-width:var(--reka-select-trigger-width); max-height:min(320px,var(--reka-select-content-available-height)); overflow:hidden; border:1px solid var(--line); border-radius:12px; background:var(--surface); color:var(--text); box-shadow:0 16px 40px -12px rgba(17,24,39,.3); transform-origin:var(--reka-select-content-transform-origin); }
.menu-select-content.compact { min-width:180px; }
.menu-select-content[data-state=open] { animation:menu-select-in .22s var(--ease); }
.menu-select-content[data-state=closed] { animation:menu-select-out .15s ease; }
.menu-select-viewport { padding:5px; }
.menu-select-option { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:8px 10px; border-radius:8px; color:var(--text-2); font:13.5px var(--font); cursor:pointer; outline:none; transition:background .15s,color .15s; }
.menu-select-content.compact .menu-select-option { padding:7px 10px; font:13px var(--font-mono); }
.menu-select-option[data-highlighted] { background:var(--accent-soft); color:var(--accent); }
.menu-select-option[data-state=checked] { color:var(--accent); }
.menu-select-check svg { display:block; width:15px; height:15px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
@keyframes menu-select-in { from { opacity:0; transform:translateY(-4px) scale(.97); } }
@keyframes menu-select-out { to { opacity:0; transform:translateY(-3px) scale(.98); } }
</style>

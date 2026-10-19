<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import { SelectRoot, SelectTrigger, SelectValue, SelectPortal, SelectContent, SelectViewport, SelectItem, SelectItemText, SelectItemIndicator } from 'reka-ui'
const props = defineProps<{ modelValue: string; label: string; options: { value: string; label: string }[] }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const id = useId()
const open = ref(false)
const collisionTop = ref(80)
// 页面滚动时收起浮层；选项列表自身滚动不会冒泡到此监听器。
const closeOnPageScroll = () => { open.value = false }
onMounted(() => {
  collisionTop.value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-h')) + 16
  window.addEventListener('scroll', closeOnPageScroll, { passive: true })
})
onBeforeUnmount(() => window.removeEventListener('scroll', closeOnPageScroll))
// Reka 的空值用于 placeholder；所有来源/栏目使用内部哨兵，外部仍保持空字符串。
const all = '__all__'
const value = computed({ get: () => props.modelValue || all, set: (next: string) => emit('update:modelValue', next === all ? '' : next) })
</script>

<template>
  <div class="select-field">
    <label :id="`${id}-label`" :for="id">{{ label }}</label>
    <SelectRoot v-model="value" v-model:open="open">
      <SelectTrigger :id="id" class="select-trigger" :aria-labelledby="`${id}-label`">
        <SelectValue /><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 8 5 5 5-5" /></svg>
      </SelectTrigger>
      <SelectPortal>
        <SelectContent class="select-menu" position="popper" :body-lock="false" :side-offset="8" :collision-padding="{ top: collisionTop, bottom: 16, left: 16, right: 16 }" :aria-labelledby="`${id}-label`">
          <SelectViewport class="select-viewport">
            <SelectItem v-for="option in options" :key="option.value" class="select-option" :value="option.value || all">
              <SelectItemText>{{ option.label }}</SelectItemText><SelectItemIndicator aria-hidden="true">✓</SelectItemIndicator>
            </SelectItem>
          </SelectViewport>
        </SelectContent>
      </SelectPortal>
    </SelectRoot>
  </div>
</template>

<style scoped>
.select-field { min-width:0; }
label { display:block; font-size:12px; color:var(--muted); margin-bottom:8px; }
.select-trigger { display:flex; align-items:center; justify-content:space-between; gap:12px; width:100%; min-height:48px; padding:13px 16px; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--surface); color:var(--text); font:14px var(--font); text-align:left; cursor:pointer; transition:border-color .3s,box-shadow .3s,background .3s; }
.select-trigger :deep([data-slot="value"]),.select-trigger>span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.select-trigger:hover { border-color:var(--line-strong); }
.select-trigger[data-state="open"] { border-color:var(--accent); box-shadow:0 0 0 4px var(--accent-soft); }
svg { width:18px; height:18px; flex:none; fill:none; stroke:var(--muted); stroke-width:1.5; transition:transform .35s var(--ease),stroke .3s; }
[data-state="open"] svg { transform:rotate(180deg); stroke:var(--accent); }
:global(.select-menu) { z-index:9; width:var(--reka-select-trigger-width); max-height:min(320px,var(--reka-select-content-available-height)); overflow:hidden; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--surface); color:var(--text); box-shadow:0 16px 40px -12px #0003; transform-origin:var(--reka-select-content-transform-origin); }
:global(.select-viewport) { padding:6px; }
.select-option { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:11px 12px; min-height:40px; border-radius:8px; font-size:13px; color:var(--text-2); cursor:pointer; outline:none; transition:background .18s,color .18s; overflow-wrap:anywhere; }
.select-option[data-highlighted] { background:var(--accent-soft); color:var(--accent); }
.select-option[data-state="checked"] { color:var(--accent); }
:global(.select-menu[data-state="open"]) { animation:menu-in .3s var(--ease); }
:global(.select-menu[data-state="closed"]) { animation:menu-out .18s ease; }
@keyframes menu-in { from { opacity:0; transform:translateY(-6px) scale(.97); } }
@keyframes menu-out { to { opacity:0; transform:translateY(-4px) scale(.98); } }
</style>

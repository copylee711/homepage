<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

defineProps<{ title: string; eyebrow?: string; wide?: boolean }>()
const emit = defineEmits<{ close: [] }>()
const panel = ref<HTMLElement>()
let previous: Element | null = null

function onKey(event: KeyboardEvent) { if (event.key === 'Escape') emit('close') }
onMounted(() => {
  previous = document.activeElement
  document.addEventListener('keydown', onKey)
  // 打开后聚焦第一个输入框，没有输入框时聚焦面板本身，方便键盘操作。
  nextTick(() => (panel.value?.querySelector<HTMLElement>('input:not([type=checkbox]),textarea,select') ?? panel.value)?.focus())
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey)
  if (previous instanceof HTMLElement) previous.focus()
})
</script>

<template>
  <Teleport to="body">
    <div class="backdrop" @click.self="emit('close')">
      <section ref="panel" class="dialog" :class="{ wide }" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1">
        <header><div><p v-if="eyebrow" class="eyebrow">{{ eyebrow }}</p><h2>{{ title }}</h2></div><button class="close" type="button" aria-label="关闭" @click="emit('close')">×</button></header>
        <slot />
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.backdrop { position:fixed; inset:0; z-index:60; display:grid; place-items:center; padding:20px; background:rgba(12,13,16,.45); -webkit-backdrop-filter:blur(6px); backdrop-filter:blur(6px); animation:fade .2s ease; }
.dialog { width:min(440px,100%); max-height:calc(100vh - 40px); overflow:auto; padding:26px 28px 28px; border:1px solid var(--line); border-radius:var(--radius); background:var(--bg); box-shadow:0 30px 60px -20px rgba(0,0,0,.35); animation:rise .3s var(--ease); outline:none; }
.dialog.wide { width:min(920px,100%); }
header { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:6px; }
.eyebrow { margin:0; font-size:11px; color:var(--faint); letter-spacing:.14em; text-transform:uppercase; }
h2 { margin:4px 0 0; font-size:22px; letter-spacing:-.01em; overflow-wrap:anywhere; }
.close { flex:none; width:32px; height:32px; border:0; border-radius:8px; background:none; color:var(--muted); font-size:22px; line-height:1; cursor:pointer; }
.close:hover { background:var(--bg-tint); color:var(--text); }
@keyframes fade { from { opacity:0; } }
@keyframes rise { from { opacity:0; transform:translateY(12px) scale(.98); } }
@media (prefers-reduced-motion: reduce) { .backdrop,.dialog { animation:none; } }
</style>

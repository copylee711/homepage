<script setup lang="ts">
import BrandMark from './BrandMark.vue';

defineProps<{ error?: string }>();
defineEmits<{ retry: [] }>();
</script>

<template>
  <main class="iris-boot">
    <div class="iris-boot-grid" aria-hidden="true" />
    <div v-if="!error" class="iris-boot-beam" aria-hidden="true" />
    <div class="iris-boot-center">
      <BrandMark :size="72" />
      <p class="iris-boot-brand">IRIS</p>
      <template v-if="error">
        <h1>暂时无法载入 Iris</h1>
        <p class="iris-boot-error" role="alert">{{ error }}</p>
        <button class="btn btn-solid" type="button" @click="$emit('retry')">重新加载</button>
      </template>
      <template v-else>
        <h1 role="status">正在载入工作区</h1>
        <div class="iris-boot-bar" role="progressbar" aria-label="载入进度"><span /></div>
      </template>
    </div>
  </main>
</template>

<style scoped>
.iris-boot {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  overflow: hidden;
  background: radial-gradient(120% 90% at 70% 10%, var(--bg-tint), var(--bg) 60%), var(--bg);
}
.iris-boot-grid {
  position: absolute;
  inset: 0;
  background-image: linear-gradient(var(--line-2) 1px, transparent 1px),
    linear-gradient(90deg, var(--line-2) 1px, transparent 1px);
  background-size: 48px 48px;
  mask-image: radial-gradient(circle at center, #000, transparent 62%);
}
.iris-boot-beam {
  position: absolute;
  inset: -50%;
  background: linear-gradient(105deg, transparent 43%, var(--accent-softer) 50%, transparent 57%);
  animation: boot-sweep 3.2s cubic-bezier(.65, 0, .2, 1) infinite;
}
.iris-boot-center {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 24px;
  text-align: center;
}
.iris-boot-brand { margin: 18px 0 8px; color: var(--muted); font-size: 12px; letter-spacing: .3em; }
.iris-boot h1 { margin: 0; font-size: clamp(20px, 4vw, 25px); font-weight: 600; }
.iris-boot-bar { width: min(200px, 56vw); height: 2px; margin-top: 22px; overflow: hidden; border-radius: 2px; background: var(--line-strong); }
.iris-boot-bar span { display: block; width: 40%; height: 100%; background: linear-gradient(90deg, transparent, var(--accent)); animation: boot-sweep-bar 1.35s var(--ease) infinite; }
.iris-boot-error { max-width: 34ch; margin: 12px 0 20px; color: var(--muted); }
@keyframes boot-sweep { from { transform: translateX(-40%); } to { transform: translateX(40%); } }
@keyframes boot-sweep-bar { from { transform: translateX(-100%); } to { transform: translateX(260%); } }
@media (prefers-reduced-motion: reduce) {
  .iris-boot-beam { display: none; }
  .iris-boot-bar span { animation: none; margin-inline: auto; }
}
</style>

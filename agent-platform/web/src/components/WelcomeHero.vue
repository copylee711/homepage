<script setup lang="ts">
import { ref, onMounted } from 'vue';
import BrandMark from './BrandMark.vue';
import { loadGreeting } from '../services/greeting';
const greeting = ref('我是 Iris');
onMounted(async () => { greeting.value = await loadGreeting(); });
</script>

<template>
  <section class="welcome">
    <span class="welcome-mark"><BrandMark :size="48" /></span>
    <h2>{{ greeting }}</h2>
  </section>
</template>

<style>
.welcome { width: 100%; max-width: 740px; margin: 0 auto; padding: 0 0 28px; display: flex; flex-direction: column; align-items: center; text-align: center; animation: welcome-in 440ms var(--ease) both; }
@keyframes welcome-in { from { opacity: 0; } to { opacity: 1; } }
.welcome-mark { width: 56px; height: 56px; display: grid; place-items: center; margin-bottom: 18px; color: var(--ink); animation: mark-float 5s ease-in-out infinite; }
.welcome-mark svg { width: 48px; height: 48px; }
@keyframes mark-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-5px); } }
.welcome h2 { margin: 0 0 12px; font-family: var(--font-display); font-size: clamp(27px, 3.1vw, 36px); font-weight: 650; line-height: 1.25; letter-spacing: -0.01em; }
</style>

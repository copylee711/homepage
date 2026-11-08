<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import BrandMark from './BrandMark.vue';
import { useSession } from '../stores/session';
import { loadGreeting } from '../services/greeting';
const session = useSession();
const permission = computed(() => !session.canExecute);
const greeting = ref('我是 Iris');
onMounted(async () => { if (session.canExecute) greeting.value = await loadGreeting(); });
</script>

<template>
  <section class="welcome" :class="{ 'welcome-permission': permission }">
    <span class="welcome-mark"><BrandMark :size="48" /></span>
    <h2 v-if="!permission">{{ greeting }}</h2>
    <template v-else>
      <h2>尚未开通执行权限</h2>
      <p>请联系管理员为当前账户开通 Iris 执行权限。</p>
    </template>
  </section>
</template>

<style>
.welcome { width: 100%; max-width: 740px; margin: 0 auto; padding: 0 0 28px; display: flex; flex-direction: column; align-items: center; text-align: center; animation: welcome-in 440ms var(--ease) both; }
@keyframes welcome-in { from { opacity: 0; } to { opacity: 1; } }
.welcome-mark { width: 56px; height: 56px; display: grid; place-items: center; margin-bottom: 18px; color: var(--ink); animation: mark-float 5s ease-in-out infinite; }
.welcome-mark svg { width: 48px; height: 48px; }
@keyframes mark-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-5px); } }
.welcome h2 { margin: 0 0 12px; font-family: var(--font-display); font-size: clamp(27px, 3.1vw, 36px); font-weight: 650; line-height: 1.25; letter-spacing: -0.01em; }
.welcome p { max-width: 520px; margin: 0; color: var(--muted); font-size: 14.5px; line-height: 1.7; }
.welcome-permission h2 { font-family: var(--font); font-size: clamp(22px, 4vw, 28px); }
.welcome-permission .welcome-mark { animation: none; }
</style>

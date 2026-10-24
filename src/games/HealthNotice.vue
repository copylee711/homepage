<script setup lang="ts">
defineProps<{ dark?: boolean }>()
</script>

<template>
  <aside class="health" :class="{ dark }" aria-label="健康游戏忠告">
    <strong>健康游戏忠告</strong>
    <p>抵制不良游戏，拒绝盗版游戏。注意自我保护，谨防受骗上当。<br>适度游戏益脑，沉迷游戏伤身。合理安排时间，享受健康生活。</p>
  </aside>
</template>

<style scoped>
.health { margin:28px auto 0; max-width:640px; padding:14px 18px; border:1px solid var(--line); border-radius:12px; color:var(--muted); font-size:12px; line-height:1.9; text-align:center; }
.health strong { display:block; color:var(--text-2); font-size:13px; letter-spacing:.2em; }
.health p { margin:4px 0 0; }
.health.dark { max-width:none; margin:6px 0 0; padding:0; border:0; color:rgba(232,236,245,.55); font-size:11px; line-height:1.7; }
.health.dark strong { display:inline; margin-right:8px; color:rgba(232,236,245,.75); font-size:11px; letter-spacing:.1em; }
.health.dark p { display:inline; margin:0; }
.health.dark br { display:none; }
</style>

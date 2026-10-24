<script setup lang="ts">
import { account } from '../account'

defineProps<{ title: string; result?: { improved: boolean; synced: boolean; error?: string }; again?: string; back?: string }>()
defineEmits<{ again: []; back: [] }>()
const login = `/account?next=${encodeURIComponent(location.pathname)}`
</script>

<template>
  <div class="overlay" role="dialog" aria-modal="false" :aria-label="title">
    <div class="card">
      <p class="title">{{ title }}</p>
      <slot />
      <p v-if="result?.improved" class="record">新纪录！</p>
      <p v-if="!result" class="status">正在保存成绩…</p>
      <p v-else-if="result.error" class="status error">{{ result.error }}</p>
      <p v-else-if="result.synced" class="status">成绩已同步到账户</p>
      <p v-else-if="!account" class="status"><a :href="login">登录</a>后成绩会同步并参与排行榜</p>
      <button type="button" class="again" @click="$emit('again')">{{ again ?? '再来一局' }}</button>
      <button v-if="back" type="button" class="back" @click="$emit('back')">{{ back }}</button>
    </div>
  </div>
</template>

<style scoped>
.overlay { position:absolute; inset:0; z-index:200; display:grid; place-items:center; padding:20px; background:rgba(12,13,16,.42); -webkit-backdrop-filter:blur(4px); backdrop-filter:blur(4px); animation:fade .35s var(--ease) both; }
.card { width:min(100%,300px); padding:26px 22px; border-radius:18px; background:var(--surface); color:var(--text); text-align:center; box-shadow:0 30px 60px -30px rgba(0,0,0,.5); animation:rise .45s var(--ease) both; }
.title { color:var(--muted); font-size:13px; letter-spacing:.16em; }
.card :slotted(p) { margin-top:8px; }
.record { margin-top:10px; color:#ff7a1a; font-weight:700; }
.status { margin-top:12px; color:var(--muted); font-size:13px; }
.status a { color:var(--accent); }
.status.error { color:#d15c5c; }
.back { width:100%; margin-top:10px; padding:11px; border:1px solid var(--line-strong); border-radius:10px; background:none; color:var(--text); font:500 14px var(--font); cursor:pointer; }
.again { width:100%; margin-top:20px; padding:12px; border:0; border-radius:10px; background:var(--btn-bg); color:var(--btn-fg); font:500 15px var(--font); cursor:pointer; }
@keyframes fade { from { opacity:0; } }
@keyframes rise { from { opacity:0; transform:translateY(16px) scale(.96); } }
</style>

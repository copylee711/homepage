<script setup lang="ts">
import { onMounted } from 'vue'
import { account, loadAccount } from '../../account'
import { useTheme } from '../../composables/useTheme'
import AppIcon from '../AppIcon.vue'
import LogoMark from '../LogoMark.vue'

const { theme, toggle } = useTheme()
// 网盘子域名上回到主站；在主站 /drive 下则回到首页。
const home = location.hostname.startsWith('cloud.') ? location.origin.replace('//cloud.', '//') : '/'
onMounted(() => { void loadAccount() })
const loginUrl = `/account?next=${encodeURIComponent(location.pathname + location.search)}`
</script>

<template>
  <header class="top">
    <a class="brand" href="/"><LogoMark class="logo" /><span>Copy Lee</span><em>Cloud</em></a>
    <div class="top-actions">
      <a class="back" :href="home">返回主页</a>
      <a class="avatar" :href="account ? '/account' : loginUrl" :title="account ? account.name : '登录'" :aria-label="account ? `账户：${account.name}` : '登录'">
        <img v-if="account?.avatar" :src="account.avatar" alt="">
        <span v-else-if="account">{{ account.name.slice(0, 1).toUpperCase() }}</span>
        <svg v-else viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.5" r="3.5" /><path d="M5 19.5a7 7 0 0 1 14 0" /></svg>
      </a>
      <button class="theme" type="button" :aria-label="theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'" @click="toggle"><AppIcon :name="theme === 'dark' ? 'moon' : 'sun'" /></button>
    </div>
  </header>
</template>

<style scoped>
.top { position:sticky; top:0; z-index:20; display:flex; align-items:center; justify-content:space-between; height:var(--header-h); padding:0 clamp(16px,3vw,32px); border-bottom:1px solid var(--line); background:var(--header-bg); -webkit-backdrop-filter:blur(16px); backdrop-filter:blur(16px); }
.brand { display:flex; align-items:center; gap:10px; font-weight:700; font-size:17px; letter-spacing:-.01em; }
.logo { width:28px; height:auto; }
.brand em { padding-left:12px; border-left:1px solid var(--line-strong); color:var(--accent); font-style:normal; font-weight:600; }
.top-actions { display:flex; align-items:center; gap:12px; }
.back { color:var(--muted); font-size:13px; transition:color .2s; }
.back:hover { color:var(--text); }
.avatar,.theme { display:grid; place-items:center; width:36px; height:36px; border-radius:50%; overflow:hidden; }
.avatar { border:1px solid var(--line); background:var(--surface); color:var(--text-2); font-weight:700; font-size:14px; }
.avatar img { width:100%; height:100%; object-fit:cover; }
.avatar svg { width:18px; height:18px; fill:none; stroke:currentColor; stroke-width:1.6; }
.theme { border:0; background:none; color:var(--text-2); cursor:pointer; }
.theme :deep(svg) { width:18px; height:18px; }
@media (max-width:600px) { .back { display:none; } }
</style>

<script setup lang="ts">
import { defineAsyncComponent, onBeforeUnmount, onMounted } from 'vue'
import { contentStatus, ready, reloadContent, startContent } from './content'
import AccountPage from './components/AccountPage.vue'
import AdminPage from './components/AdminPage.vue'
import BootScreen from './components/BootScreen.vue'
import HeroSection from './components/HeroSection.vue'
import PortalGrid from './components/PortalGrid.vue'
import RepoSection from './components/RepoSection.vue'
import SiteFooter from './components/SiteFooter.vue'
import SiteHeader from './components/SiteHeader.vue'
import NoteSection from './components/NoteSection.vue'
import PostSection from './components/PostSection.vue'
import ScutSection from './components/ScutSection.vue'
import { startScut } from './scut'
// 小游戏代码较大，只在 /games 页面按需加载
const GamesPage = defineAsyncComponent(() => import('./games/GamesPage.vue'))
const isAdmin = location.pathname === '/admin' || location.pathname.startsWith('/admin/')
const isScut = location.pathname.replace(/\/$/, '') === '/scut'
const isAccount = location.pathname.replace(/\/$/, '') === '/account'
const isGames = /^\/games(\/|$)/.test(location.pathname)
let stop: (() => void) | undefined
let stopScut: (() => void) | undefined
onMounted(() => { if (!isAdmin) { stop = startContent(); stopScut = startScut() } })
onBeforeUnmount(() => { stop?.(); stopScut?.() })
</script>

<template>
  <AdminPage v-if="isAdmin" />
  <template v-else-if="ready">
  <SiteHeader />
  <p v-if="contentStatus.stale" class="content-banner" role="status">暂时无法检查更新，正在显示已加载的内容。<button @click="reloadContent">重试</button></p>
  <main :id="isScut || isAccount || isGames ? 'top' : undefined">
    <ScutSection v-if="isScut" full />
    <AccountPage v-else-if="isAccount" />
    <GamesPage v-else-if="isGames" />
    <template v-else>
    <HeroSection />
    <PortalGrid />
    <ScutSection />
    <RepoSection />
    <NoteSection />
    <PostSection />
    </template>
  </main>
  <SiteFooter />
  </template>
  <Transition name="boot"><BootScreen v-if="!isAdmin && !ready" /></Transition>
</template>

<style scoped>
.content-banner button { color:var(--accent); border:0; background:none; cursor:pointer; font:inherit; }
/* 内容就绪后加载页淡出并轻微放大，露出下方首页 */
.boot-leave-active { transition:opacity .6s var(--ease),transform .6s var(--ease); }
.boot-leave-to { opacity:0; transform:scale(1.04); }
.content-banner { position:fixed; top:64px; z-index:11; width:100%; padding:8px 24px; margin:0; background:var(--surface); border-bottom:1px solid var(--line); font-size:13px; }
.content-banner button { margin:0 0 0 12px; }
</style>

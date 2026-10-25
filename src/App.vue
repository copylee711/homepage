<script setup lang="ts">
import { defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, watch } from 'vue'
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
// 云盘与分享页按需加载；cloud 子域名的根路径就是云盘。
const DrivePage = defineAsyncComponent(() => import('./components/drive/DrivePage.vue'))
const SharePage = defineAsyncComponent(() => import('./components/drive/SharePage.vue'))
const onCloud = location.hostname.startsWith('cloud.')
// 云盘子域名上的账户页直接回主站（登录 Cookie 两边共用），完成后再跳回来。
if (onCloud && /^\/account\/?$/.test(location.pathname)) {
  const params = new URLSearchParams(location.search)
  const back = params.get('next') ?? '/'
  params.set('next', /^\/(?!\/)/.test(back) ? location.origin + back : location.origin + '/')
  location.replace(`${location.origin.replace('//cloud.', '//')}/account?${params}`)
}
const isShare = /^\/s\/[A-Za-z0-9]+\/?$/.test(location.pathname)
const isDrive = !isShare && (/^\/drive(\/|$)/.test(location.pathname) || (onCloud && location.pathname === '/'))
const isAdmin = location.pathname === '/admin' || location.pathname.startsWith('/admin/')
const isScut = location.pathname.replace(/\/$/, '') === '/scut'
const isAccount = location.pathname.replace(/\/$/, '') === '/account'
const isGames = /^\/games(\/|$)/.test(location.pathname)
let stop: (() => void) | undefined
let stopScut: (() => void) | undefined
onMounted(() => { if (!isAdmin) { stop = startContent(); if (!isDrive && !isShare) stopScut = startScut() } })
onBeforeUnmount(() => { stop?.(); stopScut?.() })

// 从其他页面打开 /#projects 等地址时，浏览器加载瞬间目标尚未渲染，原生锚点跳转会落空。
// 内容就绪后再定位；之后 1.5 秒内上方区块异步加载导致的高度变化会继续校正，用户一旦滚动即停止。
watch(ready, async value => {
  const id = decodeURIComponent(location.hash.slice(1))
  if (!value || !id || isAdmin || isScut || isAccount || isGames || isDrive || isShare) return
  await nextTick()
  const target = document.getElementById(id)
  if (!target) return
  const align = () => target.scrollIntoView({ behavior: 'instant', block: 'start' })
  align()
  const observer = new ResizeObserver(align)
  observer.observe(document.body)
  const release = () => {
    observer.disconnect()
    for (const event of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) removeEventListener(event, release)
  }
  for (const event of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) addEventListener(event, release, { passive: true })
  setTimeout(release, 1500)
})
</script>

<template>
  <AdminPage v-if="isAdmin" />
  <template v-else-if="ready && (isDrive || isShare)">
    <DrivePage v-if="isDrive" />
    <SharePage v-else />
    <SiteFooter :class="{ 'drive-footer': isDrive }" />
  </template>
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

<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { contentStatus, ready, reloadContent, startContent } from './content'
import AdminPage from './components/AdminPage.vue'
import HeroSection from './components/HeroSection.vue'
import PortalGrid from './components/PortalGrid.vue'
import RepoSection from './components/RepoSection.vue'
import SiteFooter from './components/SiteFooter.vue'
import SiteHeader from './components/SiteHeader.vue'
import PostSection from './components/PostSection.vue'
const isAdmin = location.pathname === '/admin' || location.pathname.startsWith('/admin/')
let stop: (() => void) | undefined
onMounted(() => { if (!isAdmin) stop = startContent() })
onBeforeUnmount(() => stop?.())
</script>

<template>
  <AdminPage v-if="isAdmin" />
  <template v-else-if="ready">
  <SiteHeader />
  <p v-if="contentStatus.stale" class="content-banner" role="status">暂时无法检查更新，正在显示已加载的内容。<button @click="reloadContent">重试</button></p>
  <main>
    <HeroSection />
    <PortalGrid />
    <RepoSection />
    <PostSection />
  </main>
  <SiteFooter />
  </template>
  <main v-else class="content-loading container" aria-live="polite">
    <p class="label">Copy Lee</p><h1>{{ contentStatus.loading ? '正在加载内容…' : '内容暂时不可用' }}</h1>
    <p v-if="contentStatus.error">{{ contentStatus.error }}</p>
    <button v-if="!contentStatus.loading" @click="reloadContent">重新加载</button>
  </main>
</template>

<style scoped>
.content-loading { padding-top:25vh; min-height:100vh; }
.content-loading h1 { font-size:2.4rem; margin:20px 0; }
.content-loading p { color:var(--muted); }
.content-loading button,.content-banner button { color:var(--accent); border:0; background:none; cursor:pointer; font:inherit; margin-top:16px; }
.content-banner { position:fixed; top:64px; z-index:11; width:100%; padding:8px 24px; margin:0; background:var(--surface); border-bottom:1px solid var(--line); font-size:13px; }
.content-banner button { margin:0 0 0 12px; }
</style>

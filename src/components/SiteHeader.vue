<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { site } from '../content'
import { useTheme } from '../composables/useTheme'
import AppIcon from './AppIcon.vue'
import LogoMark from './LogoMark.vue'

const { theme, toggle } = useTheme()

const links = [
  { id: 'top', label: 'Home' },
  { id: 'projects', label: 'Projects' },
]
const isScut = location.pathname.replace(/\/$/, '') === '/scut'
// 入口区没有单独的导航项，滚动到那里时仍高亮 Home
const sections = ['top', 'portals', 'projects']

const scrolled = ref(false)
const active = ref('top')
const scroller = ref<HTMLElement>()
const fadeStart = ref(false)
const fadeEnd = ref(false)

// 窄屏下导航横向滚动：两端渐隐提示，并让当前栏目保持可见。
function updateEdges() {
  const el = scroller.value
  if (!el) return
  fadeStart.value = el.scrollLeft > 4
  fadeEnd.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 4
}
function revealActive() {
  const el = scroller.value
  const link = el?.querySelector<HTMLElement>('.active')
  if (!el || !link || el.scrollWidth <= el.clientWidth) return
  el.scrollTo({ left: link.offsetLeft - (el.clientWidth - link.offsetWidth) / 2, behavior: 'smooth' })
}
watch(active, () => nextTick(revealActive))

const onScroll = () => {
  scrolled.value = window.scrollY > 8

  let current = 'top'
  for (const id of sections) {
    const el = document.getElementById(id)
    if (el && el.getBoundingClientRect().top <= window.innerHeight * 0.35) current = id
  }
  active.value = current === 'portals' ? 'top' : current
}

onMounted(() => {
  onScroll()
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', updateEdges, { passive: true })
  nextTick(() => { updateEdges(); revealActive() })
})
onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll)
  window.removeEventListener('resize', updateEdges)
})
</script>

<template>
  <header v-if="site" class="header" :class="{ scrolled }">
    <div class="container bar">
      <a class="brand" :href="isScut ? '/#top' : '#top'" :aria-label="`${site.name} 主页`">
        <LogoMark class="logo" />
        <span>{{ site.name }}</span>
      </a>
      <nav class="nav" aria-label="主导航">
        <div ref="scroller" class="nav-scroll" :class="{ 'fade-start': fadeStart, 'fade-end': fadeEnd }" @scroll.passive="updateEdges">
        <a
          v-for="link in links"
          :key="link.id"
          :href="`${isScut ? '/' : ''}#${link.id}`"
          :class="{ active: !isScut && active === link.id }"
          :aria-current="!isScut && active === link.id ? 'true' : undefined"
        >
          {{ link.label }}
        </a>
        <a href="/scut" :class="{ active: isScut }" :aria-current="isScut ? 'page' : undefined">SCUT</a>
        <a href="/posts">Articles</a>
        <a href="/notes">Notes</a>
        <a :href="site.cloud" target="_blank" rel="noopener">Cloud</a>
        </div>
        <button
          class="theme"
          type="button"
          :aria-label="theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'"
          @click="toggle"
        >
          <AppIcon :name="theme === 'dark' ? 'moon' : 'sun'" />
        </button>
      </nav>
    </div>
  </header>
</template>

<style scoped>
.header {
  position: fixed;
  inset: 0 0 auto;
  z-index: 10;
  height: var(--header-h);
  border-bottom: 1px solid transparent;
  transition:
    background-color 0.4s ease,
    border-color 0.4s ease;
}

.header.scrolled {
  background: var(--header-bg);
  border-bottom-color: var(--line);
  -webkit-backdrop-filter: saturate(180%) blur(20px);
  backdrop-filter: saturate(180%) blur(20px);
}

.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 100%;
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.02em;
  white-space: nowrap;
}

.logo {
  width: 30px;
  height: auto;
}

.nav {
  display: flex;
  flex: 1;
  align-items: stretch;
  justify-content: flex-end;
  gap: clamp(8px, 2vw, 24px);
  min-width: 0;
  height: 100%;
  margin-left: 24px;
  font-size: 14px;
  color: var(--muted);
}

/* 栏目多于屏宽时横向滑动，滚动条隐藏，两端渐隐 */
.nav-scroll {
  display: flex;
  align-items: stretch;
  gap: clamp(16px, 4vw, 40px);
  min-width: 0;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
}

.nav-scroll::-webkit-scrollbar {
  display: none;
}

.nav-scroll.fade-end {
  mask-image: linear-gradient(90deg, #000 calc(100% - 28px), transparent);
}

.nav-scroll.fade-start {
  mask-image: linear-gradient(90deg, transparent, #000 28px);
}

.nav-scroll.fade-start.fade-end {
  mask-image: linear-gradient(90deg, transparent, #000 28px, #000 calc(100% - 28px), transparent);
}

.nav a {
  flex: none;
  position: relative;
  display: inline-flex;
  align-items: center;
  transition: color 0.2s ease;
}

.nav a::after {
  content: '';
  position: absolute;
  inset: auto 0 14px;
  height: 2px;
  border-radius: 2px;
  background: var(--accent);
  transform: scaleX(0);
  transition: transform 0.4s var(--ease);
}

.nav a:hover,
.nav a.active {
  color: var(--text);
}

.nav a.active::after {
  transform: scaleX(1);
}

.theme {
  flex: none;
  display: inline-grid;
  place-items: center;
  align-self: center;
  width: 36px;
  height: 36px;
  margin-right: -8px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: none;
  color: inherit;
  cursor: pointer;
  transition:
    color 0.2s ease,
    background-color 0.2s ease;
}

.theme:hover {
  background: var(--line);
  color: var(--text);
}

.theme svg {
  width: 20px;
  height: 20px;
}

@media (max-width: 760px) {
  .nav-scroll { gap: 20px; }
}

@media (max-width: 479px) {
  .nav { margin-left: 12px; }
  .brand { font-size: 16px; }
  .brand span { display: none; }
}
</style>

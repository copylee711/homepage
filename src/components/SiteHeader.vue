<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { site } from '../site.config'
import { useTheme } from '../composables/useTheme'
import AppIcon from './AppIcon.vue'
import LogoMark from './LogoMark.vue'

const { theme, toggle } = useTheme()

const links = [
  { id: 'top', label: 'Home' },
  { id: 'projects', label: 'Projects' },
]
// 入口区没有单独的导航项，滚动到那里时仍高亮 Home
const sections = ['top', 'portals', 'projects']

const scrolled = ref(false)
const active = ref('top')

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
})
onBeforeUnmount(() => window.removeEventListener('scroll', onScroll))
</script>

<template>
  <header class="header" :class="{ scrolled }">
    <div class="container bar">
      <a class="brand" href="#top">
        <LogoMark class="logo" />
        <span>{{ site.name }}</span>
      </a>
      <nav class="nav" aria-label="主导航">
        <a
          v-for="link in links"
          :key="link.id"
          :href="`#${link.id}`"
          :class="{ active: active === link.id, home: link.id === 'top' }"
          :aria-current="active === link.id ? 'true' : undefined"
        >
          {{ link.label }}
        </a>
        <a :href="site.notes" target="_blank" rel="noopener">Notes</a>
        <a :href="site.cloud" target="_blank" rel="noopener">Cloud</a>
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
  align-items: stretch;
  gap: clamp(16px, 4vw, 40px);
  height: 100%;
  font-size: 14px;
  color: var(--muted);
}

.nav a {
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

@media (max-width: 479px) {
  .nav .home {
    display: none;
  }
}

@media (max-width: 379px) {
  .brand span {
    display: none;
  }
}
</style>

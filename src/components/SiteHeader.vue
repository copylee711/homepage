<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { account, features, loadAccount } from '../account'
import { site } from '../content'
import { useTheme } from '../composables/useTheme'
import AppIcon from './AppIcon.vue'
import LogoMark from './LogoMark.vue'

const { theme, toggle } = useTheme()

const path = location.pathname.replace(/\/$/, '')
const isAccount = path === '/account'
// 非首页时，锚点链接回到首页对应区块。
const onHome = path === ''
// 首页上滚动到作品区时高亮 Make；入口区没有单独的导航项，仍算 Home。
const sections = ['top', 'portals', 'projects']

interface Item { label: string; href: string; hint: string; external?: boolean; current?: boolean }
interface Group { id: string; label: string; items: Item[] }

const scrolled = ref(false)
const section = ref('top')
const openGroup = ref('')

// 导航分三组：读的（文章、笔记、SCUT 通知）、做的（作品、小游戏）、登录后的工作区（团队、文档、云盘）。
const groups = computed<Group[]>(() => {
  const result: Group[] = [
    { id: 'read', label: 'Read', items: [
      { label: 'Articles', href: '/posts', hint: '长文与随笔' },
      { label: 'Notes', href: '/notes', hint: '学习笔记' },
      { label: 'SCUT', href: '/scut', hint: '华工通知聚合', current: path === '/scut' },
    ] },
    { id: 'make', label: 'Make', items: [
      { label: 'Projects', href: `${onHome ? '' : '/'}#projects`, hint: '开源作品', current: onHome && section.value === 'projects' },
      { label: 'Games', href: '/games', hint: '小游戏', current: path.startsWith('/games') },
    ] },
  ]
  if (account.value) {
    const workspace: Item[] = [
      { label: 'Teams', href: '/teams', hint: '团队空间与文件', current: path === '/teams' },
      { label: 'Docs', href: '/docs', hint: '协作文档', current: path === '/docs' },
    ]
    if (features.value.drive && site.value) workspace.push({ label: 'Cloud', href: site.value.cloud, hint: '个人云盘', external: true })
    result.push({ id: 'workspace', label: 'Workspace', items: workspace })
  }
  return result
})
const homeActive = computed(() => onHome && section.value !== 'projects')
const groupActive = (group: Group) => group.items.some(item => item.current)

// 桌面端悬停展开，离开稍等再收起；触屏与键盘点按切换。
let closeTimer = 0
function enter(id: string, event: PointerEvent) {
  if (event.pointerType !== 'mouse') return
  clearTimeout(closeTimer)
  openGroup.value = id
}
function leave(event: PointerEvent) {
  if (event.pointerType !== 'mouse') return
  clearTimeout(closeTimer)
  closeTimer = window.setTimeout(() => { openGroup.value = '' }, 160)
}
// 鼠标悬停时已经展开，点击不再收起；触屏与键盘点击切换。
function flip(id: string, event: MouseEvent) {
  if ((event as PointerEvent).pointerType === 'mouse') { clearTimeout(closeTimer); openGroup.value = id; return }
  openGroup.value = openGroup.value === id ? '' : id
}
function onDocument(event: Event) {
  if (!(event.target as HTMLElement).closest?.('.group')) openGroup.value = ''
}
function onKey(event: KeyboardEvent) { if (event.key === 'Escape') openGroup.value = '' }

const onScroll = () => {
  scrolled.value = window.scrollY > 8
  let current = 'top'
  for (const id of sections) {
    const el = document.getElementById(id)
    if (el && el.getBoundingClientRect().top <= window.innerHeight * 0.35) current = id
  }
  section.value = current
}

onMounted(() => {
  onScroll()
  window.addEventListener('scroll', onScroll, { passive: true })
  document.addEventListener('pointerdown', onDocument)
  document.addEventListener('keydown', onKey)
  if (!isAccount) loadAccount()
})
onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll)
  document.removeEventListener('pointerdown', onDocument)
  document.removeEventListener('keydown', onKey)
  clearTimeout(closeTimer)
})
</script>

<template>
  <header v-if="site" class="header" :class="{ scrolled }">
    <div class="container bar">
      <a class="brand" :href="onHome ? '#top' : '/#top'" :aria-label="`${site.name} 主页`">
        <LogoMark class="logo" />
        <span>{{ site.name }}</span>
      </a>
      <nav class="nav" aria-label="主导航">
        <div class="links">
          <a :href="onHome ? '#top' : '/#top'" class="top-link home" :class="{ active: homeActive }" :aria-current="homeActive ? 'true' : undefined">Home</a>
          <div v-for="group in groups" :key="group.id" class="group" :class="{ open: openGroup === group.id }" @pointerenter="enter(group.id, $event)" @pointerleave="leave">
            <button type="button" class="top-link" :class="{ active: groupActive(group) }" :aria-expanded="openGroup === group.id" aria-haspopup="true" @click="flip(group.id, $event)">
              {{ group.label }}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>
            </button>
            <Transition name="drop">
              <div v-if="openGroup === group.id" class="panel" role="menu">
                <a v-for="item in group.items" :key="item.label" :href="item.href" role="menuitem" :class="{ current: item.current }" :aria-current="item.current ? 'page' : undefined" :target="item.external ? '_blank' : undefined" :rel="item.external ? 'noopener' : undefined" @click="openGroup = ''">
                  <strong>{{ item.label }}<span v-if="item.external" aria-hidden="true"> ↗</span></strong><small>{{ item.hint }}</small>
                </a>
              </div>
            </Transition>
          </div>
        </div>
        <a class="account" :class="{ active: isAccount }" href="/account" :aria-label="account ? `账户：${account.name}` : '登录或注册'" :title="account ? account.name : '登录 / 注册'">
          <img v-if="account?.avatar" :src="account.avatar" alt="">
          <span v-else-if="account" class="initial">{{ account.name.slice(0, 1).toUpperCase() }}</span>
          <svg v-else viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.5" r="3.5" /><path d="M5 19.5a7 7 0 0 1 14 0" /></svg>
        </a>
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

.links {
  display: flex;
  align-items: stretch;
  gap: clamp(14px, 3vw, 34px);
}

.group {
  position: relative;
  display: flex;
}

.top-link {
  flex: none;
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
  transition: color 0.2s ease;
}

.top-link svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.6;
  transition: transform 0.25s var(--ease);
}

.group.open .top-link svg {
  transform: rotate(180deg);
}

.top-link::after {
  content: '';
  position: absolute;
  inset: auto 0 14px;
  height: 2px;
  border-radius: 2px;
  background: var(--accent);
  transform: scaleX(0);
  transition: transform 0.4s var(--ease);
}

.top-link:hover,
.group.open .top-link,
.top-link.active {
  color: var(--text);
}

.top-link.active::after {
  transform: scaleX(1);
}

/* 下拉面板：标题加一行说明，当前页面高亮 */
.panel {
  position: absolute;
  top: calc(100% - 10px);
  left: 50%;
  z-index: 20;
  display: grid;
  gap: 2px;
  min-width: 200px;
  padding: 6px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--bg);
  box-shadow: 0 22px 44px -18px rgba(17, 24, 39, 0.35);
  transform: translateX(-50%);
}

.panel a {
  display: grid;
  gap: 1px;
  padding: 9px 12px;
  border-radius: 9px;
  transition: background-color 0.2s ease;
}

.panel a:hover,
.panel a:focus-visible {
  background: color-mix(in srgb, var(--text) 5%, transparent);
}

.panel a.current {
  background: var(--accent-soft);
}

.panel strong {
  color: var(--text);
  font-size: 14px;
  font-weight: 500;
}

.panel a.current strong {
  color: var(--accent);
}

.panel small {
  color: var(--faint);
  font-size: 12px;
}

.drop-enter-active,
.drop-leave-active {
  transition: opacity 0.18s ease, transform 0.22s var(--ease);
}

.drop-enter-from,
.drop-leave-to {
  opacity: 0;
  transform: translate(-50%, -6px);
}

.account {
  flex: none;
  display: inline-grid;
  place-items: center;
  align-self: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  overflow: hidden;
  color: inherit;
  transition: color 0.2s ease, box-shadow 0.3s ease;
}

.account:hover,
.account.active {
  color: var(--text);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.account svg {
  width: 20px;
  height: 20px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
}

.account img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.initial {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  background: linear-gradient(135deg, var(--accent), #7ea2ff);
  color: #fff;
  font-size: 13px;
  font-weight: 700;
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
  .links { gap: 16px; }
  .panel { left: auto; right: -40px; transform: none; }
  .drop-enter-from, .drop-leave-to { transform: translateY(-6px); }
}

@media (max-width: 479px) {
  .nav { margin-left: 12px; gap: 10px; }
  .links { gap: 14px; }
  /* 窄屏上 Logo 本身就回首页，省掉 Home 给三个分组腾位置 */
  .home { display: none; }
  .brand { font-size: 16px; }
  .brand span { display: none; }
}
</style>

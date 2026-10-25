<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { formatDuration, localBest, submitScore } from '../api'
import { muted, toggleMute } from '../sound'
import { duckMusic, musicOn, playMusic, playSound, stopMusic, toggleMusic, unlockAudio } from './audio'
import type { Track } from './audio'
import GameOver from '../GameOver.vue'
import HealthNotice from '../HealthNotice.vue'
import { HEROES, HERO_ORDER, themeOf } from './data'
import type { HeroId, ItemDef } from './data'
import { Game } from './game'
import portraitsUrl from './pages/portraits.webp'
import selectBgUrl from './pages/select-bg.webp'
import { Controls } from './input'
import { computeView, itemGlyph, render } from './render'
import { heroUrl, loadArt } from './sprites'
import type { View } from './render'
import { WORLD_H, WORLD_W } from './data'

const emit = defineEmits<{ scored: [] }>()

const shell = ref<HTMLDivElement>()
const canvas = ref<HTMLCanvasElement>()
const phase = ref<'menu' | 'select' | 'play' | 'paused' | 'over'>('menu')
const HERO_KEY = 'copylee-dungeon-hero'
const hero = ref<HeroId>(readHero())
function readHero(): HeroId {
  try { const v = localStorage.getItem(HERO_KEY) as HeroId | null; return v && v in HEROES ? v : 'knight' } catch { return 'knight' }
}
function pickHero(id: HeroId) {
  hero.value = id
  try { localStorage.setItem(HERO_KEY, id) } catch { /* 隐私模式下不保存 */ }
}
const immersive = ref(false)
/** 沉浸模式下屏幕仍是竖的（微信等无法锁定横屏的浏览器）：把画面整体旋转 90° */
const rotated = ref(false)
const stageSize = ref<Record<string, string>>({})
/** 画面过矮或过窄时精简开始界面 */
const compact = ref(false)
const narrow = ref(false)
const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches
const best = ref(localBest('dungeon'))
const result = ref<{ improved: boolean; synced: boolean; error?: string }>()
const summary = ref({ score: 0, level: 1, kills: 0, time: 0, items: [] as ItemDef[] })
const pausedItems = ref<ItemDef[]>([])
const artProgress = ref(0)

let game: Game | undefined
const controls = new Controls()
let view: View = computeView(800, 450, 1)
let frame = 0
let last = 0
let observer: ResizeObserver | undefined

const canFullscreen = computed(() => typeof document !== 'undefined' && !!document.documentElement.requestFullscreen)

function resize() {
  const el = canvas.value, box = shell.value
  if (!el || !box) return
  // 按外框实际尺寸判断：真全屏时浏览器会强制外框铺满且禁止 transform，所以只旋转内层 stage
  const sw = box.clientWidth, sh = box.clientHeight
  const turn = immersive.value && sh > sw
  rotated.value = controls.rotated = turn
  const width = turn ? sh : sw, height = turn ? sw : sh
  stageSize.value = turn ? { width: `${width}px`, height: `${height}px` } : {}
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  el.width = Math.round(width * dpr)
  el.height = Math.round(height * dpr)
  view = computeView(width, height, dpr)
  compact.value = height < 480
  narrow.value = width < 600
}

controls.toWorld = (x, y) => ({ x: (x - view.ox) / view.scale, y: (y - view.oy) / view.scale })
controls.playerPos = () => game?.player ?? { x: WORLD_W / 2, y: WORLD_H / 2 }
controls.onPause = () => { if (phase.value === 'play') pause(); else if (phase.value === 'paused') resume() }

/** 开始界面 → 选择英雄；手机上此时就进入横屏全屏 */
function choose() {
  unlockAudio()
  phase.value = 'select'
  if (coarse && !immersive.value) enterImmersive()
}

function start() {
  unlockAudio()
  game = new Game(hero.value)
  game.onSound = playSound
  game.onOver = () => setTimeout(finish, 900)
  if (import.meta.env.DEV) Object.assign(window, { __dungeon: game })
  result.value = undefined
  phase.value = 'play'
  if (coarse && !immersive.value) enterImmersive()
  last = performance.now()
}

async function finish() {
  if (!game) return
  phase.value = 'over'
  summary.value = { score: game.score, level: game.level, kills: game.kills, time: Math.round(game.time), items: game.player.items }
  result.value = await submitScore('dungeon', game.score, Math.round(game.time), game.level)
  best.value = localBest('dungeon')
  emit('scored')
}

function pause() {
  if (phase.value !== 'play' || !game) return
  pausedItems.value = [...game.player.items]
  phase.value = 'paused'
}
function resume() { if (phase.value === 'paused') { phase.value = 'play'; last = performance.now() } }
function giveUp() {
  if (!game) return
  game.state = 'dead'
  finish()
}

async function enterImmersive() {
  immersive.value = true
  // 先按页面内全屏排版；微信等浏览器的横屏锁定可能永远不返回，不能等它
  nextTick(resize)
  setTimeout(resize, 350)
  try {
    await shell.value?.requestFullscreen?.({ navigationUI: 'hide' })
    await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape')
  } catch { /* iOS、微信等不支持时退回页面内全屏并旋转画面 */ }
  requestAnimationFrame(resize)
}
/** 结束界面返回：退出全屏并回到开始界面 */
function backToMenu() {
  game = undefined
  phase.value = 'menu'
  exitImmersive()
}
function exitImmersive() {
  immersive.value = false
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  requestAnimationFrame(resize)
}
function onFullscreenChange() {
  requestAnimationFrame(resize)
  if (!document.fullscreenElement && immersive.value && !coarse) exitImmersive()
}

const THEME_TRACKS: Track[] = ['stone', 'moss', 'lava', 'sand']
/** 按当前场景挑选配乐 */
function updateMusic() {
  if (phase.value === 'over') { stopMusic(); return }
  if (!game || phase.value === 'menu' || phase.value === 'select') { playMusic('menu'); return }
  if (game.room.type === 'boss' && game.boss) playMusic('boss')
  else if (game.room.type === 'shop') playMusic('shop')
  else playMusic(THEME_TRACKS[themeOf(game.level)])
}
watch(phase, p => duckMusic(p === 'paused'))
watch(muted, m => { if (m) stopMusic(); else updateMusic() })

function loop(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000 || 0)
  last = now
  const g = canvas.value?.getContext('2d')
  if (game && phase.value === 'play' && game.update(dt, controls.read())) controls.consume()
  updateMusic()
  if (g) {
    if (game) render(g, game, view, controls.touch.active || coarse ? { ...controls.touch, active: true } : null, now / 1000)
    else drawIdle(g, now / 1000)
  }
  frame = requestAnimationFrame(loop)
}

/** 菜单背景：缓慢漂浮的火星。 */
function drawIdle(g: CanvasRenderingContext2D, t: number) {
  const { width, height, dpr } = view
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  const grad = g.createRadialGradient(width / 2, height * 0.6, 10, width / 2, height * 0.6, Math.max(width, height) * 0.7)
  grad.addColorStop(0, '#1d2033'); grad.addColorStop(1, '#07080d')
  g.fillStyle = grad
  g.fillRect(0, 0, width, height)
  for (let i = 0; i < 40; i++) {
    const x = ((i * 97.3 + t * (8 + (i % 5) * 3)) % (width + 40)) - 20
    const y = height - ((i * 53.7 + t * (14 + (i % 7) * 4)) % (height + 40))
    g.fillStyle = `rgba(255,${150 + (i % 4) * 20},80,${0.25 + (i % 3) * 0.15})`
    g.beginPath(); g.arc(x, y, 1 + (i % 3), 0, 7); g.fill()
  }
}

function onVisibility() { if (document.hidden) pause() }

function itemIcon(el: Element | null, item: ItemDef) {
  const c = el as HTMLCanvasElement | null
  if (!c) return
  const g = c.getContext('2d')!
  c.width = c.height = 64
  g.clearRect(0, 0, 64, 64)
  itemGlyph(g, item, 32, 32, 22)
}

onMounted(() => {
  loadArt((done, total) => { artProgress.value = done / total })
  document.fonts?.load('16px Abyss').catch(() => {})
  resize()
  observer = new ResizeObserver(resize)
  observer.observe(canvas.value!)
  controls.attach(canvas.value!)
  document.addEventListener('visibilitychange', onVisibility)
  document.addEventListener('fullscreenchange', onFullscreenChange)
  window.addEventListener('resize', resize)
  last = performance.now()
  frame = requestAnimationFrame(loop)
})
onBeforeUnmount(() => {
  cancelAnimationFrame(frame)
  stopMusic()
  observer?.disconnect()
  controls.detach()
  document.removeEventListener('visibilitychange', onVisibility)
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  window.removeEventListener('resize', resize)
})
</script>

<template>
  <div ref="shell" class="shell" :class="{ immersive, rotated, compact, narrow, 'in-menu': phase === 'menu' }">
    <div class="stage" :style="stageSize">
    <canvas ref="canvas" class="screen" aria-label="深渊骑士游戏画面" />
    <div class="corner">
      <button v-if="phase === 'play'" type="button" aria-label="暂停" @click="pause">❚❚</button>
      <button v-if="!immersive" type="button" class="wide" @click="enterImmersive">{{ canFullscreen ? '全屏' : '沉浸模式' }}</button>
      <button v-else type="button" class="wide" @click="exitImmersive">退出全屏</button>
    </div>

    <div v-if="phase === 'menu'" class="panel menu" :style="{ '--hero': `url(${heroUrl})` }">
      <p class="eyebrow">ROGUELIKE · 地牢闯关</p>
      <h2>深渊骑士</h2>
      <p class="lead">一层层深入地牢，清空房间、收集武器与宝物，击败每层首领。死亡后从头开始。</p>
      <div class="keys" :class="{ touch: coarse }">
        <template v-if="!coarse">
          <span><kbd>W A S D</kbd>移动</span>
          <span><kbd>鼠标</kbd>瞄准 / 按住射击</span>
          <span><kbd>方向键</kbd>朝该方向射击</span>
          <span><kbd>空格</kbd>翻滚闪避</span>
          <span><kbd>R</kbd>英雄技能</span>
          <span><kbd>Q</kbd><kbd>滚轮</kbd>切换武器</span>
          <span><kbd>E</kbd>拾取 / 互动</span>
        </template>
        <template v-else>
          <span>左侧拖动：移动</span>
          <span>按住“射击”：自动瞄准，拖动可手动瞄准</span>
          <span>“翻滚”：闪避子弹；技能键：英雄技能</span>
        </template>
      </div>
      <button type="button" class="go" @click="choose">开始冒险</button>
      <p v-if="artProgress < 1" class="best">正在加载美术素材 {{ Math.round(artProgress * 100) }}%</p>
      <p v-if="best" class="best">最佳 {{ best.best }} 分 · 第 {{ best.detail }} 层</p>
      <p v-if="coarse && !immersive" class="hint">开始后会自动进入横屏全屏</p>
      <HealthNotice dark class="notice" />
    </div>

    <div v-else-if="phase === 'select'" class="panel select" :style="{ '--bg': `url(${selectBgUrl})` }">
      <h2>选择英雄</h2>
      <div class="heroes" role="radiogroup" aria-label="英雄">
        <button
          v-for="(id, i) in HERO_ORDER" :key="id" type="button" class="hero" role="radio" :aria-checked="hero === id"
          :class="{ on: hero === id }" :style="{ '--c': HEROES[id].color }" @click="pickHero(id)" @dblclick="start"
        >
          <span class="portrait" :style="{ backgroundImage: `url(${portraitsUrl})`, backgroundPosition: `${i * 50}% 0` }" />
          <span class="name">{{ HEROES[id].name }}<small>{{ HEROES[id].title }}</small></span>
          <span class="desc">{{ HEROES[id].text }}</span>
          <span class="skill"><b>{{ HEROES[id].skill }}</b>{{ HEROES[id].skillText }}</span>
        </button>
      </div>
      <div class="row">
        <button type="button" class="ghost" @click="phase = 'menu'">返回</button>
        <button type="button" class="go" @click="start">出发</button>
      </div>
    </div>

    <div v-else-if="phase === 'paused'" class="panel">
      <h2>暂停</h2>
      <p v-if="game" class="lead">第 {{ game.level }} 层 · {{ game.score }} 分 · 用时 {{ formatDuration(Math.round(game.time)) }}</p>
      <ul v-if="pausedItems.length" class="items">
        <li v-for="(item, i) in pausedItems" :key="i" :title="item.text"><canvas :ref="el => itemIcon(el as Element, item)" /><span>{{ item.name }}</span></li>
      </ul>
      <p v-else class="hint">还没有拾取宝物。宝箱房和首领房会掉落。</p>
      <div class="row">
        <button type="button" class="go" @click="resume">继续</button>
        <button type="button" class="ghost" @click="giveUp">结束本局</button>
      </div>
      <div class="row">
        <button type="button" class="link" @click="toggleMute">{{ muted ? '打开声音' : '关闭声音' }}</button>
        <button type="button" class="link" :disabled="muted" @click="toggleMusic">{{ musicOn ? '关闭音乐' : '打开音乐' }}</button>
      </div>
    </div>

    <GameOver v-else-if="phase === 'over'" title="你倒下了" :result="result" again="再来一局" back="返回" @again="start" @back="backToMenu">
      <p class="big">{{ summary.score }}<small>分</small></p>
      <p>到达第 {{ summary.level }} 层 · 击败 {{ summary.kills }} 个敌人 · {{ formatDuration(summary.time) }}</p>
    </GameOver>
    </div>
  </div>
</template>

<style scoped>
/* 游戏专用字体：站酷庆科黄油体（SIL OFL 1.1，见 font/OFL.txt），只包含游戏里用到的字 */
@font-face { font-family:'Abyss'; src:url('./font/game.woff') format('woff'); font-display:swap; }
.shell { --game-font:'Abyss','PingFang SC','Microsoft YaHei',sans-serif; font-family:var(--game-font); font-synthesis:none; position:relative; width:100%; aspect-ratio:16/9; max-height:calc(100dvh - var(--header-h) - 120px); min-height:300px; border-radius:20px; overflow:hidden; background:#07080d; box-shadow:0 0 0 1px var(--line),0 30px 60px -40px rgba(17,24,39,.6); user-select:none; -webkit-user-select:none; -webkit-touch-callout:none; }
.shell.immersive { position:fixed; inset:0; z-index:1000; width:100vw; height:100dvh; max-height:none; aspect-ratio:auto; border-radius:0; }
.stage { position:absolute; inset:0; }
.rotated .stage { inset:auto; top:0; left:0; transform-origin:0 0; transform:rotate(90deg) translateY(-100%); }
.shell:fullscreen { width:100vw; height:100vh; max-height:none; border-radius:0; }
.screen { display:block; width:100%; height:100%; touch-action:none; cursor:crosshair; }
.corner { position:absolute; z-index:6; top:calc(env(safe-area-inset-top) + 62px); left:calc(env(safe-area-inset-left) + 12px); display:flex; gap:6px; }
.corner button { white-space:nowrap; height:32px; min-width:32px; padding:0 10px; border:2px solid #07080c; border-radius:5px; background:linear-gradient(180deg,#4a5064,#262a38 60%,#1a1d27); box-shadow:inset 0 1px 0 rgba(255,255,255,.22),inset 0 -2px 0 rgba(0,0,0,.45),0 0 0 1px rgba(160,170,195,.28); color:#dfe4ee; font:700 12px var(--game-font); letter-spacing:.06em; text-shadow:0 1px 0 #000; cursor:pointer; }
.corner button:active { transform:translateY(1px); box-shadow:inset 0 1px 0 rgba(255,255,255,.12),inset 0 1px 3px rgba(0,0,0,.6),0 0 0 1px rgba(160,170,195,.28); }
.panel { position:absolute; inset:0; z-index:5; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; padding:24px; background:rgba(5,6,12,.55); color:#e8ecf5; text-align:center; backdrop-filter:blur(3px); overflow:auto; }
.menu { background:linear-gradient(90deg,rgba(5,6,12,.15) 0%,rgba(5,6,12,.55) 45%,rgba(5,6,12,.88) 100%),var(--hero) center/cover no-repeat; backdrop-filter:none; align-items:flex-end; padding-right:clamp(24px,7%,90px); text-align:right; }
.menu .keys { justify-items:end; }
.menu .notice { max-width:560px; margin-top:6px; text-align:inherit; }
.compact .menu .lead,.compact .menu .keys,.compact .menu .best,.compact .menu .eyebrow { display:none; }
.compact .menu h2 { font-size:28px; }
.compact .menu .go { margin-top:2px; padding:10px 28px; }
.narrow .menu { align-items:center; text-align:center; padding:16px; background:linear-gradient(rgba(5,6,12,.35),rgba(5,6,12,.82)),var(--hero) 30% center/cover no-repeat; }
.narrow .menu .keys { justify-items:center; }
.in-menu .corner { top:calc(env(safe-area-inset-top) + 12px); }
.eyebrow { color:#ffd166; font:600 12px var(--game-font); letter-spacing:.2em; }
.panel h2 { font-size:clamp(28px,6vw,52px); font-weight:800; letter-spacing:.04em; text-shadow:0 6px 30px rgba(255,140,60,.35); }
.lead { max-width:520px; color:rgba(232,236,245,.75); font-size:14px; line-height:1.7; }
.keys { display:grid; grid-template-columns:repeat(3,auto); gap:8px 18px; margin:8px 0 4px; color:rgba(232,236,245,.8); font-size:13px; }
.keys.touch { grid-template-columns:1fr; }
kbd { display:inline-block; min-width:22px; margin-right:6px; padding:2px 6px; border:1px solid rgba(255,255,255,.25); border-bottom-width:2px; border-radius:6px; font:600 11px var(--font-mono); color:#fff; }
/* 游戏内按钮：锻造铜牌（主要）与铁牌（次要），深色描边、四角铆钉、两侧菱形饰钉，按下时下沉 */
.go, .ghost, .shell :deep(.again), .shell :deep(.back) {
  position:relative; margin-top:8px; padding:11px 40px 13px; border:2px solid #1c0d04; border-radius:6px; cursor:pointer;
  font:900 17px var(--game-font); letter-spacing:.32em; text-indent:.32em; white-space:nowrap;
  transition:transform .12s, filter .2s, box-shadow .2s;
}
.go, .shell :deep(.again) {
  color:#3b1a05; text-shadow:0 1px 0 rgba(255,236,190,.75);
  background:
    radial-gradient(circle at 8px 8px, #fff1c2 0 1.5px, #6b3a12 2px 3px, transparent 3.5px),
    radial-gradient(circle at calc(100% - 8px) 8px, #fff1c2 0 1.5px, #6b3a12 2px 3px, transparent 3.5px),
    radial-gradient(circle at 8px calc(100% - 8px), #fff1c2 0 1.5px, #6b3a12 2px 3px, transparent 3.5px),
    radial-gradient(circle at calc(100% - 8px) calc(100% - 8px), #fff1c2 0 1.5px, #6b3a12 2px 3px, transparent 3.5px),
    linear-gradient(180deg,#ffe08a 0%,#f6a63c 42%,#d9701f 58%,#a8481a 100%);
  box-shadow:inset 0 2px 0 rgba(255,246,214,.8), inset 0 -4px 0 rgba(110,40,6,.55), inset 0 0 0 1px rgba(255,214,140,.35),
    0 0 0 3px #6d3c14, 0 0 0 4px #1c0d04, 0 10px 24px -8px rgba(255,120,40,.65);
}
.ghost, .shell :deep(.back) {
  color:#dfe4ee; text-shadow:0 1px 0 #000;
  background:
    radial-gradient(circle at 8px 8px, #c9d0de 0 1.5px, #2a2e3a 2px 3px, transparent 3.5px),
    radial-gradient(circle at calc(100% - 8px) 8px, #c9d0de 0 1.5px, #2a2e3a 2px 3px, transparent 3.5px),
    radial-gradient(circle at 8px calc(100% - 8px), #c9d0de 0 1.5px, #2a2e3a 2px 3px, transparent 3.5px),
    radial-gradient(circle at calc(100% - 8px) calc(100% - 8px), #c9d0de 0 1.5px, #2a2e3a 2px 3px, transparent 3.5px),
    linear-gradient(180deg,#5a6177 0%,#373c4d 48%,#262a37 52%,#1b1e28 100%);
  box-shadow:inset 0 2px 0 rgba(255,255,255,.22), inset 0 -4px 0 rgba(0,0,0,.45),
    0 0 0 3px #3a3f50, 0 0 0 4px #07080c, 0 8px 18px -10px rgba(0,0,0,.8);
  font-size:15px; padding:10px 30px 12px;
}
/* 两侧的菱形饰钉 */
.go::before, .go::after, .ghost::before, .ghost::after {
  content:''; position:absolute; top:50%; width:9px; height:9px; margin-top:-5px; transform:rotate(45deg);
  border:2px solid #1c0d04; background:linear-gradient(135deg,#fff3c9,#c97a2a);
}
.ghost::before, .ghost::after { border-color:#07080c; background:linear-gradient(135deg,#e8ecf5,#5b6278); }
.go::before, .ghost::before { left:-8px; }
.go::after, .ghost::after { right:-8px; }
.go:hover, .ghost:hover, .shell :deep(.again:hover), .shell :deep(.back:hover) { filter:brightness(1.1); transform:translateY(-1px); }
.go:active, .ghost:active, .shell :deep(.again:active), .shell :deep(.back:active) { transform:translateY(2px); filter:brightness(.95); }
.go:active, .shell :deep(.again:active) { box-shadow:inset 0 1px 0 rgba(255,246,214,.5), inset 0 2px 6px rgba(110,40,6,.6), 0 0 0 3px #6d3c14, 0 0 0 4px #1c0d04; }
.go:focus-visible, .ghost:focus-visible { outline:2px solid #ffe08a; outline-offset:6px; }
.shell :deep(.again), .shell :deep(.back) { width:100%; margin-top:16px; }
.shell :deep(.back) { margin-top:14px; }
.link { border:0; background:none; color:rgba(232,236,245,.6); font:13px var(--game-font); cursor:pointer; text-decoration:underline; }
.row { display:flex; gap:28px; align-items:center; }
.best,.hint { color:rgba(232,236,245,.6); font-size:12px; }
.items { list-style:none; display:flex; flex-wrap:wrap; justify-content:center; gap:8px; max-width:520px; margin:6px 0; padding:0; }
.items li { display:flex; align-items:center; gap:6px; padding:4px 10px 4px 4px; border-radius:999px; background:rgba(255,255,255,.08); font-size:12px; }
.items canvas { width:24px; height:24px; }
.big { font:800 48px var(--font-mono); }
.big small { margin-left:4px; font-size:16px; }
.select { background:linear-gradient(rgba(5,6,12,.25),rgba(5,6,12,.75)),var(--bg) center/cover no-repeat; backdrop-filter:none; gap:12px; }
.select h2 { font-size:clamp(22px,4vw,34px); }
.heroes { display:grid; grid-template-columns:repeat(3,minmax(0,210px)); gap:12px; width:100%; justify-content:center; }
.hero { display:flex; flex-direction:column; align-items:center; gap:4px; padding:10px 10px 12px; border:1px solid rgba(255,255,255,.14); border-radius:14px; background:rgba(10,12,22,.62); color:#e8ecf5; font:13px var(--game-font); text-align:center; cursor:pointer; transition:transform .2s,border-color .2s,box-shadow .2s; }
.hero:hover { transform:translateY(-3px); }
.hero.on { border-color:var(--c); box-shadow:0 0 0 1px var(--c),0 12px 34px -12px var(--c); background:rgba(14,18,32,.8); }
.portrait { width:min(100%,150px); aspect-ratio:375/363; background-size:300% 100%; background-repeat:no-repeat; filter:saturate(.75) brightness(.8); transition:filter .2s,transform .2s; }
.hero.on .portrait { filter:none; transform:scale(1.04); }
.name { font-size:17px; font-weight:800; }
.name small { margin-left:6px; color:var(--c); font:600 10px var(--game-font); letter-spacing:.16em; }
.desc { color:rgba(232,236,245,.72); font-size:12px; line-height:1.5; }
.skill { margin-top:2px; color:rgba(232,236,245,.88); font-size:12px; line-height:1.5; }
.skill b { display:block; color:var(--c); }
.compact .select { gap:6px; padding:10px; }
.compact .select h2 { display:none; }
.compact .portrait { width:min(100%,92px); }
.compact .desc { display:none; }
.compact .hero { padding:6px 8px 8px; }
.narrow .heroes { grid-template-columns:1fr; max-width:360px; }
.narrow .hero { display:grid; grid-template-columns:72px 1fr; text-align:left; align-items:center; column-gap:10px; }
.narrow .portrait { grid-row:span 3; width:72px; }
@media (max-height: 520px) { .menu .lead, .menu .best { display:none; } .menu h2 { font-size:30px; } .menu .keys { margin:0; font-size:12px; } .panel { gap:6px; padding:12px; } }
@media (max-width: 640px) { .keys { grid-template-columns:1fr 1fr; } .shell:not(.immersive) { aspect-ratio:4/3; } }

/* 结算卡片：与游戏一致的暗色铁框面板 */
.shell :deep(.overlay) { background:radial-gradient(ellipse at center,rgba(40,8,12,.45),rgba(4,4,8,.78)); }
.shell :deep(.card) {
  position:relative; width:min(100%,320px); padding:24px 24px 22px; border:2px solid #07080c; border-radius:8px; color:#e8ecf5; font-family:var(--game-font);
  background:
    radial-gradient(circle at 10px 10px, #c9d0de 0 1.5px, #2a2e3a 2px 3px, transparent 3.5px),
    radial-gradient(circle at calc(100% - 10px) 10px, #c9d0de 0 1.5px, #2a2e3a 2px 3px, transparent 3.5px),
    radial-gradient(circle at 10px calc(100% - 10px), #c9d0de 0 1.5px, #2a2e3a 2px 3px, transparent 3.5px),
    radial-gradient(circle at calc(100% - 10px) calc(100% - 10px), #c9d0de 0 1.5px, #2a2e3a 2px 3px, transparent 3.5px),
    linear-gradient(180deg,#232736,#14161f 70%,#0e1017);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.12), inset 0 0 40px rgba(0,0,0,.5), 0 0 0 3px #3a3f50, 0 0 0 4px #07080c, 0 30px 60px -20px rgba(0,0,0,.8);
}
.shell :deep(.card .title) { color:#ff8a7a; font-size:22px; letter-spacing:.3em; text-indent:.3em; text-shadow:0 2px 12px rgba(255,60,60,.45),0 1px 0 #000; }
.shell :deep(.card .big) { color:#ffd166; text-shadow:0 3px 0 #6d3c14,0 0 18px rgba(255,170,60,.35); font-family:var(--game-font); }
.shell :deep(.card .big small) { color:#e8d3a2; }
.shell :deep(.card p) { color:rgba(232,236,245,.82); }
.shell :deep(.card .status) { color:rgba(232,236,245,.55); }
.shell :deep(.card .status a) { color:#ffd166; }
.shell :deep(.card .record) { color:#ffd166; text-shadow:0 0 12px rgba(255,200,80,.5); }
/* 小字号的说明文字用系统字体，保证可读 */
.lead, .desc, .skill, .keys span, .hint, .best, .items, .notice, .shell :deep(.card p:not(.title):not(.big)) { font-family:var(--font); }
.skill b, .name { font-family:var(--game-font); }
</style>

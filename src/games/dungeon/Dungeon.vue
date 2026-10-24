<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { formatDuration, localBest, submitScore } from '../api'
import { dungeonSound, muted, toggleMute } from '../sound'
import GameOver from '../GameOver.vue'
import HealthNotice from '../HealthNotice.vue'
import type { ItemDef } from './data'
import { Game } from './game'
import { Controls } from './input'
import { computeView, itemGlyph, render } from './render'
import { heroUrl, loadArt } from './sprites'
import type { View } from './render'
import { WORLD_H, WORLD_W } from './data'

const emit = defineEmits<{ scored: [] }>()

const shell = ref<HTMLDivElement>()
const canvas = ref<HTMLCanvasElement>()
const phase = ref<'menu' | 'play' | 'paused' | 'over'>('menu')
const immersive = ref(false)
/** 沉浸模式下屏幕仍是竖的（微信等无法锁定横屏的浏览器）：把画面整体旋转 90° */
const rotated = ref(false)
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
  const el = canvas.value
  if (!el) return
  const turn = immersive.value && window.innerHeight > window.innerWidth
  if (turn !== rotated.value) {
    rotated.value = controls.rotated = turn
    nextTick(resize)
    return
  }
  // clientWidth/Height 是旋转前的布局尺寸，正好是横屏画面的宽高
  const width = el.clientWidth, height = el.clientHeight
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

function start() {
  game = new Game()
  game.onSound = dungeonSound
  game.onOver = () => setTimeout(finish, 900)
  if (import.meta.env.DEV) Object.assign(window, { __dungeon: game })
  result.value = undefined
  phase.value = 'play'
  if (coarse) enterImmersive()
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
  try {
    await shell.value?.requestFullscreen?.({ navigationUI: 'hide' })
    await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape')
  } catch { /* iOS 等不支持时退回页面内全屏 */ }
  requestAnimationFrame(resize)
}
function exitImmersive() {
  immersive.value = false
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  requestAnimationFrame(resize)
}
function onFullscreenChange() { if (!document.fullscreenElement && immersive.value && !coarse) exitImmersive() }

function loop(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000 || 0)
  last = now
  const g = canvas.value?.getContext('2d')
  if (game && phase.value === 'play' && game.update(dt, controls.read())) controls.consume()
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
  observer?.disconnect()
  controls.detach()
  document.removeEventListener('visibilitychange', onVisibility)
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  window.removeEventListener('resize', resize)
})
</script>

<template>
  <div ref="shell" class="shell" :class="{ immersive, rotated, compact, narrow, 'in-menu': phase === 'menu' }">
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
          <span><kbd>Q</kbd>切换武器</span>
          <span><kbd>E</kbd>拾取 / 互动</span>
        </template>
        <template v-else>
          <span>左侧拖动：移动</span>
          <span>按住“射击”：自动瞄准，拖动可手动瞄准</span>
          <span>“翻滚”：闪避子弹</span>
        </template>
      </div>
      <button type="button" class="go" @click="start">开始冒险</button>
      <p v-if="artProgress < 1" class="best">正在加载美术素材 {{ Math.round(artProgress * 100) }}%</p>
      <p v-if="best" class="best">最佳 {{ best.best }} 分 · 第 {{ best.detail }} 层</p>
      <p v-if="coarse && !immersive" class="hint">开始后会自动进入横屏全屏</p>
      <HealthNotice dark class="notice" />
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
      <button type="button" class="link" @click="toggleMute">{{ muted ? '打开音效' : '关闭音效' }}</button>
    </div>

    <GameOver v-else-if="phase === 'over'" title="你倒下了" :result="result" again="再来一局" @again="start">
      <p class="big">{{ summary.score }}<small>分</small></p>
      <p>到达第 {{ summary.level }} 层 · 击败 {{ summary.kills }} 个敌人 · {{ formatDuration(summary.time) }}</p>
    </GameOver>

  </div>
</template>

<style scoped>
.shell { position:relative; width:100%; aspect-ratio:16/9; max-height:calc(100dvh - var(--header-h) - 120px); min-height:300px; border-radius:20px; overflow:hidden; background:#07080d; box-shadow:0 0 0 1px var(--line),0 30px 60px -40px rgba(17,24,39,.6); user-select:none; -webkit-user-select:none; -webkit-touch-callout:none; }
.shell.immersive { position:fixed; inset:0; z-index:1000; width:100vw; height:100dvh; max-height:none; aspect-ratio:auto; border-radius:0; }
.shell.immersive.rotated { inset:0 auto auto 0; width:100dvh; height:100vw; transform-origin:0 0; transform:rotate(90deg) translateY(-100%); }
.shell:fullscreen { width:100vw; height:100vh; max-height:none; border-radius:0; }
.screen { display:block; width:100%; height:100%; touch-action:none; cursor:crosshair; }
.corner { position:absolute; z-index:6; top:calc(env(safe-area-inset-top) + 62px); left:calc(env(safe-area-inset-left) + 12px); display:flex; gap:6px; }
.corner button { white-space:nowrap; height:32px; min-width:32px; padding:0 10px; border:1px solid rgba(255,255,255,.18); border-radius:9px; background:rgba(10,12,20,.6); color:#e8ecf5; font:600 12px var(--font); cursor:pointer; }
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
.eyebrow { color:#ffd166; font:600 12px var(--font); letter-spacing:.2em; }
.panel h2 { font-size:clamp(28px,6vw,52px); font-weight:800; letter-spacing:.04em; text-shadow:0 6px 30px rgba(255,140,60,.35); }
.lead { max-width:520px; color:rgba(232,236,245,.75); font-size:14px; line-height:1.7; }
.keys { display:grid; grid-template-columns:repeat(3,auto); gap:8px 18px; margin:8px 0 4px; color:rgba(232,236,245,.8); font-size:13px; }
.keys.touch { grid-template-columns:1fr; }
kbd { display:inline-block; min-width:22px; margin-right:6px; padding:2px 6px; border:1px solid rgba(255,255,255,.25); border-bottom-width:2px; border-radius:6px; font:600 11px var(--font-mono); color:#fff; }
.go { margin-top:8px; padding:12px 34px; border:0; border-radius:12px; background:linear-gradient(180deg,#ffb347,#ff7b3d); color:#1b0f05; font:800 16px var(--font); cursor:pointer; box-shadow:0 10px 30px -10px rgba(255,123,61,.7); transition:transform .2s; }
.go:hover { transform:translateY(-2px); }
.ghost { margin-top:8px; padding:12px 22px; border:1px solid rgba(255,255,255,.3); border-radius:12px; background:none; color:#e8ecf5; font:600 14px var(--font); cursor:pointer; }
.link { border:0; background:none; color:rgba(232,236,245,.6); font:13px var(--font); cursor:pointer; text-decoration:underline; }
.row { display:flex; gap:10px; }
.best,.hint { color:rgba(232,236,245,.6); font-size:12px; }
.items { list-style:none; display:flex; flex-wrap:wrap; justify-content:center; gap:8px; max-width:520px; margin:6px 0; padding:0; }
.items li { display:flex; align-items:center; gap:6px; padding:4px 10px 4px 4px; border-radius:999px; background:rgba(255,255,255,.08); font-size:12px; }
.items canvas { width:24px; height:24px; }
.big { font:800 48px var(--font-mono); }
.big small { margin-left:4px; font-size:16px; }
@media (max-height: 520px) { .menu .lead, .menu .best { display:none; } .menu h2 { font-size:30px; } .menu .keys { margin:0; font-size:12px; } .panel { gap:6px; padding:12px; } }
@media (max-width: 640px) { .keys { grid-template-columns:1fr 1fr; } .shell:not(.immersive) { aspect-ratio:4/3; } }
</style>

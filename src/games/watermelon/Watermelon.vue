<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { localBest, submitScore } from '../api'
import { sfx } from '../sound'
import GameOver from '../GameOver.vue'
import { FRUITS, sprite } from './fruits'
import { HEIGHT, LINE_Y, MAX_LEVEL, RADII, WIDTH, World, clamp } from './physics'

const emit = defineEmits<{ scored: [] }>()

const canvas = ref<HTMLCanvasElement>()
const score = ref(0)
const best = ref(localBest('watermelon')?.best ?? 0)
const next = ref(0)
const top = ref(0)
const over = ref(false)
const result = ref<{ improved: boolean; synced: boolean; error?: string }>()

let world = new World()
let current = 0
let aim = WIDTH / 2
let cooldown = 0
let danger = 0
let drops = 0
let started = 0
let frame = 0
let last = 0
let scale = 1
let dpr = 1
let popups: { text: string; x: number; y: number; life: number }[] = []
let observer: ResizeObserver | undefined

/** 前几次只出小水果，之后最多出到第 5 级。 */
function roll() {
  const pool = drops < 5 ? [0, 0, 1, 1, 2] : [0, 0, 0, 1, 1, 1, 2, 2, 3, 4]
  return pool[Math.floor(Math.random() * pool.length)]
}

function reset() {
  world = new World()
  drops = 0
  current = roll(); next.value = roll()
  score.value = 0; top.value = 0; danger = 0; cooldown = 0
  popups = []
  aim = WIDTH / 2
  over.value = false; result.value = undefined
  started = performance.now()
}

function drop() {
  if (over.value || cooldown > 0) return
  // 轻微随机偏移，避免同一位置落下的水果完美竖直叠住
  world.add(current, aim + (Math.random() - 0.5) * 0.8, LINE_Y - RADII[current] - 14, 80)
  drops++
  current = next.value
  next.value = roll()
  cooldown = 0.55
  sfx.drop()
}

async function finish() {
  over.value = true
  sfx.lose()
  const duration = Math.round((performance.now() - started) / 1000)
  result.value = await submitScore('watermelon', score.value, duration)
  best.value = Math.max(best.value, score.value)
  emit('scored')
}

function tick(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000 || 0)
  last = now
  if (!over.value) {
    cooldown = Math.max(0, cooldown - dt)
    for (const event of world.update(dt)) {
      score.value += event.points
      top.value = Math.max(top.value, event.level)
      popups.push({ text: `+${event.points}`, x: event.x, y: event.y, life: 1 })
      sfx.merge(event.level)
      if (event.level === MAX_LEVEL) sfx.win()
    }
    danger = world.overLine() ? danger + dt : Math.max(0, danger - dt * 2)
    if (danger > 2.5) finish()
  }
  popups = popups.filter(p => (p.life -= dt * 1.3) > 0)
  render()
  frame = requestAnimationFrame(tick)
}

function render() {
  const g = canvas.value?.getContext('2d')
  if (!g) return
  const dark = document.documentElement.dataset.theme === 'dark'
  g.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0)
  const bg = g.createLinearGradient(0, 0, 0, HEIGHT)
  bg.addColorStop(0, dark ? '#1d2233' : '#fff6e3')
  bg.addColorStop(1, dark ? '#2a2620' : '#ffe2b8')
  g.fillStyle = bg
  g.fillRect(0, 0, WIDTH, HEIGHT)
  g.fillStyle = dark ? '#5a4632' : '#e9b77a'
  g.fillRect(0, HEIGHT - 8, WIDTH, 8)

  // 警戒线：有危险时闪烁变红
  const warn = danger > 0 || world.fruits.some(f => f.age > 1 && f.y - f.r < LINE_Y + 40)
  const flash = danger > 0 ? 0.45 + 0.55 * Math.abs(Math.sin(performance.now() / 120)) : 1
  g.strokeStyle = warn ? `rgba(232,52,78,${flash})` : dark ? 'rgba(255,255,255,.18)' : 'rgba(150,90,30,.25)'
  g.lineWidth = 2
  g.setLineDash([10, 8])
  g.beginPath(); g.moveTo(0, LINE_Y); g.lineTo(WIDTH, LINE_Y); g.stroke()
  g.setLineDash([])

  // 待落下的水果与辅助线
  if (!over.value && cooldown <= 0) {
    const r = RADII[current]
    const x = clamp(aim, r, WIDTH - r)
    g.strokeStyle = dark ? 'rgba(255,255,255,.14)' : 'rgba(120,70,20,.16)'
    g.lineWidth = 2
    g.beginPath(); g.moveTo(x, LINE_Y - 14); g.lineTo(x, HEIGHT); g.stroke()
    paint(g, current, x, LINE_Y - r - 14, 0, 1)
  }
  for (const f of world.fruits) paint(g, f.level, f.x, f.y, f.angle, 0.6 + 0.4 * easeOut(f.pop))

  g.textAlign = 'center'
  g.font = '800 22px Outfit Variable, sans-serif'
  for (const p of popups) {
    g.globalAlpha = Math.min(1, p.life * 1.5)
    g.fillStyle = '#ff7a1a'
    g.fillText(p.text, p.x, p.y - (1 - p.life) * 40)
  }
  g.globalAlpha = 1
}

function paint(g: CanvasRenderingContext2D, level: number, x: number, y: number, angle: number, size: number) {
  const image = sprite(level, RADII[level] * scale * dpr)
  const w = (image.width / (scale * dpr)) * size
  g.save()
  g.translate(x, y)
  g.rotate(angle)
  g.drawImage(image, -w / 2, -w / 2, w, w)
  g.restore()
}

const easeOut = (t: number) => 1 - (1 - t) ** 3

function resize() {
  const el = canvas.value
  if (!el) return
  const width = el.clientWidth
  dpr = Math.min(window.devicePixelRatio || 1, 2.5)
  scale = width / WIDTH
  el.width = Math.round(width * dpr)
  el.height = Math.round(width * (HEIGHT / WIDTH) * dpr)
}

function toWorld(event: PointerEvent) {
  const rect = canvas.value!.getBoundingClientRect()
  return ((event.clientX - rect.left) / rect.width) * WIDTH
}
let pressed = false
function onDown(event: PointerEvent) {
  if (over.value) return
  pressed = true
  aim = toWorld(event)
  canvas.value?.setPointerCapture(event.pointerId)
}
function onMove(event: PointerEvent) {
  if (pressed || event.pointerType === 'mouse') aim = toWorld(event)
}
function onUp(event: PointerEvent) {
  if (!pressed) return
  pressed = false
  aim = toWorld(event)
  drop()
}
function onKey(event: KeyboardEvent) {
  if ((event.target as HTMLElement)?.closest('input,textarea,select')) return
  if (event.key === 'ArrowLeft' || event.key === 'a') aim = clamp(aim - 14, 0, WIDTH)
  else if (event.key === 'ArrowRight' || event.key === 'd') aim = clamp(aim + 14, 0, WIDTH)
  else if (event.key === ' ' || event.key === 'ArrowDown' || event.key === 'Enter') { if (event.key !== 'Enter' || !over.value) drop() }
  else return
  event.preventDefault()
}

onMounted(() => {
  reset()
  resize()
  observer = new ResizeObserver(resize)
  observer.observe(canvas.value!)
  window.addEventListener('keydown', onKey)
  last = performance.now()
  frame = requestAnimationFrame(tick)
})
onBeforeUnmount(() => {
  cancelAnimationFrame(frame)
  observer?.disconnect()
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div class="game">
    <div class="hud">
      <div><span>得分</span><strong>{{ score }}</strong></div>
      <div><span>最高</span><strong>{{ best }}</strong></div>
      <div class="next"><span>下一个</span><i :style="{ background: FRUITS[next].base }" />{{ FRUITS[next].name }}</div>
    </div>
    <div class="stage">
      <canvas ref="canvas" aria-label="合成大西瓜游戏区域：拖动选择位置，松开放下水果" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="pressed = false" />
      <GameOver v-if="over" title="游戏结束" :result="result" @again="reset">
        <p class="big">{{ score }}<small>分</small></p>
        <p>最大合成：{{ FRUITS[top].name }}</p>
      </GameOver>
    </div>
    <p class="tip">拖动或移动鼠标选择位置，松开放下；电脑也可用 ← → 移动、空格放下。</p>
  </div>
</template>

<style scoped>
.game { width:100%; max-width:max(280px,calc((100dvh - var(--header-h) - 200px) * 2 / 3)); margin:0 auto; }
.hud { display:flex; gap:10px; margin-bottom:12px; }
.hud div { flex:1; min-width:0; padding:8px 12px; border:1px solid var(--line); border-radius:12px; background:var(--surface); }
.hud span { display:block; color:var(--muted); font-size:12px; }
.hud strong { font:700 20px var(--font-mono); }
.next { display:flex; flex-wrap:wrap; align-items:center; gap:0 6px; font-size:14px; }
.next span { width:100%; }
.next i { width:12px; height:12px; border-radius:50%; }
.stage { position:relative; border-radius:20px; overflow:hidden; box-shadow:0 0 0 1px var(--line),0 30px 60px -40px rgba(17,24,39,.45); }
canvas { display:block; width:100%; aspect-ratio:2/3; touch-action:none; user-select:none; -webkit-user-select:none; cursor:crosshair; }
.big { font:800 48px var(--font-mono); }
.big small { margin-left:4px; font-size:16px; }
.tip { margin-top:12px; color:var(--faint); font-size:12px; text-align:center; }
</style>

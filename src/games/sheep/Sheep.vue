<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { formatDuration, localBest, submitScore } from '../api'
import { sfx } from '../sound'
import GameOver from '../GameOver.vue'
import bgUrl from './art/bg.webp'
import bgDarkUrl from './art/bg-dark.webp'
import iconsUrl from './art/icons.webp'
import uiUrl from './art/ui.webp'
import { BOARD_H, BOARD_W, PILE_H, generate, isFree, settings, shuffle } from './level'
import type { Tile } from './level'

const emit = defineEmits<{ scored: [] }>()
/** 雪碧图中某格的背景定位（cols × rows 网格） */
const cell = (index: number, cols: number, rows: number) => `${(index % cols) * 100 / (cols - 1)}% ${Math.floor(index / cols) * 100 / (rows - 1)}%`
const icon = (type: number) => ({ backgroundPosition: cell(type, 4, 4) })
const art = { '--icons': `url(${iconsUrl})`, '--ui': `url(${uiUrl})`, '--bg': `url(${bgUrl})`, '--bg-dark': `url(${bgDarkUrl})` }
const SLOTS = 7

const board = ref<HTMLDivElement>()
const unit = ref(48)
const level = ref(1)
const tiles = ref<Tile[]>([])
const slot = ref<Tile[]>([])
const outside = ref<Tile[]>([])
const clearing = ref(new Set<number>())
const used = ref({ undo: false, out: false, shuffle: false })
const phase = ref<'play' | 'win' | 'lose'>('play')
const elapsed = ref(0)
const best = ref(localBest('sheep'))
const result = ref<{ improved: boolean; synced: boolean; error?: string }>()
let lastMove: { tile: Tile; from: 'board' | 'outside' } | undefined
let timer: ReturnType<typeof setInterval> | undefined
let observer: ResizeObserver | undefined

const hasPile = computed(() => settings(level.value).pile > 0)
const free = computed(() => new Set(tiles.value.filter(t => isFree(t, tiles.value)).map(t => t.id)))
const remaining = computed(() => tiles.value.length + outside.value.length + slot.value.length)

function start(next: number) {
  level.value = next
  tiles.value = generate(next)
  slot.value = []; outside.value = []
  clearing.value = new Set()
  used.value = { undo: false, out: false, shuffle: false }
  lastMove = undefined
  phase.value = 'play'
  if (next === 1) { elapsed.value = 0; result.value = undefined }
}

function pick(tile: Tile, from: 'board' | 'outside') {
  if (phase.value !== 'play' || slot.value.length >= SLOTS) return
  if (from === 'board') {
    if (!free.value.has(tile.id)) return
    tiles.value = tiles.value.filter(t => t !== tile)
  } else outside.value = outside.value.filter(t => t !== tile)
  // 放到同类卡片后面，方便看出差几张
  const at = slot.value.map(t => t.type).lastIndexOf(tile.type)
  slot.value.splice(at < 0 ? slot.value.length : at + 1, 0, tile)
  lastMove = { tile, from }
  sfx.tap()
  const same = slot.value.filter(t => t.type === tile.type && !clearing.value.has(t.id))
  if (same.length >= 3) {
    lastMove = undefined
    same.slice(0, 3).forEach(t => clearing.value.add(t.id))
    setTimeout(() => {
      slot.value = slot.value.filter(t => !clearing.value.has(t.id))
      clearing.value = new Set()
      sfx.clear()
      if (!remaining.value) win()
    }, 220)
  } else if (slot.value.length >= SLOTS) lose()
}

function win() {
  phase.value = 'win'
  sfx.win()
}

async function lose() {
  phase.value = 'lose'
  sfx.lose()
  result.value = undefined
  result.value = await submitScore('sheep', level.value - 1, elapsed.value)
  best.value = localBest('sheep')
  emit('scored')
}

function undo() {
  if (!lastMove || used.value.undo || phase.value !== 'play') return
  const { tile, from } = lastMove
  slot.value = slot.value.filter(t => t !== tile)
  if (from === 'board') tiles.value.push(tile)
  else outside.value.push(tile)
  lastMove = undefined
  used.value.undo = true
}

function moveOut() {
  if (used.value.out || slot.value.length === 0 || phase.value !== 'play' || clearing.value.size) return
  outside.value.push(...slot.value.splice(0, 3))
  lastMove = undefined
  used.value.out = true
}

function reshuffle() {
  if (used.value.shuffle || phase.value !== 'play') return
  const types = shuffle(tiles.value.map(t => t.type))
  tiles.value = tiles.value.map((t, i) => ({ ...t, type: types[i] }))
  lastMove = undefined
  used.value.shuffle = true
}

function restart() {
  if (phase.value === 'play' && level.value > 1 && !confirm('放弃当前进度并结算成绩？')) return
  if (phase.value === 'play' && level.value > 1) { lose(); return }
  start(1)
}

const boardHeight = computed(() => (BOARD_H + (hasPile.value ? PILE_H : 0)) * unit.value)

function resize() {
  const width = board.value?.clientWidth ?? 0
  // 同时受宽度和视口高度限制，保证手机上一屏放得下
  const byHeight = (window.innerHeight - 300) / (BOARD_H + PILE_H + 2.6)
  unit.value = Math.max(30, Math.min(width / BOARD_W, byHeight, 64))
}

onMounted(() => {
  start(1)
  resize()
  observer = new ResizeObserver(resize)
  observer.observe(board.value!)
  timer = setInterval(() => { if (phase.value === 'play' && !document.hidden) elapsed.value++ }, 1000)
})
onBeforeUnmount(() => { clearInterval(timer); observer?.disconnect() })
</script>

<template>
  <div class="game" :style="{ '--u': `${unit}px`, ...art }">
    <div class="hud">
      <div><span>关卡</span><strong>{{ level }}</strong></div>
      <div><span>用时</span><strong>{{ formatDuration(elapsed) }}</strong></div>
      <div><span>剩余</span><strong>{{ remaining }}</strong></div>
      <div><span>最佳</span><strong>{{ best ? `${best.best} 关` : '—' }}</strong></div>
    </div>
    <div class="table">
      <div ref="board" class="board-wrap">
        <div class="board" :style="{ width: `${BOARD_W * unit}px`, height: `${boardHeight}px` }">
          <button
            v-for="tile in tiles" :key="tile.id" type="button" class="tile"
            :class="{ blocked: !free.has(tile.id) }"
            :style="{ left: `${tile.x * unit}px`, top: `${tile.y * unit}px`, zIndex: tile.layer + 1 }"
            :aria-label="free.has(tile.id) ? '可点击的卡片' : '被压住的卡片'"
            :tabindex="free.has(tile.id) ? 0 : -1"
            @click="pick(tile, 'board')"
          ><i class="face" :style="icon(tile.type)" aria-hidden="true" /></button>
        </div>
      </div>
      <div class="outside" :class="{ empty: !outside.length }">
        <button v-for="tile in outside" :key="tile.id" type="button" class="tile flat" aria-label="移出的卡片" @click="pick(tile, 'outside')"><i class="face" :style="icon(tile.type)" aria-hidden="true" /></button>
      </div>
      <div class="slot" :class="{ full: slot.length >= SLOTS - 1 }">
        <span v-for="i in SLOTS" :key="i" class="cell" />
        <TransitionGroup name="slot" tag="div" class="slot-tiles">
          <div v-for="tile in slot" :key="tile.id" class="tile flat" :class="{ clearing: clearing.has(tile.id) }"><i class="face" :style="icon(tile.type)" aria-hidden="true" /></div>
        </TransitionGroup>
      </div>
      <div class="tools">
        <button type="button" :disabled="used.out || !slot.length" @click="moveOut"><b :style="{ backgroundPosition: cell(4, 4, 2) }" />移出 3 张</button>
        <button type="button" :disabled="used.undo || !lastMove" @click="undo"><b :style="{ backgroundPosition: cell(5, 4, 2) }" />撤回</button>
        <button type="button" :disabled="used.shuffle" @click="reshuffle"><b :style="{ backgroundPosition: cell(6, 4, 2) }" />洗牌</button>
        <button type="button" @click="restart"><b :style="{ backgroundPosition: cell(7, 4, 2) }" />重开</button>
      </div>
      <GameOver v-if="phase === 'lose'" title="槽位满了" :result="result" @again="start(1)">
        <p class="big">{{ level - 1 }}<small>关</small></p>
        <p>本局用时 {{ formatDuration(elapsed) }}</p>
      </GameOver>
      <div v-else-if="phase === 'win'" class="win" role="dialog" aria-label="过关">
        <div class="win-card">
          <p class="win-title">第 {{ level }} 关通过！</p>
          <p>已用时 {{ formatDuration(elapsed) }}，道具每关免费各一次。</p>
          <button type="button" @click="start(level + 1)">进入第 {{ level + 1 }} 关</button>
        </div>
      </div>
    </div>
    <p class="tip">点击没有被压住的卡片放进槽位，凑齐 3 张相同的消除；槽位放满 7 张就失败。</p>
  </div>
</template>

<style scoped>
.game { width:100%; }
.hud { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin-bottom:12px; }
.hud div { min-width:0; padding:8px 10px; border:1px solid var(--line); border-radius:12px; background:var(--surface); }
.hud span { display:block; color:var(--muted); font-size:12px; }
.hud strong { font:700 16px var(--font-mono); white-space:nowrap; }
.table { position:relative; padding:16px 12px 14px; border-radius:20px; background:var(--bg) center/cover, linear-gradient(180deg,#d9f2c4,#b8e39b); box-shadow:0 0 0 1px var(--line),0 30px 60px -40px rgba(17,24,39,.45); overflow:hidden; user-select:none; -webkit-user-select:none; }
:root[data-theme='dark'] .table { background:var(--bg-dark) center/cover, linear-gradient(180deg,#1f3322,#18281b); }
.board-wrap { display:flex; justify-content:center; }
.board { position:relative; }
/* 卡片底座与图案都来自手绘雪碧图：ui 第 1 格是亮面卡片，第 2 格是被压住时的灰色卡片 */
.tile { position:absolute; display:grid; place-items:center; width:calc(var(--u) * .98); height:calc(var(--u) * .98); padding:calc(var(--u) * .14) calc(var(--u) * .14) calc(var(--u) * .22); border:0; border-radius:calc(var(--u) * .18); background:var(--ui) 0 0 / 400% 200% no-repeat; filter:drop-shadow(0 calc(var(--u) * .06) calc(var(--u) * .06) rgba(0,0,0,.22)); cursor:pointer; transition:filter .25s,transform .15s; -webkit-tap-highlight-color:transparent; }
.face { width:100%; height:100%; background:var(--icons) 0 0 / 400% 400% no-repeat; }
.tile:not(.blocked):hover { transform:translateY(-2px); }
.tile:not(.blocked):active { transform:scale(.94); }
.tile.blocked { background-position:33.333% 0; cursor:default; }
.tile.blocked .face { filter:brightness(.55) saturate(.5); }
.tile:focus-visible { outline:3px solid var(--accent); outline-offset:2px; }
.tile.flat { position:relative; }
.outside { display:flex; justify-content:center; gap:4px; min-height:calc(var(--u) * 1.1); margin-top:10px; }
.outside.empty { min-height:0; margin-top:0; }
.slot { position:relative; display:grid; grid-template-columns:repeat(7,var(--u)); gap:0; justify-content:center; width:fit-content; margin:12px auto 0; padding:calc(var(--u) * .14); border:calc(var(--u) * .1) solid #b9773b; border-radius:calc(var(--u) * .3); background:linear-gradient(180deg,#5a3517,#7a4a22); box-shadow:inset 0 3px 8px rgba(0,0,0,.45),0 0 0 2px #6b3d17,0 6px 14px -6px rgba(0,0,0,.5); transition:box-shadow .3s; }
.slot.full { box-shadow:inset 0 3px 8px rgba(0,0,0,.45),0 0 0 3px #e8344e; }
.cell { height:var(--u); margin:0 1px; border-radius:calc(var(--u) * .16); background:rgba(255,255,255,.1); }
.slot-tiles { position:absolute; inset:calc(var(--u) * .14); display:flex; }
.slot-tiles .tile { margin:0 calc(var(--u) * .02); cursor:default; }
.slot-tiles .tile.clearing { transform:scale(0); opacity:0; transition:transform .22s var(--ease),opacity .22s; }
.slot-enter-active { transition:transform .25s var(--ease),opacity .25s; }
.slot-enter-from { transform:translateY(calc(var(--u) * -.8)) scale(1.15); opacity:0; }
.slot-move { transition:transform .2s var(--ease); }
.tools { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin-top:14px; }
.tools button { display:flex; flex-direction:column; align-items:center; gap:2px; padding:8px 4px; border:0; border-radius:12px; background:rgba(255,253,240,.85); box-shadow:0 3px 0 rgba(90,130,60,.35); color:#2f4a24; font:500 12px var(--font); cursor:pointer; }
:root[data-theme='dark'] .tools button { background:rgba(255,255,255,.08); color:#cfe8c0; }
.tools b { width:30px; height:30px; background:var(--ui) 0 0 / 400% 200% no-repeat; }
.tools button:disabled { opacity:.4; cursor:default; }
.big { font:800 48px var(--font-mono); }
.big small { margin-left:4px; font-size:16px; }
.win { position:absolute; inset:0; z-index:200; display:grid; place-items:center; padding:20px; background:rgba(12,13,16,.35); backdrop-filter:blur(3px); }
.win-card { width:min(100%,300px); padding:26px 22px; border-radius:18px; background:var(--surface); text-align:center; }
.win-title { font-size:22px; font-weight:800; }
.win-card p:not(.win-title) { margin-top:8px; color:var(--muted); font-size:13px; }
.win-card button { width:100%; margin-top:18px; padding:12px; border:0; border-radius:10px; background:var(--btn-bg); color:var(--btn-fg); font:500 15px var(--font); cursor:pointer; }
.tip { margin-top:12px; color:var(--faint); font-size:12px; text-align:center; }
</style>

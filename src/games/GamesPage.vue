<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { account } from '../account'
import { vReveal } from '../composables/useReveal'
import PageHeading from '../components/PageHeading.vue'
import { formatDuration, games, loadMine, localBest } from './api'
import type { GameBest, GameId } from './api'
import Leaderboard from './Leaderboard.vue'
import { muted, toggleMute } from './sound'
import Sheep from './sheep/Sheep.vue'
import { ICONS } from './sheep/icons'
import Watermelon from './watermelon/Watermelon.vue'

const id = location.pathname.replace(/\/$/, '').split('/')[2] as GameId | undefined
const game = games.find(g => g.id === id)
const refresh = ref(0)
const mine = ref<Partial<Record<GameId, GameBest | null>>>({})

const bests = computed(() => Object.fromEntries(games.map(g => {
  const remote = mine.value[g.id], local = localBest(g.id)
  return [g.id, remote && (!local || remote.best >= local.best) ? remote : local]
})) as Record<GameId, GameBest | null>)

async function loadBests() {
  if (account.value) mine.value = await loadMine().catch(() => ({}))
}
watch(() => account.value?.id, loadBests)
onMounted(() => {
  document.title = `${game ? game.name : 'Games'} · Copy Lee`
  loadBests()
})
</script>

<template>
  <section class="games-page">
    <template v-if="game">
      <div class="container play">
        <div class="bar">
          <a href="/games" class="back">← 全部游戏</a>
          <h1>{{ game.name }}</h1>
          <button type="button" class="mute" :aria-label="muted ? '打开音效' : '关闭音效'" :aria-pressed="!muted" @click="toggleMute">{{ muted ? '🔇' : '🔊' }}</button>
        </div>
        <div class="layout">
          <div class="stage-col">
            <Watermelon v-if="game.id === 'watermelon'" @scored="refresh++" />
            <Sheep v-else @scored="refresh++" />
          </div>
          <Leaderboard :game="game.id" :unit="game.unit" :refresh="refresh" />
        </div>
      </div>
    </template>
    <template v-else>
      <PageHeading title="Games" label="Just for fun">
        随手玩两局，放松一下。
        <span>全部免费，没有广告和内购。登录后成绩会同步，还能上排行榜。</span>
      </PageHeading>
      <div class="container">
        <div class="cards">
          <a v-for="(g, i) in games" :key="g.id" v-reveal="i * 90" class="card" :href="`/games/${g.id}`">
            <div class="art" :class="g.id" aria-hidden="true">
              <svg v-if="g.id === 'watermelon'" viewBox="0 0 200 120">
                <circle cx="100" cy="74" r="44" fill="#3fae49" /><path d="M78 36q-8 38 0 76M100 30v88M122 36q8 38 0 76" stroke="#1d6f2a" stroke-width="8" fill="none" />
                <circle cx="44" cy="96" r="20" fill="#ff9a1f" /><circle cx="158" cy="100" r="16" fill="#e8344e" /><circle cx="150" cy="62" r="11" fill="#8e5bd6" /><circle cx="52" cy="58" r="13" fill="#ffe14d" />
                <circle cx="88" cy="70" r="4" fill="#2b1d14" /><circle cx="112" cy="70" r="4" fill="#2b1d14" /><path d="M92 82q8 7 16 0" stroke="#2b1d14" stroke-width="3" fill="none" stroke-linecap="round" />
              </svg>
              <div v-else class="stack">
                <svg v-for="(n, k) in [15, 0, 5, 7, 2]" :key="k" viewBox="0 0 48 48" :style="{ '--k': k }" v-html="ICONS[n]" />
              </div>
            </div>
            <div class="info">
              <p class="label">{{ g.title }}</p>
              <h2>{{ g.name }}</h2>
              <p class="text">{{ g.text }}</p>
              <p class="best">
                <template v-if="bests[g.id]">我的最佳 <strong>{{ bests[g.id]!.best }} {{ g.unit }}</strong><span v-if="g.id === 'sheep' && bests[g.id]!.best"> · {{ formatDuration(bests[g.id]!.detail) }}</span> · {{ bests[g.id]!.plays }} 局</template>
                <template v-else>还没玩过</template>
                <span class="go">开始游戏 ↗</span>
              </p>
            </div>
          </a>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.games-page { min-height:80vh; padding-bottom:72px; }
.cards { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:20px; }
.card { display:flex; flex-direction:column; border:1px solid var(--line); border-radius:var(--radius); background:var(--surface); overflow:hidden; transition:transform .4s var(--ease),box-shadow .4s,border-color .3s; }
.card:hover { transform:translateY(-4px); border-color:var(--line-strong); box-shadow:0 30px 60px -40px rgba(17,24,39,.45); }
.art { display:grid; place-items:center; height:200px; }
.art.watermelon { background:linear-gradient(180deg,#fff6e3,#ffe2b8); }
.art.sheep { background:linear-gradient(180deg,#d9f2c4,#b8e39b); }
:root[data-theme='dark'] .art.watermelon { background:linear-gradient(180deg,#1d2233,#2a2620); }
:root[data-theme='dark'] .art.sheep { background:linear-gradient(180deg,#1f3322,#18281b); }
.art > svg { width:min(80%,280px); transition:transform .5s var(--ease); }
.card:hover .art > svg { transform:scale(1.05) rotate(-2deg); }
.stack { position:relative; width:220px; height:120px; }
.stack svg { position:absolute; left:calc(var(--k) * 34px + 8px); top:calc(30px + (var(--k) - 2) * (var(--k) - 2) * 6px); width:56px; height:56px; padding:8px; border-radius:12px; background:#fffdf5; box-shadow:0 5px 0 #a9c48f,0 8px 14px rgba(0,0,0,.15); transform:rotate(calc((var(--k) - 2) * 6deg)); transition:transform .4s var(--ease); }
.card:hover .stack svg { transform:translateY(-6px) rotate(calc((var(--k) - 2) * 8deg)); }
.info { padding:22px 24px 24px; }
.info h2 { margin-top:6px; font-size:24px; }
.text { margin-top:8px; color:var(--muted); font-size:14px; line-height:1.7; }
.best { display:flex; flex-wrap:wrap; align-items:center; gap:4px; margin-top:18px; color:var(--text-2); font-size:13px; }
.best strong { color:var(--accent); }
.go { margin-left:auto; color:var(--accent); font-weight:500; }
.play { padding-top:calc(var(--header-h) + 20px); }
.bar { display:flex; align-items:center; gap:12px; margin-bottom:16px; }
.bar h1 { flex:1; font-size:clamp(20px,4vw,28px); font-weight:800; }
.back { color:var(--muted); font-size:14px; white-space:nowrap; }
.back:hover { color:var(--accent); }
.mute { width:40px; height:40px; border:1px solid var(--line); border-radius:10px; background:var(--surface); cursor:pointer; font-size:17px; }
.layout { display:grid; grid-template-columns:minmax(0,480px) minmax(260px,340px); justify-content:center; gap:28px; align-items:start; }
.stage-col { min-width:0; }
@media (max-width: 860px) {
  .layout { grid-template-columns:minmax(0,1fr); }
  .stage-col { width:100%; max-width:480px; margin:0 auto; }
  .cards { grid-template-columns:1fr; }
}
@media (max-width: 520px) {
  .play { padding-top:calc(var(--header-h) + 12px); padding-left:12px; padding-right:12px; }
  .bar { margin-bottom:10px; }
}
</style>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { account } from '../account'
import { vReveal } from '../composables/useReveal'
import PageHeading from '../components/PageHeading.vue'
import { formatDuration, games, loadMine, localBest } from './api'
import type { GameBest, GameId } from './api'
import HealthNotice from './HealthNotice.vue'
import Leaderboard from './Leaderboard.vue'
import { muted, toggleMute } from './sound'
import Sheep from './sheep/Sheep.vue'
import Watermelon from './watermelon/Watermelon.vue'
import Dungeon from './dungeon/Dungeon.vue'
import { heroUrl } from './dungeon/sprites'
import sheepCover from './covers/sheep.webp'
import watermelonCover from './covers/watermelon.webp'

const covers: Record<GameId, string> = { dungeon: heroUrl, watermelon: watermelonCover, sheep: sheepCover }

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
        <div class="layout" :class="{ wide: game.id === 'dungeon' }">
          <div class="stage-col">
            <Watermelon v-if="game.id === 'watermelon'" @scored="refresh++" />
            <Sheep v-else-if="game.id === 'sheep'" @scored="refresh++" />
            <Dungeon v-else @scored="refresh++" />
          </div>
          <Leaderboard :game="game.id" :unit="game.unit" :refresh="refresh" />
        </div>
        <HealthNotice />
      </div>
    </template>
    <template v-else>
      <PageHeading title="Games" label="Just for fun">
        随手玩两局，放松一下。
        <span>全部免费，没有广告和内购。登录后成绩会同步，还能上排行榜。</span>
      </PageHeading>
      <div class="container">
        <div class="cards">
          <a v-for="(g, i) in games" :key="g.id" v-reveal="i * 90" class="card" :class="{ feature: i === 0 }" :href="`/games/${g.id}`">
            <div class="art" :class="g.id" aria-hidden="true">
              <img class="cover" :src="covers[g.id]" alt="" :loading="i ? 'lazy' : 'eager'">
            </div>
            <div class="info">
              <p class="label">{{ g.title }}</p>
              <h2>{{ g.name }}</h2>
              <p class="text">{{ g.text }}</p>
              <p class="best">
                <template v-if="bests[g.id]">我的最佳 <strong>{{ bests[g.id]!.best }} {{ g.unit }}</strong><span v-if="g.id === 'sheep' && bests[g.id]!.best"> · {{ formatDuration(bests[g.id]!.detail) }}</span><span v-if="g.id === 'dungeon'"> · 第 {{ bests[g.id]!.detail }} 层</span> · {{ bests[g.id]!.plays }} 局</template>
                <template v-else>还没玩过</template>
                <span class="go">开始游戏 ↗</span>
              </p>
            </div>
          </a>
        </div>
        <HealthNotice />
      </div>
    </template>
  </section>
</template>

<style scoped>
.games-page { min-height:80vh; padding-bottom:72px; }
.cards { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:20px; }
.card { display:flex; flex-direction:column; border:1px solid var(--line); border-radius:var(--radius); background:var(--surface); overflow:hidden; transition:transform .4s var(--ease),box-shadow .4s,border-color .3s; }
.card:hover { transform:translateY(-4px); border-color:var(--line-strong); box-shadow:0 30px 60px -40px rgba(17,24,39,.45); }
.art { position:relative; flex:none; aspect-ratio:16/9; overflow:hidden; background:#0b0c12; }
.art .cover { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; transition:transform .6s var(--ease); }
.art.sheep .cover { object-position:50% 30%; }
.card:hover .art .cover { transform:scale(1.04); }
/* 首推的深渊骑士：横跨两列，封面完整显示在左侧 */
.card.feature { grid-column:1 / -1; display:grid; grid-template-columns:minmax(0,1.5fr) minmax(0,1fr); }
.card.feature .art { aspect-ratio:16/9; height:100%; }
.card.feature .cover { object-position:30% 40%; }
.card.feature .info { display:flex; flex-direction:column; justify-content:center; padding:32px 34px; }
.card.feature h2 { font-size:30px; }
.card.feature .text { font-size:15px; }
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
.layout.wide { grid-template-columns:minmax(0,1fr); max-width:1100px; margin:0 auto; }
.layout.wide aside { width:100%; }
@media (max-width: 860px) {
  .layout { grid-template-columns:minmax(0,1fr); }
  .stage-col { width:100%; max-width:480px; margin:0 auto; }
  .cards { grid-template-columns:1fr; }
  .card.feature { display:flex; }
  .card.feature .art { height:auto; }
  .card.feature .info { padding:22px 24px 24px; }
  .card.feature h2 { font-size:24px; }
}
@media (max-width: 520px) {
  .play { padding-top:calc(var(--header-h) + 12px); padding-left:12px; padding-right:12px; }
  .bar { margin-bottom:10px; }
}
</style>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { account } from '../account'
import { formatDuration, loadBoard } from './api'
import type { Board, GameId } from './api'

const props = defineProps<{ game: GameId; unit: string; refresh?: number }>()
const board = ref<Board>()
const error = ref('')
const login = `/account?next=${encodeURIComponent(location.pathname)}`

async function load() {
  try { board.value = await loadBoard(props.game); error.value = '' }
  catch { error.value = '排行榜暂时无法加载' }
}
onMounted(load)
watch(() => [props.refresh, account.value?.id], load)
</script>

<template>
  <aside class="board" aria-label="排行榜">
    <div class="head"><h2>排行榜</h2><button type="button" aria-label="刷新排行榜" @click="load">↻</button></div>
    <p v-if="board?.me" class="me">我的最佳 <strong>{{ board.me.best }} {{ unit }}</strong><span>第 {{ board.me.rank }} 名 · 共 {{ board.me.plays }} 局</span></p>
    <p v-else-if="!account" class="me muted"><a :href="login">登录</a>后成绩会同步到账户并参与排名</p>
    <p v-if="error" class="muted">{{ error }}</p>
    <ol v-else-if="board?.items.length">
      <li v-for="row in board.items" :key="row.rank" :class="{ podium: row.rank <= 3 }">
        <span class="rank">{{ row.rank }}</span>
        <img v-if="row.avatar" :src="row.avatar" alt="" loading="lazy">
        <span v-else class="initial" aria-hidden="true">{{ row.name.slice(0, 1).toUpperCase() }}</span>
        <span class="name">{{ row.name }}</span>
        <span class="score">{{ row.best }}<small>{{ unit }}</small><em v-if="game === 'sheep'">{{ formatDuration(row.detail) }}</em></span>
      </li>
    </ol>
    <p v-else-if="board" class="muted">还没有人上榜，来当第一个吧。</p>
  </aside>
</template>

<style scoped>
.board { padding:20px; border:1px solid var(--line); border-radius:var(--radius); background:var(--surface); }
.head { display:flex; align-items:center; justify-content:space-between; }
h2 { font-size:18px; }
.head button { width:32px; height:32px; border:0; border-radius:8px; background:none; color:var(--muted); font-size:18px; cursor:pointer; }
.head button:hover { background:var(--accent-soft); color:var(--accent); }
.me { margin-top:12px; padding:12px 14px; border-radius:12px; background:var(--accent-soft); font-size:13px; }
.me strong { margin:0 8px 0 4px; color:var(--accent); }
.me span { color:var(--muted); }
.me a { color:var(--accent); }
.muted { margin-top:12px; color:var(--muted); font-size:13px; }
.me.muted { background:var(--bg-tint); }
ol { list-style:none; margin:12px 0 0; padding:0; max-height:520px; overflow:auto; }
li { display:grid; grid-template-columns:28px 28px 1fr auto; align-items:center; gap:10px; padding:9px 2px; border-bottom:1px solid var(--line); }
li:last-child { border-bottom:0; }
.rank { color:var(--faint); font:600 13px var(--font-mono); text-align:center; }
.podium .rank { color:#fff; border-radius:50%; line-height:24px; background:#c9a227; }
.podium:nth-child(2) .rank { background:#9aa3ad; }
.podium:nth-child(3) .rank { background:#c07a43; }
img,.initial { width:28px; height:28px; border-radius:50%; object-fit:cover; }
.initial { display:grid; place-items:center; background:linear-gradient(135deg,var(--accent),#7ea2ff); color:#fff; font-size:13px; font-weight:700; }
.name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:14px; }
.score { font:700 14px var(--font-mono); text-align:right; }
.score small { margin-left:2px; color:var(--muted); font-weight:400; }
.score em { display:block; color:var(--faint); font:400 11px var(--font-mono); font-style:normal; }
</style>

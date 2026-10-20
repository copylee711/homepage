<script setup lang="ts">
import { contentStatus, reloadContent } from '../content'
import HeroMark from './HeroMark.vue'
</script>

<template>
  <main class="boot" :class="{ failed: !contentStatus.loading }" aria-live="polite">
    <div class="grid" aria-hidden="true" />
    <div class="beam" aria-hidden="true" />
    <div class="center">
      <div class="mark-wrap" aria-hidden="true">
        <HeroMark class="mark" />
        <span class="node node-a" /><span class="node node-b" />
      </div>
      <p class="label">Copy Lee</p>
      <template v-if="contentStatus.loading">
        <h1 class="status">正在加载内容<span class="dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span></h1>
        <div class="bar" role="progressbar" aria-label="加载进度"><span /></div>
      </template>
      <template v-else>
        <h1 class="status">内容暂时不可用</h1>
        <p v-if="contentStatus.error" class="error">{{ contentStatus.error }}</p>
        <button class="retry" type="button" @click="reloadContent">重新加载<span aria-hidden="true">↻</span></button>
      </template>
    </div>
  </main>
</template>

<style scoped>
.boot { position:fixed; inset:0; z-index:20; display:grid; place-items:center; overflow:hidden; background:radial-gradient(120% 90% at 70% 10%,var(--bg-tint),var(--bg) 60%); }
/* 细网格以中心为焦点呼吸 */
.grid { position:absolute; inset:-48px; background-image:linear-gradient(var(--grid-line) 1px,transparent 1px),linear-gradient(90deg,var(--grid-line) 1px,transparent 1px); background-size:48px 48px; mask-image:radial-gradient(circle at 50% 46%,#000 0,transparent 62%); animation:grid-breathe 4s ease-in-out infinite; }
@keyframes grid-breathe { 50% { opacity:.55; transform:scale(1.02); } }
/* 一道斜向光束缓慢扫过 */
.beam { position:absolute; inset:-50%; background:linear-gradient(105deg,transparent 42%,var(--accent-soft) 50%,transparent 58%); animation:beam 3.2s cubic-bezier(.65,0,.2,1) infinite; }
@keyframes beam { from { transform:translateX(-40%); } to { transform:translateX(40%); } }
.center { position:relative; display:flex; flex-direction:column; align-items:center; text-align:center; padding:24px; }
.mark-wrap { position:relative; width:112px; margin-bottom:28px; color:var(--text); }
.mark { display:block; width:100%; height:auto; filter:drop-shadow(0 18px 30px rgba(59,110,245,.18)); }
.node { position:absolute; width:8px; height:8px; border-radius:2px; background:var(--accent); box-shadow:0 0 0 5px var(--accent-soft); animation:pop .6s var(--ease) backwards,pulse 2.4s ease-in-out infinite; }
.node-a { top:-14px; right:-18px; animation-delay:1.4s,2s; }
.node-b { bottom:-6px; left:-22px; opacity:.45; animation-delay:1.6s,2.8s; }
@keyframes pop { from { opacity:0; transform:scale(0); } }
@keyframes pulse { 50% { box-shadow:0 0 0 11px transparent; } }
.label { color:var(--faint); font-size:12px; font-weight:500; letter-spacing:.32em; text-transform:uppercase; animation:rise .8s var(--ease) .3s backwards; }
.status { margin:14px 0 0; font-size:clamp(1.25rem,4vw,1.6rem); font-weight:600; letter-spacing:-.01em; animation:rise .8s var(--ease) .45s backwards; }
@keyframes rise { from { opacity:0; transform:translateY(12px); } }
.dots i { display:inline-block; font-style:normal; animation:dot 1.4s ease-in-out infinite; }
.dots i:nth-child(2) { animation-delay:.18s; }
.dots i:nth-child(3) { animation-delay:.36s; }
@keyframes dot { 0%,60%,100% { opacity:.25; transform:none; } 30% { opacity:1; transform:translateY(-3px); } }
.bar { position:relative; width:min(220px,60vw); height:2px; margin-top:24px; overflow:hidden; border-radius:2px; background:var(--line); animation:rise .8s var(--ease) .6s backwards; }
.bar span { position:absolute; inset:0 auto 0 0; width:40%; border-radius:inherit; background:linear-gradient(90deg,transparent,var(--accent)); animation:slide 1.3s cubic-bezier(.65,0,.35,1) infinite; }
@keyframes slide { from { transform:translateX(-100%); } to { transform:translateX(260%); } }
.error { max-width:420px; margin-top:12px; color:var(--muted); font-size:14px; }
.retry { display:inline-flex; align-items:center; gap:10px; margin-top:28px; padding:12px 24px; border:0; border-radius:10px; background:var(--btn-bg); color:var(--btn-fg); font:500 15px var(--font); cursor:pointer; box-shadow:0 8px 22px -10px rgba(17,24,39,.4); transition:transform .3s var(--ease),box-shadow .3s; }
.retry:hover { transform:translateY(-2px); box-shadow:0 14px 28px -12px rgba(17,24,39,.5); }
.retry span { display:inline-block; transition:transform .5s var(--ease); }
.retry:hover span { transform:rotate(180deg); }
.failed .beam { animation-play-state:paused; opacity:0; transition:opacity .6s; }
@media (prefers-reduced-motion: reduce) { .beam { display:none; } }
</style>

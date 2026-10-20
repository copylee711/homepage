<script setup lang="ts">
import { computed } from 'vue'
import { notes } from '../content'
import { vReveal } from '../composables/useReveal'

// 首页展示最近更新的 6 篇，完整列表在 /notes。
const recent = computed(() => [...notes.value].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 6))

function onPointerMove(e: PointerEvent) {
  const card = (e.target as HTMLElement).closest('a')
  if (!card) return
  const rect = card.getBoundingClientRect()
  card.style.setProperty('--mx', `${e.clientX - rect.left}px`)
  card.style.setProperty('--my', `${e.clientY - rect.top}px`)
}
</script>

<template>
  <section v-if="notes.length" id="notes" class="section">
    <div class="container">
      <div v-reveal class="heading">
        <h2 class="section-title">Notes<sup class="count">{{ notes.length }}</sup></h2>
        <a href="/notes">所有笔记 <span aria-hidden="true">↗</span></a>
      </div>
      <div class="grid" @pointermove="onPointerMove">
        <a v-for="(note, i) in recent" :key="note.slug" v-reveal="i * 70" class="card" :href="`/notes/${note.slug}`">
          <span class="meta"><span>{{ note.category || 'General' }}</span><time :datetime="note.updated_at">{{ note.updated_at.slice(0, 10) }}</time></span>
          <strong>{{ note.title }}</strong>
          <p v-if="note.summary">{{ note.summary }}</p>
        </a>
      </div>
    </div>
  </section>
</template>

<style scoped>
.heading { display:flex; justify-content:space-between; align-items:baseline; gap:16px; }
.heading>a { color:var(--muted); font-size:14px; transition:color .3s; }
.heading>a:hover { color:var(--accent); }
.count { margin-left:8px; color:var(--faint); font-size:14px; font-weight:500; }
.grid { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; }
.card { position:relative; isolation:isolate; overflow:hidden; display:flex; flex-direction:column; gap:10px; min-height:150px; padding:22px; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--surface); transition:border-color .3s,translate .4s var(--ease),box-shadow .4s; }
.card::before { content:''; position:absolute; inset:0; z-index:-1; background-image:linear-gradient(var(--grid-line) 1px,transparent 1px),linear-gradient(90deg,var(--grid-line) 1px,transparent 1px); background-size:28px 28px; mask-image:radial-gradient(180px circle at var(--mx,50%) var(--my,50%),#000,transparent); opacity:0; pointer-events:none; transition:opacity .4s; }
.card::after { content:''; position:absolute; inset:auto 22px 0; height:2px; border-radius:2px; background:var(--accent); transform:scaleX(0); transform-origin:left; transition:transform .5s var(--ease); }
.card:hover { border-color:var(--line-strong); translate:0 -3px; box-shadow:0 14px 28px -20px #0004; }
.card:hover::before { opacity:1; }
.card:hover::after { transform:scaleX(1); }
.meta { display:flex; justify-content:space-between; gap:12px; color:var(--faint); font:12px var(--font-mono); }
.meta>span:first-child { color:var(--accent); }
strong { font-size:17px; font-weight:600; line-height:1.4; overflow-wrap:anywhere; transition:color .3s; }
.card:hover strong { color:var(--accent); }
p { color:var(--muted); font-size:13px; line-height:1.7; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
@media(max-width:900px) { .grid { grid-template-columns:repeat(2,1fr); } }
@media(max-width:560px) { .grid { grid-template-columns:1fr; } .card { min-height:0; } }
</style>

<script setup lang="ts">
import { posts } from '../content'
import { vReveal } from '../composables/useReveal'
</script>
<template>
  <section class="section" id="articles"><div class="container">
    <div class="heading"><h2 v-reveal class="section-title">Articles</h2><a href="/posts">所有文章 ↗</a></div>
    <ul class="rows"><li v-for="post in posts.slice(0, 3)" :key="post.slug" v-reveal>
      <a class="row article" :href="`/posts/${post.slug}`"><time>{{ post.published_at.slice(0,10) }}</time><span><strong>{{ post.title }}</strong><p>{{ post.summary }}</p></span><span class="arrow">↗</span></a>
    </li></ul>
    <p v-if="!posts.length" class="empty">一些想法，一些记录。文章正在路上。</p>
  </div></section>
</template>
<style scoped>
.heading { display:flex; justify-content:space-between; align-items:baseline; }
.heading>a { color:var(--muted); font-size:14px; }
.article { align-items:center; }
.article time { width:120px; flex:none; color:var(--faint); font:13px var(--font-mono); }
.article>span:nth-child(2) { flex:1; }
.article strong { font-size:19px; font-weight:500; }
.article p { color:var(--muted); font-size:14px; margin-top:6px; }
.arrow { color:var(--accent); }
.empty { color:var(--muted); padding:24px 0; }
@media(max-width:600px) { .article { flex-wrap:wrap; } .article time { width:100%; } }
</style>

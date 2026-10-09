<script setup lang="ts">
import { vReveal } from '../composables/useReveal'
import data from '../data/repos.json'
import { languageColor } from '../languages'
import { site } from '../site.config'
import type { Repo } from '../types'
import RepoCard from './RepoCard.vue'

const repos = (data as Repo[])
  .filter((r) => !site.hiddenRepos.includes(r.name))
  .sort((a, b) => b.stars - a.stars || b.pushedAt.localeCompare(a.pushedAt))

const inGroup = (r: Repo, prefix: string) => r.name.startsWith(prefix)

const groups = [
  ...site.repoGroups.map((g) => ({
    title: g.title,
    description: g.description,
    repos: repos.filter((r) => inGroup(r, g.prefix)),
  })),
  {
    title: 'Others',
    description: '',
    repos: repos.filter((r) => !site.repoGroups.some((g) => inGroup(r, g.prefix))),
  },
].filter((g) => g.repos.length)

// 语言占比条：按仓库的主语言计数，最多列 5 种，其余并入 Other
const MAX_LANGUAGES = 5
const counts = new Map<string, number>()
for (const r of repos) if (r.language) counts.set(r.language, (counts.get(r.language) ?? 0) + 1)
const ranked = [...counts].sort((a, b) => b[1] - a[1])
const languages = ranked.slice(0, MAX_LANGUAGES).map(([name, count]) => ({ name, count, color: languageColor(name) }))
const rest = ranked.slice(MAX_LANGUAGES).reduce((sum, [, count]) => sum + count, 0)
if (rest) languages.push({ name: 'Other', count: rest, color: languageColor('') })

const profile = `https://github.com/${site.github}`
</script>

<template>
  <section id="projects" class="section">
    <div class="container">
      <h2 v-reveal class="section-title">
        Projects<sup class="count">{{ repos.length }}</sup>
      </h2>

      <div v-if="languages.length" v-reveal class="langs">
        <div class="bar" aria-hidden="true">
          <span v-for="lang in languages" :key="lang.name" :style="{ flex: lang.count, background: lang.color }" />
        </div>
        <ul class="legend">
          <li v-for="lang in languages" :key="lang.name">
            <i :style="{ background: lang.color }" />{{ lang.name }}<span>{{ lang.count }}</span>
          </li>
        </ul>
      </div>

      <div v-for="group in groups" :key="group.title" class="group">
        <p v-reveal class="group-head">
          <span class="label">{{ group.title }}</span>
          <span v-if="group.description" class="group-desc">{{ group.description }}</span>
        </p>
        <ul class="rows">
          <li v-for="(repo, i) in group.repos" :key="repo.name" v-reveal="Math.min(i, 6) * 50">
            <RepoCard :repo="repo" />
          </li>
        </ul>
      </div>

      <p v-if="!repos.length" class="note">
        仓库列表暂时没有取到，可以直接去
        <a :href="profile" target="_blank" rel="noopener">GitHub</a> 看看。
      </p>
      <p v-else class="note">
        <a :href="profile" target="_blank" rel="noopener">github.com/{{ site.github }} →</a>
      </p>
    </div>
  </section>
</template>

<style scoped>
.count {
  margin-left: 6px;
  color: var(--faint);
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0;
  vertical-align: super;
}

.langs {
  margin-bottom: 48px;
}

/* 进入视口后从左向右展开 */
.bar {
  display: flex;
  gap: 3px;
  height: 6px;
  clip-path: inset(0 100% 0 0 round 3px);
  transition: clip-path 1.4s cubic-bezier(0.65, 0, 0.2, 1) 0.2s;
}

.has-revealed .bar {
  clip-path: inset(0 0 0 0 round 3px);
}

.bar span {
  min-width: 6px;
  border-radius: 3px;
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 20px;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
  color: var(--muted);
  font-size: 13px;
}

.legend li {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.legend i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.legend span {
  color: var(--faint);
  font-family: var(--font-mono);
  font-size: 12px;
}

.group + .group {
  margin-top: 48px;
}

.group-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 16px;
  margin-bottom: 12px;
}

.group-desc {
  color: var(--faint);
  font-size: 13px;
}

.note {
  margin-top: 24px;
  color: var(--muted);
  font-size: 14px;
}

.note a {
  color: var(--accent);
}

.note a:hover {
  text-decoration: underline;
}
</style>

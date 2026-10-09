<script setup lang="ts">
import { vReveal } from '../composables/useReveal'
import data from '../data/repos.json'
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

const profile = `https://github.com/${site.github}`
</script>

<template>
  <section id="projects" class="section">
    <div class="container">
      <h2 v-reveal class="section-title">Projects</h2>

      <div v-for="group in groups" :key="group.title" v-reveal class="group">
        <p class="group-head">
          <span class="label">{{ group.title }}</span>
          <span v-if="group.description" class="group-desc">{{ group.description }}</span>
        </p>
        <ul class="rows">
          <li v-for="repo in group.repos" :key="repo.name">
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

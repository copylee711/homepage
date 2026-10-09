<script setup lang="ts">
import type { Repo } from '../types'
import AppIcon from './AppIcon.vue'

defineProps<{ repo: Repo }>()

const LANGUAGE_COLORS: Record<string, string> = {
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Vue: '#41b883',
  Python: '#3572a5',
  Go: '#00add8',
  Rust: '#dea584',
  Java: '#b07219',
  Kotlin: '#a97bff',
  C: '#555555',
  'C++': '#f34b7d',
  'C#': '#178600',
  Shell: '#89e051',
  HTML: '#e34c26',
  CSS: '#563d7c',
  Lua: '#000080',
}
</script>

<template>
  <a class="row repo" :href="repo.url" target="_blank" rel="noopener">
    <span class="name">{{ repo.name }}</span>
    <span class="desc">{{ repo.description }}</span>
    <span class="meta">
      <span v-if="repo.stars" class="stars"><AppIcon name="star" />{{ repo.stars }}</span>
      <span v-if="repo.language" class="lang">
        <i class="dot" :style="{ background: LANGUAGE_COLORS[repo.language] ?? '#b0b0b5' }" />
        {{ repo.language }}
      </span>
    </span>
    <AppIcon class="row-arrow" name="arrow" />
  </a>
</template>

<style scoped>
.name {
  flex: none;
  width: 240px;
  font-family: var(--font-mono);
  font-size: 14.5px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.desc {
  flex: 1;
  min-width: 0;
  color: var(--muted);
  font-size: 14.5px;
  overflow-wrap: anywhere;
}

.meta {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: flex-end;
  gap: 16px;
  width: 150px;
  color: var(--faint);
  font-size: 13px;
}

.lang,
.stars {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.stars svg {
  width: 12px;
  height: 12px;
}

@media (max-width: 767px) {
  .repo {
    flex-wrap: wrap;
  }

  .name {
    flex: 1;
    width: auto;
  }

  .meta {
    width: auto;
  }

  .desc {
    flex: none;
    order: 3;
    width: 100%;
  }

  .desc:empty,
  .repo .row-arrow {
    display: none;
  }
}
</style>

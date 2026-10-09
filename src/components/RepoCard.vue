<script setup lang="ts">
import { languageColor } from '../languages'
import type { Repo } from '../types'
import AppIcon from './AppIcon.vue'

defineProps<{ repo: Repo }>()
</script>

<template>
  <a class="row repo" :href="repo.url" target="_blank" rel="noopener">
    <span class="name">{{ repo.name }}</span>
    <span class="desc">{{ repo.description }}</span>
    <span class="meta">
      <span v-if="repo.stars" class="stars"><AppIcon name="star" />{{ repo.stars }}</span>
      <span v-if="repo.language" class="lang">
        <i class="dot" :style="{ background: languageColor(repo.language) }" />
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
  transition: transform 0.4s var(--ease);
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

@media (hover: hover) {
  .repo:hover .name {
    transform: translateX(6px);
  }
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

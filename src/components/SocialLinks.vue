<script setup lang="ts">
import iconData from '../../backend/app/static/social-icons.json'
import type { Social, SocialPlatform } from '../types'

defineProps<{ socials: Social[] }>()
// 图标与后端阅读页共用同一份 JSON，避免两处维护。
const icons = iconData.icons as Record<SocialPlatform, { label: string; path: string; evenodd?: boolean }>
</script>

<template>
  <div v-if="socials.length" class="socials">
    <a
      v-for="social in socials"
      :key="social.platform + social.url"
      :href="social.url"
      :target="social.platform === 'email' ? undefined : '_blank'"
      :rel="social.platform === 'email' ? undefined : 'noopener me'"
      :aria-label="icons[social.platform].label"
      :title="icons[social.platform].label"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path :fill-rule="icons[social.platform].evenodd ? 'evenodd' : undefined" :d="icons[social.platform].path" />
      </svg>
    </a>
  </div>
</template>

<style scoped>
.socials { display:flex; flex-wrap:wrap; gap:10px; padding-bottom:24px; }
.socials a { display:grid; place-items:center; width:38px; height:38px; border:1px solid var(--line); border-radius:10px; color:var(--muted); transition:color .25s,border-color .25s,transform .4s var(--ease),background .25s; }
.socials a:hover { color:var(--accent); border-color:var(--accent); background:var(--accent-soft); transform:translateY(-3px); }
svg { width:17px; height:17px; fill:currentColor; }
</style>

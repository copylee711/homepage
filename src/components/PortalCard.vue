<script setup lang="ts">
import { computed } from 'vue'
import type { Portal } from '../site.config'
import AppIcon from './AppIcon.vue'

const props = defineProps<{ portal: Portal }>()
const external = computed(() => /^https?:/.test(props.portal.href))
</script>

<template>
  <a
    class="portal"
    :href="portal.href"
    :target="external ? '_blank' : undefined"
    :rel="external ? 'noopener' : undefined"
  >
    <span class="top">
      <AppIcon class="icon" :name="portal.icon" />
      <AppIcon class="arrow" name="arrow" />
    </span>
    <h3 class="name">{{ portal.title }}</h3>
    <p class="desc">{{ portal.description }}</p>
    <span class="hint">{{ portal.hint }}</span>
  </a>
</template>

<style scoped>
.portal {
  display: flex;
  flex-direction: column;
  padding: 24px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  transition:
    border-color 0.3s ease,
    transform 0.4s var(--ease);
}

.top {
  display: flex;
  justify-content: space-between;
}

.icon {
  width: 24px;
  height: 24px;
}

.arrow {
  width: 18px;
  height: 18px;
  color: var(--faint);
  transition:
    transform 0.4s var(--ease),
    color 0.3s ease;
}

.name {
  margin-top: 40px;
  font-size: 1.25rem;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.desc {
  margin-top: 4px;
  color: var(--muted);
  font-size: 15px;
}

.hint {
  margin-top: 20px;
  color: var(--faint);
  font-family: var(--font-mono);
  font-size: 12.5px;
  overflow-wrap: anywhere;
}

@media (hover: hover) {
  .portal:hover {
    border-color: var(--line-strong);
    transform: translateY(-2px);
  }

  .portal:hover .arrow {
    color: var(--accent);
    transform: translate(2px, -2px);
  }
}
</style>

<script setup lang="ts">
import { computed } from 'vue'
import { features } from '../account'
import { vReveal } from '../composables/useReveal'
import { site } from '../content'
import PortalCard from './PortalCard.vue'

// 云盘入口只对已开通网盘的用户显示。
const portals = computed(() => (site.value?.portals ?? []).filter(portal => portal.icon !== 'cloud' || features.value.drive))
</script>

<template>
  <section v-if="site && portals.length" id="portals" class="section">
    <div class="container">
      <div class="grid">
        <PortalCard
          v-for="(portal, i) in portals"
          :key="portal.title"
          v-reveal="i * 90"
          :portal="portal"
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
.grid {
  display: grid;
  gap: 16px;
}

@media (min-width: 768px) {
  .grid {
    grid-template-columns: repeat(3, 1fr);
  }
}
</style>

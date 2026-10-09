<script setup lang="ts">
import { vReveal } from '../composables/useReveal'
import { site } from '../site.config'
import PortalCard from './PortalCard.vue'
</script>

<template>
  <section id="portals" class="section">
    <div class="container">
      <div class="grid">
        <PortalCard
          v-for="(portal, i) in site.portals"
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

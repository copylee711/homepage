<script setup lang="ts">
import { computed } from 'vue'
import { features } from '../account'
import { vReveal } from '../composables/useReveal'
import { site } from '../content'
import PortalCard from './PortalCard.vue'

// 云盘入口只对已开通云盘的用户显示。
const portals = computed(() => (site.value?.portals ?? []).filter(portal => portal.icon !== 'cloud' || features.value.drive))
</script>

<template>
  <section v-if="site && portals.length" id="portals" class="section">
    <div class="container">
      <div class="grid" :data-count="portals.length">
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

/* 列数跟随卡片数：三张一行排满；开通云盘后多出的第四张在宽屏并为一行四列，中等宽度排成 2×2，避免末行单独突出一张 */
@media (min-width: 768px) {
  .grid {
    grid-template-columns: repeat(3, 1fr);
  }

  .grid[data-count='2'],
  .grid[data-count='4'] {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (min-width: 1024px) {
  .grid[data-count='4'] {
    grid-template-columns: repeat(4, 1fr);
  }
}
</style>

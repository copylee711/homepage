<script setup lang="ts">
import HeroSection from './components/HeroSection.vue'
import PortalGrid from './components/PortalGrid.vue'
import RepoSection from './components/RepoSection.vue'
import SiteFooter from './components/SiteFooter.vue'
import SiteHeader from './components/SiteHeader.vue'
</script>

<template>
  <SiteHeader />
  <main>
    <HeroSection />
    <PortalGrid />
    <RepoSection />
  </main>
  <SiteFooter />
</template>

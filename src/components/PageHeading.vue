<script setup lang="ts">
import { vReveal } from '../composables/useReveal'
defineProps<{ title: string; label: string }>()
</script>

<template>
  <div class="page-heading">
    <div class="page-grid" aria-hidden="true"><span /><i /></div>
    <div class="container page-heading-content">
      <p v-reveal class="label">{{ label }}</p>
      <h1 class="page-title" :aria-label="title"><span aria-hidden="true"><span v-for="(char, i) in title" :key="i" class="char" :style="{ '--c': i }">{{ char }}</span></span><slot name="count" /></h1>
      <div v-reveal="160" class="page-intro"><slot /></div>
      <a v-reveal="240" class="page-back" href="/">返回主页 <span aria-hidden="true">↗</span></a>
    </div>
  </div>
</template>

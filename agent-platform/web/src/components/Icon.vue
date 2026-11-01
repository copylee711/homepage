<script setup lang="ts">
import { computed } from 'vue';
import { ICONS } from '../services/icons';

const props = defineProps<{ name: string; size?: number }>();
const paths = computed(() => ICONS[props.name] || ICONS.file);
const sz = computed(() => props.size || 18);
</script>

<template>
  <svg class="icon" :width="sz" :height="sz" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true" focusable="false">
    <path v-for="(d, i) in paths" :key="i" :d="d" />
  </svg>
</template>

<style>
.icon { display: block; }
</style>

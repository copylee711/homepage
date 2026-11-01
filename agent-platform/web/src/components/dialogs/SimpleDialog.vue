<script setup lang="ts">
import BaseDialog from './BaseDialog.vue';
defineProps<{ title: string; body: string }>();
</script>

<template>
  <BaseDialog :title="title">
    <p class="hint">{{ body }}</p>
  </BaseDialog>
</template>

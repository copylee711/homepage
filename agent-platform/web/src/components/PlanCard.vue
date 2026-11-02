<script setup lang="ts">
import { computed } from 'vue';
const props = defineProps<{ block: any }>();
const steps = computed(() => { try { return JSON.parse(props.block.args || '{}').steps || []; } catch { return []; } });
</script>
<template>
  <section class="plan-card" aria-label="任务计划">
    <strong>任务计划 <span>{{ steps.filter((s: any) => s.status === 'completed').length }}/{{ steps.length }}</span></strong>
    <ol><li v-for="(step, i) in steps" :key="i" :class="'plan-' + step.status"><span aria-hidden="true">{{ step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '◉' : '○' }}</span> {{ step.step }}<small>{{ step.status === 'completed' ? '已完成' : step.status === 'in_progress' ? '进行中' : '待处理' }}</small></li></ol>
    <p v-if="block.state === 'error'" class="status-error">计划更新失败</p>
  </section>
</template>
<style>
.plan-card { padding: 12px 14px; margin: 12px 0; border: 1px solid var(--line-2); border-radius: var(--radius-sm); font-size: 13px; }
.plan-card strong span { color: var(--muted); margin-left: 8px; font-weight: 400; }
.plan-card ol { list-style: none; margin: 8px 0 0; padding: 0; }
.plan-card li { padding: 4px 0; overflow-wrap: anywhere; }
.plan-card small { color: var(--muted); margin-left: 8px; }
.plan-completed { color: var(--muted); }
.plan-in_progress { font-weight: 600; }
</style>

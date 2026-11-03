<script setup lang="ts">
import { ref, computed } from 'vue';
import Icon from './Icon.vue';
import { useSession } from '../stores/session';

const session = useSession();
const expanded = ref(false);

const plan = computed(() => {
  // Check active live stream first
  const live = session.activeLive;
  if (live?.blocks) {
    for (let i = live.blocks.length - 1; i >= 0; i--) {
      const b = live.blocks[i];
      if (b.type === 'tool' && b.name === 'update_plan' && b.state === 'success') {
        try {
          const args = JSON.parse(b.args || '{}');
          if (Array.isArray(args.steps) && args.steps.length) return args;
        } catch {}
      }
    }
  }
  // Check session messages
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (let j = m.content.length - 1; j >= 0; j--) {
        const c = m.content[j];
        if (c.type === 'toolCall' && c.name === 'update_plan') {
          try {
            const args = typeof c.arguments === 'object' ? c.arguments : JSON.parse(c.arguments || '{}');
            if (Array.isArray(args.steps) && args.steps.length) return args;
          } catch {}
        }
      }
    }
  }
  return null;
});

const steps = computed(() => plan.value?.steps || []);
const completedCount = computed(() => steps.value.filter((s: any) => s.status === 'completed').length);
const inProgressStep = computed(() => session.busyHere ? steps.value.find((s: any) => s.status === 'in_progress') : null);
</script>

<template>
  <div v-if="steps.length" class="float-plan-root" :class="{ 'is-expanded': expanded }">
    <!-- Collapsed pill button -->
    <button
      type="button"
      class="float-plan-pill"
      :title="expanded ? '收起任务面板' : '展开任务面板'"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <span class="float-plan-icon">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
          <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
          <path d="M9 14l2 2 4-4"/>
        </svg>
      </span>
      <span class="float-plan-title">计划</span>
      <span class="float-plan-badge">{{ completedCount }}/{{ steps.length }}</span>
      <span v-if="inProgressStep && !expanded" class="float-plan-curr">{{ inProgressStep.step }}</span>
      <Icon name="chevron-right" :size="12" class="float-plan-arrow" />
    </button>

    <!-- Expanded panel -->
    <div v-if="expanded" class="float-plan-card">
      <div class="float-plan-head">
        <div class="float-plan-head-left">
          <strong>任务计划</strong>
          <span class="float-plan-progress-text">{{ completedCount }} / {{ steps.length }} 完成</span>
        </div>
        <button type="button" class="float-plan-close" title="收起" @click="expanded = false">
          <Icon name="x" :size="13" />
        </button>
      </div>

      <!-- Mini progress bar -->
      <div class="float-plan-bar-wrap">
        <div class="float-plan-bar" :style="{ width: (steps.length ? (completedCount / steps.length * 100) : 0) + '%' }"></div>
      </div>

      <ol class="float-plan-list">
        <li
          v-for="(st, i) in steps"
          :key="i"
          class="float-plan-item"
          :class="'is-' + (st.status === 'in_progress' && !session.busyHere ? 'pending' : st.status)"
        >
          <span class="float-plan-marker">
            <svg v-if="st.status === 'completed'" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            <span v-else-if="st.status === 'in_progress' && session.busyHere" class="float-plan-dot-active"></span>
            <span v-else class="float-plan-dot-idle"></span>
          </span>
          <span class="float-plan-step-text">{{ st.step }}</span>
          <span class="float-plan-step-status">
            {{ st.status === 'completed' ? '完成' : st.status === 'in_progress' ? (session.busyHere ? '进行中' : '待确认') : '等待' }}
          </span>
        </li>
      </ol>
    </div>
  </div>
</template>

<style>
.float-plan-root {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  pointer-events: auto;
  font-size: 12.5px;
  user-select: none;
}
.float-plan-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 29px;
  padding: 0 10px 0 8px;
  border: 1px solid var(--line-2);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text);
  box-shadow: var(--shadow-sm);
  cursor: pointer;
  transition: all var(--fast);
}
.float-plan-pill:hover {
  border-color: var(--line-strong);
  background: var(--surface-2);
  box-shadow: var(--shadow);
}
.float-plan-icon {
  display: inline-flex;
  align-items: center;
  color: var(--accent-ink);
}
.float-plan-title {
  font-weight: 600;
}
.float-plan-badge {
  padding: 1px 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text) 7%, transparent);
  color: var(--muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  font-weight: 560;
}
.float-plan-curr {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
  font-size: 11.5px;
}
.float-plan-arrow {
  color: var(--muted);
  transition: transform 180ms var(--ease);
}
.float-plan-root.is-expanded .float-plan-arrow {
  transform: rotate(90deg);
}
.float-plan-card {
  position: absolute;
  top: 36px;
  right: 0;
  width: 310px;
  max-height: 440px;
  overflow-y: auto;
  padding: 12px 14px;
  border: 1px solid var(--line-2);
  border-radius: 14px;
  background: var(--surface);
  box-shadow: var(--shadow-lg);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  z-index: 20;
  animation: float-panel-in 180ms var(--ease) both;
}
@keyframes float-panel-in {
  from { opacity: 0; transform: translateY(-4px) scale(0.97); }
  to { opacity: 1; transform: none; }
}
.float-plan-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.float-plan-head-left {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.float-plan-head-left strong {
  font-size: 13.5px;
  font-weight: 650;
  color: var(--text);
}
.float-plan-progress-text {
  font-size: 11px;
  color: var(--muted);
}
.float-plan-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.float-plan-close:hover {
  background: var(--surface-2);
  color: var(--text);
}
.float-plan-bar-wrap {
  width: 100%;
  height: 3px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text) 8%, transparent);
  margin-bottom: 10px;
  overflow: hidden;
}
.float-plan-bar {
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
  transition: width 240ms var(--ease);
}
.float-plan-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.float-plan-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 4px 6px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.45;
  transition: background-color var(--fast);
}
.float-plan-item.is-in_progress {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  font-weight: 560;
  color: var(--text);
}
.float-plan-item.is-completed {
  color: var(--muted);
}
.float-plan-marker {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-top: 1px;
}
.float-plan-item.is-completed .float-plan-marker {
  color: #10b981;
}
.float-plan-dot-active {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 2.5px var(--accent-soft);
  animation: breathe 1.7s ease-in-out infinite;
}
.float-plan-dot-idle {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--line-strong);
}
.float-plan-step-text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.float-plan-step-status {
  flex: none;
  font-size: 10.5px;
  color: var(--muted);
}
.float-plan-item.is-in_progress .float-plan-step-status {
  color: var(--accent-ink);
  font-weight: 600;
}
</style>

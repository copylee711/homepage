<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';
import { get, post } from '../services/api';
import { useUi } from '../stores/ui';
import { useSession } from '../stores/session';

const ui = useUi();
const session = useSession();

const tasks = ref<any[]>([]);
const logs = ref<Record<string, string>>({});
const expanded = ref(false);
const pending = ref('');
const error = ref('');
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;

// CRITICAL: Only show when there are actively running tasks
const runningTasks = computed(() => tasks.value.filter(t => t.state === 'running'));

async function load() {
  if (timer) clearTimeout(timer);
  if (!session.canExecute) return;
  try {
    const r = await get('/api/background');
    if (disposed) return;
    tasks.value = r.tasks || [];
    error.value = '';
    // If no more tasks running, automatically fold
    if (runningTasks.value.length === 0) {
      expanded.value = false;
    }
  } catch (e: any) {
    if (!disposed) error.value = e.message || '加载后台任务失败';
  } finally {
    if (!disposed) timer = setTimeout(load, 5000);
  }
}

async function readLogs(id: string) {
  pending.value = id;
  try {
    const r = await get('/api/background?id=' + encodeURIComponent(id));
    logs.value[id] = r.logs || '暂无日志输出';
  } catch (e: any) {
    error.value = e.message;
  } finally {
    pending.value = '';
  }
}

async function stop(task: any) {
  if (!await ui.confirm({
    title: '停止后台任务',
    message: `停止“${task.title}”后，预览服务链接立即失效。`,
    confirmText: '停止任务'
  })) return;
  pending.value = task.id;
  try {
    await post('/api/background/stop', { id: task.id });
    await load();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    pending.value = '';
  }
}

onMounted(load);
onBeforeUnmount(() => {
  disposed = true;
  if (timer) clearTimeout(timer);
});
</script>

<template>
  <!-- Only rendered when there are running tasks -->
  <div v-if="runningTasks.length" class="float-bg-root" :class="{ 'is-expanded': expanded }">
    <!-- Collapsed pill button -->
    <button
      type="button"
      class="float-bg-pill"
      :title="expanded ? '收起后台任务' : '查看运行中的后台任务'"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <span class="float-bg-pulse"></span>
      <span class="float-bg-icon">
        <Icon name="activity" :size="13" />
      </span>
      <span class="float-bg-title">后台任务</span>
      <span class="float-bg-badge">{{ runningTasks.length }}</span>
      <Icon name="chevron-right" :size="12" class="float-bg-arrow" />
    </button>

    <!-- Expanded card -->
    <div v-if="expanded" class="float-bg-card">
      <div class="float-bg-head">
        <div class="float-bg-head-left">
          <strong>后台任务</strong>
          <span class="float-bg-active-tag">运行中 ({{ runningTasks.length }})</span>
        </div>
        <button type="button" class="float-bg-close" title="收起" @click="expanded = false">
          <Icon name="x" :size="13" />
        </button>
      </div>

      <div class="float-bg-list">
        <section v-for="task in runningTasks" :key="task.id" class="float-bg-item">
          <div class="float-bg-item-head">
            <strong class="float-bg-item-title">{{ task.title }}</strong>
            <span class="float-bg-item-state">运行中</span>
          </div>
          <code class="float-bg-cmd">{{ task.command }}</code>
          <p class="float-bg-meta">
            {{ task.cwd }} · 最迟 {{ new Date(task.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}
          </p>

          <div class="float-bg-actions">
            <a
              v-if="task.previewPath"
              :href="task.previewPath"
              target="_blank"
              rel="noopener noreferrer"
              class="btn btn-quiet float-bg-btn"
            >
              打开预览
            </a>
            <button
              type="button"
              class="btn btn-quiet float-bg-btn"
              :disabled="!!pending"
              @click="readLogs(task.id)"
            >
              {{ logs[task.id] ? '刷新日志' : '查看日志' }}
            </button>
            <button
              type="button"
              class="btn btn-quiet float-bg-btn float-bg-btn-danger"
              :disabled="!!pending"
              @click="stop(task)"
            >
              停止
            </button>
          </div>

          <pre v-if="logs[task.id]" class="float-bg-logs">{{ logs[task.id] }}</pre>
        </section>
      </div>
      <p v-if="error" class="status-error" role="alert">{{ error }}</p>
    </div>
  </div>
</template>

<style>
.float-bg-root {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  pointer-events: auto;
  font-size: 12.5px;
  user-select: none;
}
.float-bg-pill {
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
.float-bg-pill:hover {
  border-color: var(--line-strong);
  background: var(--surface-2);
  box-shadow: var(--shadow);
}
.float-bg-pulse {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #10b981;
  box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.25);
  animation: bg-task-pulse 1.8s ease-in-out infinite;
}
@keyframes bg-task-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.6; transform: scale(1.15); }
}
.float-bg-icon {
  display: inline-flex;
  align-items: center;
  color: #10b981;
}
.float-bg-title {
  font-weight: 600;
}
.float-bg-badge {
  padding: 1px 5px;
  border-radius: 999px;
  background: rgba(16, 185, 129, 0.14);
  color: #059669;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  font-weight: 650;
}
:root[data-theme='dark'] .float-bg-badge {
  background: rgba(16, 185, 129, 0.24);
  color: #34d399;
}
.float-bg-arrow {
  color: var(--muted);
  transition: transform 180ms var(--ease);
}
.float-bg-root.is-expanded .float-bg-arrow {
  transform: rotate(90deg);
}
.float-bg-card {
  position: absolute;
  top: 36px;
  right: 0;
  width: 330px;
  max-height: 460px;
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
.float-bg-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.float-bg-head-left {
  display: flex;
  align-items: center;
  gap: 8px;
}
.float-bg-head-left strong {
  font-size: 13.5px;
  font-weight: 650;
  color: var(--text);
}
.float-bg-active-tag {
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(16, 185, 129, 0.14);
  color: #059669;
  font-size: 10.5px;
  font-weight: 600;
}
:root[data-theme='dark'] .float-bg-active-tag {
  background: rgba(16, 185, 129, 0.22);
  color: #34d399;
}
.float-bg-close {
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
.float-bg-close:hover {
  background: var(--surface-2);
  color: var(--text);
}
.float-bg-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.float-bg-item {
  padding: 10px;
  border: 1px solid var(--line-2);
  border-radius: 10px;
  background: var(--surface-2);
}
.float-bg-item-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-bottom: 5px;
}
.float-bg-item-title {
  font-size: 12.5px;
  font-weight: 620;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.float-bg-item-state {
  color: #10b981;
  font-size: 11px;
  font-weight: 560;
}
.float-bg-cmd {
  display: block;
  padding: 4px 6px;
  border-radius: 5px;
  background: var(--code-bg);
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-2);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin-bottom: 5px;
}
.float-bg-meta {
  margin: 0 0 8px;
  color: var(--muted);
  font-size: 11px;
}
.float-bg-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.float-bg-btn {
  padding: 3px 8px;
  font-size: 11.5px;
  height: 24px;
}
.float-bg-btn-danger:hover {
  color: var(--danger);
  border-color: var(--danger);
}
.float-bg-logs {
  margin: 8px 0 0;
  max-height: 160px;
  overflow: auto;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--code-bg);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>

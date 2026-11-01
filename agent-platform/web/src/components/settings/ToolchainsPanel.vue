<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import Icon from '../Icon.vue';
import { get, post } from '../../services/api';
import { useUi } from '../../stores/ui';

const ui = useUi();
const status = ref('正在读取工具链状态…');
const catalog = ref<any[]>([]);
const installed = ref<Map<string, string>>(new Map());
const versions = ref<Record<string, string>>({});
const running = ref(false);
const pending = ref(false);
const output = ref('');
let timer: ReturnType<typeof setTimeout> | null = null;

async function load() {
  if (timer) { clearTimeout(timer); timer = null; }
  try {
    const data = await get('/api/toolchains');
    running.value = data.job?.state === 'running';
    output.value = data.job?.output || '';
    if (Array.isArray(data.catalog) && data.catalog.length) {
      catalog.value = data.catalog;
      const map = new Map<string, string>((data.installed || []).map((i: any) => [i.id, i.version]));
      installed.value = map;
      for (const item of data.catalog) {
        if (!versions.value[item.id]) versions.value[item.id] = map.get(item.id) || item.version;
      }
    }
    if (running.value) {
      status.value = '正在安装工具链 · 请保持此窗口打开以自动续期';
      timer = setTimeout(load, 2000);
    } else {
      status.value = '工具安装到工作区 .tools 目录（已自动加入 PATH），基础环境已内置 Node、Python、Git 与 C/C++。';
    }
  } catch (e: any) {
    status.value = e.message;
  }
}

async function change(item: any, action: 'install' | 'remove') {
  if (pending.value || running.value) return;
  if (action === 'remove' && !(await ui.confirm({ title: '移除工具链', message: `确定移除 ${item.name}？项目文件和其他工具会保留。`, confirmText: '移除', danger: true }))) return;
  pending.value = true;
  try {
    await post('/api/toolchains/change', {
      id: item.id,
      version: (versions.value[item.id] || item.version || '').trim(),
      action,
    });
    await load();
  } catch (e: any) {
    status.value = e.message;
    ui.toast(e.message, { tone: 'error' });
  } finally {
    pending.value = false;
  }
}

async function cancelJob() {
  try {
    await post('/api/toolchains/cancel', {});
    running.value = false;
    await load();
    ui.toast('已停止安装任务', { tone: 'info' });
  } catch (e: any) {
    ui.toast(e.message, { tone: 'error' });
  }
}

onMounted(load);
onBeforeUnmount(() => { if (timer) clearTimeout(timer); });
</script>

<template>
  <div class="settings-pad">
    <div class="panel-top">
      <p class="hint" style="flex: 1" role="status">{{ status }}</p>
      <button v-if="running" type="button" class="btn btn-quiet btn-sm is-danger" @click="cancelJob">
        <Icon name="square" :size="13" /><span>停止任务</span>
      </button>
      <button v-else type="button" class="btn btn-quiet btn-sm" @click="load">
        <Icon name="refresh" :size="14" /><span>刷新</span>
      </button>
    </div>

    <pre v-if="output" class="tc-output">{{ output }}</pre>

    <div class="pkg-list">
      <p v-if="!catalog.length && !running" class="list-empty-plain">暂无可配置工具链条目。</p>
      <article v-for="item in catalog" :key="item.id" class="pkg-card">
        <div class="pkg-body">
          <div class="pkg-head">
            <strong>{{ item.name }}</strong>
            <span v-if="installed.has(item.id)" class="grant-state is-on">已安装 v{{ installed.get(item.id) }}</span>
            <span v-else class="grant-state">未安装</span>
          </div>
          <p class="pkg-desc">{{ item.description }}</p>
        </div>
        <div class="tc-actions">
          <input
            v-model="versions[item.id]"
            class="tc-ver-input"
            maxlength="40"
            :disabled="running || pending"
            :aria-label="item.name + ' 版本号'"
          >
          <button type="button" class="btn btn-quiet btn-sm" :disabled="running || pending" @click="change(item, 'install')">
            {{ installed.has(item.id) ? '更新' : '安装' }}
          </button>
          <button
            v-if="installed.has(item.id)"
            type="button"
            class="btn btn-quiet btn-sm is-danger"
            :disabled="running || pending"
            @click="change(item, 'remove')"
          >
            移除
          </button>
        </div>
      </article>
    </div>
  </div>
</template>

<style>
.tc-actions { display: flex; align-items: center; gap: 6px; flex: none; flex-wrap: wrap; }
.tc-ver-input { width: 92px; height: 32px; padding: 0 9px; border: 1px solid var(--line-2); border-radius: 9px; background: var(--surface-2); color: var(--text); font-family: var(--font-mono); font-size: 12px; outline: 0; }
.tc-ver-input:focus { border-color: var(--line-focus); background: var(--surface); }
.tc-output { margin: 0; max-height: 150px; overflow: auto; padding: 11px 13px; border: 1px solid var(--line-2); border-radius: 10px; background: var(--code-bg); color: var(--text-2); font-family: var(--font-mono); font-size: 11.5px; line-height: 1.55; white-space: pre-wrap; }
</style>

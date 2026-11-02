<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import Icon from '../Icon.vue';
import SelectMenu from '../SelectMenu.vue';
import { get, post } from '../../services/api';
import { useUi } from '../../stores/ui';
import { grantDate } from '../../services/format';

const ui = useUi();
const users = ref<any[]>([]);
const enabled = ref(false);
const query = ref('');
const status = ref('正在读取账户列表…');
const busy = ref(false);
const durations = ref<Record<string, number>>({});
const durationOptions = [
  { value: 1, label: '1 天' },
  { value: 7, label: '7 天' },
  { value: 30, label: '30 天' },
];

// Inline per-user quota editor
const quotaUser = ref<any | null>(null);
const quotaLoading = ref(false);
const quotaSaving = ref(false);
const quotaStatus = ref('');
const quotaData = ref<any>(null);
const quotaForm = ref({ disk_mib: 256, memory_mib: 512, cpus: 1, pids: 96, timeout: 180 });

const visible = computed(() => {
  const q = query.value.trim().toLowerCase();
  return users.value.filter(u => !q || (u.name + ' ' + u.email).toLowerCase().includes(q));
});

async function load() {
  status.value = '正在读取账户列表…';
  try {
    const r = await get('/api/grants');
    users.value = r.users || [];
    for (const u of users.value) { if (!durations.value[u.id]) durations.value[u.id] = 7; }
    enabled.value = r.enabled === true;
    status.value = enabled.value ? '普通用户需逐个授权后方可使用执行能力。' : '当前环境变量尚未开启普通用户执行开关（新增授权已关闭）。';
  } catch (e: any) {
    status.value = e.message;
  }
}

function isActive(u: any) { return u.expires_at > Date.now() / 1000; }
function stateText(u: any) {
  if (u.disabled) return '账户已停用';
  if (u.admin) return '管理员';
  if (isActive(u)) return '已授权至 ' + grantDate(u.expires_at);
  return u.expires_at ? '授权已过期' : '未授权';
}

async function change(u: any, days: number) {
  if (busy.value) return;
  busy.value = true;
  try {
    await post('/api/grants/save', { user_id: u.id, days });
    await load();
    ui.toast(days ? '已更新执行授权' : '已撤销执行权限', { tone: 'success' });
  } catch (e: any) {
    ui.toast(e.message, { tone: 'error' });
  } finally {
    busy.value = false;
  }
}

async function openQuota(u: any) {
  if (quotaUser.value?.id === u.id) {
    quotaUser.value = null;
    return;
  }
  quotaUser.value = u;
  quotaLoading.value = true;
  quotaStatus.value = '正在读取配额…';
  quotaData.value = null;
  try {
    const data = await get('/api/quotas?user_id=' + encodeURIComponent(u.id));
    quotaData.value = data;
    const q = data.quota || data;
    quotaForm.value = {
      disk_mib: Number(q.disk_mib ?? 256),
      memory_mib: Number(q.memory_mib ?? 512),
      cpus: Number(q.cpus ?? 1),
      pids: Number(q.pids ?? 96),
      timeout: Number(q.timeout ?? 180),
    };
    const usedText = data.used_bytes == null ? '工作区尚未挂载。' : `已用约 ${Math.ceil(data.used_bytes / 1048576)} MiB。`;
    const budgetText = data.total_disk_budget_mib ? `主机磁盘总预算 ${data.total_disk_budget_mib} MiB。` : '';
    quotaStatus.value = `${usedText} ${budgetText}`.trim();
  } catch (e: any) {
    quotaStatus.value = e.message;
  } finally {
    quotaLoading.value = false;
  }
}

function rangeFor(key: string): [number, number] {
  const r = quotaData.value?.ranges?.[key];
  if (Array.isArray(r) && r.length === 2) return [r[0], r[1]];
  const defaults: Record<string, [number, number]> = {
    disk_mib: [64, 16384],
    memory_mib: [64, 4096],
    cpus: [0.1, 4],
    pids: [16, 256],
    timeout: [10, 600],
  };
  return defaults[key] || [1, 99999];
}

async function saveQuota() {
  if (!quotaUser.value || quotaSaving.value) return;
  const prevDisk = Number(quotaData.value?.quota?.disk_mib ?? quotaData.value?.disk_mib ?? 256);
  if (quotaForm.value.disk_mib < prevDisk) {
    if (!(await ui.confirm({ title: '缩小工作区磁盘', message: '缩小工作区磁盘将离线检查并调整文件系统，若已有数据无法容纳会拒绝。确定继续？', confirmText: '继续保存', danger: true }))) return;
  }
  quotaSaving.value = true;
  quotaStatus.value = '正在检查并保存配额…';
  try {
    await post('/api/quotas/save', { user_id: quotaUser.value.id, quota: { ...quotaForm.value } });
    if (quotaData.value?.quota) Object.assign(quotaData.value.quota, quotaForm.value);
    quotaStatus.value = '配额已保存，下一次工具调用生效。';
    ui.toast('配额已保存', { tone: 'success' });
  } catch (e: any) {
    quotaStatus.value = e.message;
    ui.toast(e.message, { tone: 'error' });
  } finally {
    quotaSaving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="settings-pad">
    <div class="panel-top">
      <div class="search-box">
        <Icon name="search" :size="15" />
        <input v-model="query" type="search" placeholder="搜索昵称或邮箱…" autocomplete="off" maxlength="160">
      </div>
      <button type="button" class="btn btn-quiet btn-sm" @click="load">
        <Icon name="refresh" :size="14" /><span>刷新</span>
      </button>
    </div>
    <p class="hint" role="status">{{ status }}</p>

    <div class="grant-list">
      <p v-if="!visible.length" class="list-empty-plain">{{ query ? '没有匹配的账户。' : '暂无账户数据。' }}</p>
      <div v-for="u in visible" :key="u.id" class="grant-card">
        <div class="grant-card-main">
          <div class="grant-meta">
            <div class="grant-title-row">
              <strong>{{ u.name }}</strong>
              <span class="grant-state" :class="{ 'is-on': u.admin || isActive(u) }">{{ stateText(u) }}</span>
            </div>
            <small>{{ u.email }}</small>
          </div>
          <div class="grant-btns">
            <template v-if="!u.admin && !u.disabled">
              <SelectMenu :model-value="durations[u.id] || 7" size="sm" :options="durationOptions" aria-label="授权期限" @update:model-value="v => durations[u.id] = Number(v)" />
              <button type="button" class="btn btn-solid btn-sm" :disabled="busy || !enabled" @click="change(u, durations[u.id] || 7)">
                {{ isActive(u) ? '续期' : '授予' }}
              </button>
              <button v-if="isActive(u)" type="button" class="btn btn-quiet btn-sm is-danger" :disabled="busy" @click="change(u, 0)">撤销</button>
            </template>
            <button type="button" class="btn btn-quiet btn-sm" @click="openQuota(u)">
              {{ quotaUser?.id === u.id ? '收起配额' : '配额' }}
            </button>
          </div>
        </div>

        <form novalidate v-if="quotaUser?.id === u.id" class="quota-box" @submit.prevent="saveQuota">
          <div class="quota-head">
            <strong>资源配额 · {{ u.name }}</strong>
            <span>{{ quotaStatus }}</span>
          </div>
          <div v-if="!quotaLoading" class="field-grid quota-grid">
            <label class="field">
              <span class="field-label">磁盘容量（MiB）</span>
              <input v-model.number="quotaForm.disk_mib" type="number" :min="rangeFor('disk_mib')[0]" :max="rangeFor('disk_mib')[1]" step="1" required>
            </label>
            <label class="field">
              <span class="field-label">内存上限（MiB）</span>
              <input v-model.number="quotaForm.memory_mib" type="number" :min="rangeFor('memory_mib')[0]" :max="rangeFor('memory_mib')[1]" step="1" required>
            </label>
            <label class="field">
              <span class="field-label">CPU 核数</span>
              <input v-model.number="quotaForm.cpus" type="number" :min="rangeFor('cpus')[0]" :max="rangeFor('cpus')[1]" step="0.1" required>
            </label>
            <label class="field">
              <span class="field-label">最大进程数</span>
              <input v-model.number="quotaForm.pids" type="number" :min="rangeFor('pids')[0]" :max="rangeFor('pids')[1]" step="1" required>
            </label>
            <label class="field">
              <span class="field-label">单条命令时限（秒）</span>
              <input v-model.number="quotaForm.timeout" type="number" :min="rangeFor('timeout')[0]" :max="rangeFor('timeout')[1]" step="1" required>
            </label>
          </div>
          <div v-if="!quotaLoading" class="quota-actions">
            <button type="button" class="btn btn-quiet btn-sm" @click="quotaUser = null">取消</button>
            <button type="submit" class="btn btn-solid btn-sm" :disabled="quotaSaving">{{ quotaSaving ? '保存中…' : '保存配额' }}</button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<style>
.settings-pad { padding: 18px 22px 22px; overflow-y: auto; height: 100%; display: flex; flex-direction: column; gap: 12px; }
.panel-top { display: flex; align-items: center; gap: 8px; }
.search-box { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 11px; border: 1px solid var(--line-2); transition: border-color var(--fast), background-color var(--fast); border-radius: 10px; background: var(--surface-2); color: var(--muted); }
.search-box:focus-within { border-color: var(--line-focus); background: var(--surface); }
.search-box input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--text); font-size: 13px; }
.list-empty-plain { padding: 24px 0; text-align: center; color: var(--muted); font-size: 12.5px; }

.grant-list { display: flex; flex-direction: column; gap: 8px; }
.grant-card { border: 1px solid var(--line-2); border-radius: 12px; background: var(--surface); padding: 12px 14px; }
.grant-card-main { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.grant-meta { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.grant-title-row { display: flex; align-items: center; gap: 8px; }
.grant-title-row strong { font-size: 13.5px; font-weight: 600; }
.grant-meta small { color: var(--muted); font-size: 11.5px; }
.grant-state { padding: 2px 7px; border-radius: 999px; font-size: 10.5px; background: var(--surface-2); color: var(--muted); }
.grant-state.is-on { background: var(--ok-soft); color: var(--ok); font-weight: 600; }
.grant-btns { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.grant-select { height: 32px; padding: 0 9px; border: 1px solid var(--line-2); border-radius: 9px; background: var(--surface-2); color: var(--text-2); font-size: 12px; outline: 0; }

.quota-box { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 12px; }
.quota-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.quota-head strong { font-size: 12.5px; }
.quota-head span { color: var(--muted); font-size: 11px; }
.quota-grid { grid-template-columns: repeat(auto-fill, minmax(175px, 1fr)); }
.quota-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>

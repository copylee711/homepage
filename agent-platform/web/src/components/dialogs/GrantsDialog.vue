<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import BaseDialog from './BaseDialog.vue';
import { get, post } from '../../services/api';
import { useUi } from '../../stores/ui';
import { grantDate } from '../../services/format';

const ui = useUi();
const users = ref<any[]>([]);
const enabled = ref(false);
const query = ref('');
const status = ref('正在读取账户…');
const busy = ref(false);
const durations = ref<Record<string, number>>({});

const visible = computed(() => {
  const q = query.value.trim().toLowerCase();
  return users.value.filter(u => (u.name + ' ' + u.email).toLowerCase().includes(q));
});

async function load() {
  status.value = '正在读取账户…';
  try { const r = await get('/api/grants'); users.value = r.users || []; enabled.value = r.enabled === true; status.value = enabled.value ? '独立沙箱已启用；普通用户仍需逐个授权。' : '权限测试尚未放行，新增授权已关闭。'; }
  catch (e: any) { status.value = e.message; }
}
function isActive(u: any) { return u.expires_at > Date.now() / 1000; }
function stateText(u: any) {
  if (u.disabled) return '账户已停用';
  if (u.admin) return '管理员 · 已有执行权限';
  if (isActive(u)) return '已授权至 ' + grantDate(u.expires_at);
  return u.expires_at ? '授权已过期' : '未授权';
}
async function change(u: any, days: number) {
  if (busy.value) return; busy.value = true;
  status.value = days ? '正在授予执行权限…' : '正在撤销授权并停止任务…';
  try { await post('/api/grants/save', { user_id: u.id, days }); await load(); ui.toast(days ? '已授予执行权限' : '已撤销执行权限', { tone: 'success' }); }
  catch (e: any) { status.value = e.message; ui.toast(e.message, { tone: 'error' }); }
  finally { busy.value = false; }
}
onMounted(load);
</script>

<template>
  <BaseDialog title="用户执行授权" subtitle="仅向你信任的账户授权。每个用户拥有独立工作区；授权不会开放供应商设置。">
    <div class="search-field">
      <input v-model="query" type="search" placeholder="昵称或邮箱" autocomplete="off" maxlength="160" aria-label="搜索账户">
    </div>
    <p class="hint" role="status">{{ status }}</p>
    <div class="grant-users">
      <p v-if="!visible.length" class="hint">{{ query ? '没有符合条件的账户。' : '没有可用账户。' }}</p>
      <section v-for="u in visible" :key="u.id" class="grant-user">
        <strong>{{ u.name }}</strong><small>{{ u.email }}</small>
        <p class="hint">{{ stateText(u) }}</p>
        <div v-if="!u.admin && !u.disabled" class="grant-actions">
          <label class="grant-duration"><span>期限</span>
            <select v-model.number="durations[u.id]"><option :value="1">1 天</option><option :value="7">7 天</option><option :value="30">30 天</option></select>
          </label>
          <button class="btn btn-solid" :disabled="busy || !enabled" @click="change(u, durations[u.id] || 7)">{{ isActive(u) ? '续期' : '授予' }}</button>
          <button v-if="isActive(u)" class="btn btn-quiet is-danger" :disabled="busy" @click="change(u, 0)">撤销</button>
        </div>
      </section>
    </div>
    <div class="dialog-actions"><button class="btn btn-quiet" @click="load">刷新账户列表</button></div>
  </BaseDialog>
</template>

<style>
.search-field { display: flex; align-items: center; min-height: 40px; padding: 0 12px; border: 1px solid var(--line-strong); border-radius: 11px; background: var(--surface-2); }
.search-field input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--text); font-size: 13px; }
.grant-users { display: flex; flex-direction: column; margin: 12px 0 4px; max-height: 42vh; overflow-y: auto; }
.grant-user { padding: 12px 2px; border-bottom: 1px solid var(--line); }
.grant-user:last-child { border-bottom: 0; }
.grant-user strong { display: block; font-size: 13px; font-weight: 600; }
.grant-user small { display: block; color: var(--muted); font-size: 11px; }
.grant-user .hint { margin-top: 3px; }
.grant-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; margin-top: 8px; }
.grant-duration { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); font-size: 11px; }
.grant-duration select { min-height: 30px; padding: 4px 8px; border: 1px solid var(--line-2); border-radius: 8px; background: var(--surface-2); color: var(--text-2); font-size: 11px; }
.grant-actions .btn { min-height: 30px; padding: 0 11px; font-size: 11px; }
</style>

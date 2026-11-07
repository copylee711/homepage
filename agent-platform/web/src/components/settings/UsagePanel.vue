<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { get } from '../../services/api';

const days = ref(30);
const data = ref<any>(null);
const loading = ref(true);
const error = ref('');

async function load() {
  loading.value = true; error.value = '';
  try { data.value = await get('/api/usage?days=' + days.value); }
  catch (e: any) { error.value = e.message; }
  finally { loading.value = false; }
}
onMounted(load);

const fmt = (n: number) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n || 0);
const money = (n: number) => n > 0 ? '$' + (n < 0.01 ? n.toFixed(4) : n.toFixed(2)) : '—';
const peak = computed(() => Math.max(1, ...(data.value?.byDay || []).map((d: any) => d.input + d.output)));
const hasCost = computed(() => (data.value?.total?.cost || 0) > 0);
</script>

<template>
  <div class="settings-pad usage-panel">
    <div class="usage-head">
      <h3>用量与费用</h3>
      <div class="seg">
        <button v-for="d in [7, 30, 90]" :key="d" type="button" :class="{ 'is-on': days === d }" @click="days = d; load()">{{ d }} 天</button>
      </div>
    </div>
    <p class="question-hint">统计来自对话记录中每次模型调用的 token 用量。费用按“模型与供应商”中为每个模型填写的单价计算；未填写单价的模型只统计 token。</p>
    <p v-if="loading && !data" role="status" class="question-hint">正在统计…</p>
    <p v-if="error" class="status-error" role="alert">{{ error }}</p>
    <template v-if="data">
      <div class="usage-cards">
        <div class="usage-card"><span>模型调用</span><strong>{{ data.total.calls }}</strong></div>
        <div class="usage-card"><span>输入 tokens</span><strong>{{ fmt(data.total.input) }}</strong><small v-if="data.total.cacheRead">缓存命中 {{ fmt(data.total.cacheRead) }}</small></div>
        <div class="usage-card"><span>输出 tokens</span><strong>{{ fmt(data.total.output) }}</strong></div>
        <div class="usage-card"><span>估算费用</span><strong>{{ money(data.total.cost) }}</strong><small v-if="!hasCost">未配置单价</small></div>
      </div>

      <h4>每日用量</h4>
      <div v-if="data.byDay.length" class="usage-bars" role="img" :aria-label="'最近 ' + days + ' 天每日 token 用量'">
        <div v-for="d in data.byDay" :key="d.day" class="usage-bar" :title="`${d.day}\n输入 ${fmt(d.input)} · 输出 ${fmt(d.output)} · ${money(d.cost)}`">
          <span class="usage-bar-fill" :style="{ height: Math.max(2, (d.input + d.output) / peak * 100) + '%' }"></span>
        </div>
      </div>
      <p v-else class="question-hint">这段时间没有模型调用。</p>

      <h4>按模型</h4>
      <div class="usage-table">
        <div class="usage-row is-head"><span>模型</span><span>调用</span><span>输入</span><span>输出</span><span>费用</span></div>
        <div v-for="m in data.byModel" :key="m.key" class="usage-row"><span class="usage-name" :title="m.key">{{ m.key }}</span><span>{{ m.calls }}</span><span>{{ fmt(m.input) }}</span><span>{{ fmt(m.output) }}</span><span>{{ money(m.cost) }}</span></div>
      </div>

      <h4>用量最多的对话</h4>
      <div class="usage-table">
        <div class="usage-row is-head"><span>对话</span><span>调用</span><span>输入</span><span>输出</span><span>费用</span></div>
        <div v-for="c in data.byChat" :key="c.key" class="usage-row"><span class="usage-name" :title="c.title">{{ c.title }}</span><span>{{ c.calls }}</span><span>{{ fmt(c.input) }}</span><span>{{ fmt(c.output) }}</span><span>{{ money(c.cost) }}</span></div>
      </div>
    </template>
  </div>
</template>

<style>
.usage-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 6px; }
.usage-head h3 { margin: 0; }
.usage-cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 14px; }
.usage-card { display: flex; flex-direction: column; gap: 3px; padding: 12px 14px; border: 1px solid var(--line-2); border-radius: 12px; background: var(--surface); }
.usage-card span { color: var(--muted); font-size: 11.5px; }
.usage-card strong { font-size: 20px; font-weight: 650; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.usage-card small { color: var(--faint); font-size: 11px; }
.usage-bars { display: flex; align-items: flex-end; gap: 3px; height: 96px; padding: 8px 2px 0; border-bottom: 1px solid var(--line); }
.usage-bar { flex: 1; min-width: 3px; height: 100%; display: flex; align-items: flex-end; }
.usage-bar-fill { width: 100%; border-radius: 3px 3px 0 0; background: color-mix(in srgb, var(--text) 26%, transparent); transition: background-color var(--fast); }
.usage-bar:hover .usage-bar-fill { background: var(--ink); }
.usage-table { display: flex; flex-direction: column; }
.usage-row { display: grid; grid-template-columns: minmax(0, 2.4fr) repeat(4, minmax(56px, 1fr)); gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--line); font-size: 12.5px; font-variant-numeric: tabular-nums; }
.usage-row:last-child { border-bottom: 0; }
.usage-row.is-head { color: var(--muted); font-size: 11.5px; font-weight: 600; }
.usage-row > span:not(.usage-name) { text-align: right; }
.usage-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-size: 12px; }
@media (max-width: 640px) { .usage-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>

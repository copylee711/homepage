<script setup lang="ts">
import { ref, onMounted } from 'vue';
import Icon from '../Icon.vue';
import { get, post } from '../../services/api';
import { useUi } from '../../stores/ui';

const ui = useUi();
const query = ref('');
const status = ref('正在读取扩展目录…');
const loading = ref(false);
const pending = ref<string | null>(null);
const items = ref<any[]>([]);
const installedMap = ref<Map<string, any>>(new Map());
let seq = 0;

async function load() {
  const cur = ++seq;
  loading.value = true;
  status.value = '正在查询 npm pi-package 目录…';
  try {
    const data = await get('/api/packages?q=' + encodeURIComponent(query.value.trim()));
    if (cur !== seq) return;
    const map = new Map<string, any>((data.installed || []).map((it: any) => [it.name, it]));
    installedMap.value = map;
    items.value = [
      ...(data.installed || []),
      ...(data.packages || []).filter((it: any) => !map.has(it.name)),
    ];
    status.value = `已安装 ${map.size} 个 · 搜索结果 ${data.packages?.length || 0} 个`;
  } catch (e: any) {
    if (cur === seq) status.value = e.message;
  } finally {
    if (cur === seq) loading.value = false;
  }
}

async function toggle(item: any) {
  if (pending.value) return;
  const saved = installedMap.value.get(item.name);
  const msg = saved
    ? `确定移除扩展“${item.name}”？`
    : `安装固定版本 ${item.name}@${item.version} 的文本技能与提示词？请仅安装受信任的包。`;
  if (!(await ui.confirm({ title: saved ? '移除扩展' : '安装扩展', message: msg, confirmText: saved ? '移除' : '安装', danger: !!saved }))) return;
  pending.value = item.name;
  status.value = '正在校验 SHA-512 并处理包资源…';
  try {
    await post('/api/packages/change', {
      name: item.name,
      version: item.version,
      action: saved ? 'remove' : 'install',
    });
    ui.toast(saved ? `已移除 ${item.name}` : `已安装 ${item.name}`, { tone: 'success' });
    await load();
  } catch (e: any) {
    status.value = e.message;
    ui.toast(e.message, { tone: 'error' });
  } finally {
    pending.value = null;
  }
}

onMounted(load);
</script>

<template>
  <div class="settings-pad">
    <form novalidate class="panel-top" @submit.prevent="load">
      <div class="search-box">
        <Icon name="search" :size="15" />
        <input v-model="query" type="search" placeholder="搜索技能与提示词包（npm pi-package）…" maxlength="100" autocomplete="off">
      </div>
      <button type="submit" class="btn btn-solid btn-sm" :disabled="loading || !!pending">搜索</button>
      <a class="btn btn-quiet btn-sm" href="https://pi.dev/packages" target="_blank" rel="noopener noreferrer">
        <span>官方目录</span><Icon name="external-link" :size="13" />
      </a>
    </form>
    <p class="hint" role="status">{{ status }} · 这里只加载经过 SHA-512 校验的 Markdown 技能与提示词，不执行包内脚本。上下文、MCP 与个人 Skill 请在“能力”中配置；终端 UI 插件不会被直接执行。</p>

    <div class="pkg-list">
      <p v-if="!loading && !items.length" class="list-empty-plain">暂无匹配的扩展包。</p>
      <article v-for="item in items" :key="item.name" class="pkg-card">
        <div class="pkg-body">
          <div class="pkg-head">
            <strong>{{ item.name }}</strong>
            <span class="pkg-ver">v{{ item.version }}</span>
            <span v-if="installedMap.has(item.name)" class="grant-state is-on">
              已安装 {{ installedMap.get(item.name)?.resources?.length || 0 }} 项资源
            </span>
          </div>
          <p class="pkg-desc">{{ item.description || '已校验完整性，未提供额外描述。' }}</p>
        </div>
        <button
          type="button"
          class="btn btn-quiet btn-sm"
          :class="{ 'is-danger': installedMap.has(item.name) }"
          :disabled="!!pending"
          @click="toggle(item)"
        >
          {{ pending === item.name ? '处理中…' : installedMap.has(item.name) ? '移除' : '加载文本资源' }}
        </button>
      </article>
    </div>
  </div>
</template>

<style>
.pkg-list { display: flex; flex-direction: column; gap: 8px; }
.pkg-card { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 12px 14px; border: 1px solid var(--line-2); border-radius: 12px; background: var(--surface); }
.pkg-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.pkg-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pkg-head strong { font-size: 13.5px; font-weight: 600; font-family: var(--font-mono); }
.pkg-ver { font-size: 11px; color: var(--muted); font-family: var(--font-mono); }
.pkg-desc { margin: 0; color: var(--text-2); font-size: 12px; line-height: 1.5; }
</style>

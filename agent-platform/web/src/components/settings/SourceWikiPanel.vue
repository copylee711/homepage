<script setup lang="ts">
import { computed, ref } from 'vue';
import { get, post } from '../../services/api';
import SelectMenu from '../SelectMenu.vue';

type Source = { topic: string; title: string; url: string; origin: string; enabled: boolean; failures?: number; retry?: boolean };
type Directory = { revision: number; auto: boolean; semantic?: boolean; semanticAvailable?: boolean; sources: Source[] };
const topics = [
  { value: 'news', label: '新闻' }, { value: 'llm', label: '模型榜单' },
  { value: 'github', label: 'GitHub 趋势' }, { value: 'images', label: '通用图库' },
  { value: 'mathematics', label: '数学' }, { value: 'physics', label: '物理' }, { value: 'biology', label: '生物' },
];
const directory = ref<Directory>();
const topic = ref('news');
const editing = ref(false), busy = ref(false), error = ref(''), notice = ref('');
const rows = computed(() => directory.value?.sources.filter(source => source.topic === topic.value) || []);
const emit = defineEmits<{ (event: 'editing', active: boolean): void }>();

async function load() {
  busy.value = true;
  error.value = '';
  try {
    directory.value = await get('/api/search/wiki');
    editing.value = false;
    emit('editing', false);
  } catch (e: any) { error.value = e.message; }
  finally { busy.value = false; }
}

function startEdit() {
  editing.value = true;
  notice.value = '';
  emit('editing', true);
}
function add() {
  directory.value?.sources.push({ topic: topic.value, title: '', url: '', enabled: true, origin: 'user' });
}
function remove(source: Source) {
  if (directory.value) directory.value.sources = directory.value.sources.filter(item => item !== source);
}
async function save() {
  busy.value = true;
  error.value = '';
  try {
    directory.value = await post('/api/search/wiki/save', { config: directory.value });
    editing.value = false;
    emit('editing', false);
    notice.value = '搜索源目录已保存';
  } catch (e: any) { error.value = e.message; }
  finally { busy.value = false; }
}
</script>

<template>
  <details class="source-wiki" @toggle="($event.target as HTMLDetailsElement).open && !directory && !busy && load()">
    <summary>搜索源 Wiki</summary>
    <p class="question-hint">按主题查看内置来源。新增、停用和自动维护只影响你的账号。</p>
    <p v-if="busy && !directory" role="status">正在读取搜索源目录…</p>
    <p v-if="error" class="status-error" role="alert">{{ error }}</p>
    <button v-if="!directory && !busy" type="button" class="btn btn-quiet" @click="load">重新读取</button>
    <template v-if="directory">
      <div class="setting-row">
        <SelectMenu v-model="topic" :options="topics" aria-label="搜索源主题" />
        <div v-if="!editing">
          <button type="button" class="btn btn-quiet" :disabled="busy" @click="load">刷新</button>
          <button type="button" class="btn btn-quiet" :disabled="busy" @click="startEdit">编辑目录</button>
        </div>
      </div>
      <div class="setting-row">
        <label for="wiki-auto">会话结束后自动维护</label>
        <input id="wiki-auto" v-model="directory.auto" type="checkbox" :disabled="!editing || busy" />
      </div>
      <p class="question-hint">利用任务已访问的来源。连续三次访问失败会标记待核查，并从 Agent 的推荐中暂时移除。</p>
      <div class="setting-row">
        <label for="wiki-semantic">发送消息时检索相似来源</label>
        <input id="wiki-semantic" v-model="directory.semantic" type="checkbox" :disabled="!editing || busy || !directory.semanticAvailable" />
      </div>
      <p class="question-hint">{{ directory.semanticAvailable ? '开启后，会将本轮消息的前 1800 字符和已启用的来源目录交给配置的向量服务。超时会回退到主题匹配。' : '服务器尚未配置向量服务，当前使用主题匹配。' }}</p>
      <p v-if="!rows.length" class="question-hint">此主题暂无来源。</p>
      <div v-for="(source, i) in rows" :key="i" class="source-wiki-row">
        <template v-if="editing">
          <input v-model="source.title" placeholder="来源名称" :aria-label="'来源名称 ' + (i+1)" maxlength="100" :disabled="busy" />
          <input v-model="source.url" placeholder="https://…" :aria-label="'来源网址 ' + (i+1)" maxlength="1000" type="url" :disabled="busy" />
          <label><input v-model="source.enabled" type="checkbox" :disabled="busy" /> 启用</label>
          <button v-if="(source.failures || 0) >= 3" type="button" class="btn btn-quiet btn-sm" :disabled="busy || source.retry" @click="source.retry=true">{{ source.retry ? '将重新启用推荐' : '恢复推荐' }}</button>
          <button type="button" class="btn btn-quiet btn-sm" :disabled="busy" @click="remove(source)">移除</button>
        </template>
        <template v-else>
          <a :href="source.url" target="_blank" rel="noopener noreferrer">{{ source.title }}</a>
          <small>{{ source.origin === 'builtin' ? '内置' : source.origin === 'agent' ? 'Agent 收录' : '个人添加' }}{{ !source.enabled ? ' · 已停用' : (source.failures || 0) >= 3 ? ' · 待核查' : '' }}</small>
        </template>
      </div>
      <div v-if="editing" class="approval-actions">
        <button type="button" class="btn btn-quiet" :disabled="busy || directory.sources.length >= 80" @click="add">添加来源</button>
        <button type="button" class="btn btn-quiet" :disabled="busy" @click="load">取消编辑并重新读取</button>
        <button type="button" class="btn btn-solid" :disabled="busy" @click="save">{{ busy ? '保存中…' : '保存目录' }}</button>
      </div>
      <p v-if="notice" class="question-hint" role="status">{{ notice }}</p>
    </template>
  </details>
</template>

<style scoped>
.source-wiki { padding: 16px 0; border-bottom: 1px solid var(--line); }
.source-wiki summary { cursor: pointer; font-weight: 600; }
.source-wiki-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 9px 0; border-bottom: 1px solid var(--line); }
.source-wiki-row a { overflow-wrap: anywhere; }
.source-wiki-row small { color: var(--muted); }
.source-wiki-row input:not([type='checkbox']) { flex: 1 1 150px; }
.source-wiki .approval-actions { flex-wrap: wrap; }
</style>

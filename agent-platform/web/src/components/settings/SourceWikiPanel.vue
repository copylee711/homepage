<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { get, post } from '../../services/api';
import { useUi } from '../../stores/ui';
import Icon from '../Icon.vue';
import SelectMenu from '../SelectMenu.vue';

type Source = {
  topic: string;
  title: string;
  url: string;
  origin: string;
  enabled: boolean;
  failures?: number;
  retry?: boolean;
};

type EmbeddingConfig = {
  url: string;
  model: string;
  apiKey?: string;
  hasKey?: boolean;
};

type Directory = {
  revision: number;
  auto: boolean;
  semantic?: boolean;
  semanticAvailable?: boolean;
  embedding?: EmbeddingConfig;
  sources: Source[];
};

type SourceDraft = {
  index: number;
  topic: string;
  title: string;
  url: string;
  origin: string;
  enabled: boolean;
  failures: number;
  retry: boolean;
};

type EmbeddingDraft = {
  url: string;
  model: string;
  apiKey: string;
  hasKey: boolean;
  enableSemanticAfterSave: boolean;
};

const ui = useUi();
const topics = [
  { value: 'news', label: '新闻' },
  { value: 'llm', label: '模型榜单' },
  { value: 'github', label: 'GitHub 趋势' },
  { value: 'images', label: '通用图库' },
  { value: 'mathematics', label: '数学' },
  { value: 'physics', label: '物理' },
  { value: 'biology', label: '生物' },
];

const expanded = ref(true);
const directory = ref<Directory>();
const topic = ref('news');
const busy = ref(false);
const error = ref('');
const notice = ref('');

// Dialog states
const embeddingDraft = ref<EmbeddingDraft | null>(null);
const showEmbeddingKey = ref(false);
const embeddingError = ref('');

const sourceDraft = ref<SourceDraft | null>(null);
const sourceError = ref('');

const directoryDraft = ref<Source[] | null>(null);
const directoryTopic = ref('news');
const directoryError = ref('');

const rows = computed(() => directory.value?.sources.filter(source => source.topic === topic.value) || []);
const draftRows = computed(() => {
  if (!directoryDraft.value) return [];
  return directoryDraft.value
    .map((source, index) => ({ source, index }))
    .filter(item => item.source.topic === directoryTopic.value);
});

const embeddingHost = computed(() => {
  const raw = directory.value?.embedding?.url;
  if (!raw) return '';
  try {
    return new URL(raw).host;
  } catch {
    return raw;
  }
});

const emit = defineEmits<{ (event: 'editing', active: boolean): void }>();

const anyDialogOpen = computed(() => !!(embeddingDraft.value || sourceDraft.value || directoryDraft.value));
watch(anyDialogOpen, active => {
  emit('editing', active);
  document.removeEventListener('keydown', trapEscape, true);
  if (active) document.addEventListener('keydown', trapEscape, true);
});
onMounted(() => {
  void load();
});
onBeforeUnmount(() => document.removeEventListener('keydown', trapEscape, true));

function trapEscape(e: KeyboardEvent) {
  if (e.key !== 'Escape' || ui.modal) return;
  if (document.querySelector('.iris-select-pop')) return;
  e.preventDefault();
  e.stopPropagation();
  closeAllDialogs();
}

function closeAllDialogs() {
  embeddingDraft.value = null;
  embeddingError.value = '';
  sourceDraft.value = null;
  sourceError.value = '';
  directoryDraft.value = null;
  directoryError.value = '';
}

async function load() {
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    directory.value = await get('/api/search/wiki');
    closeAllDialogs();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function persist(nextConfig: Directory, successMsg?: string) {
  busy.value = true;
  error.value = '';
  try {
    directory.value = await post('/api/search/wiki/save', { config: nextConfig });
    if (successMsg) {
      notice.value = successMsg;
      ui.toast(successMsg, { tone: 'success' });
    }
    return true;
  } catch (e: any) {
    error.value = e.message;
    return false;
  } finally {
    busy.value = false;
  }
}

async function changeAuto(event: Event) {
  if (!directory.value) return;
  const checked = (event.target as HTMLInputElement).checked;
  const previous = directory.value.auto === true;
  const payload: Directory = {
    ...directory.value,
    auto: checked,
    sources: directory.value.sources.map(s => ({ ...s })),
  };
  if (!(await persist(payload, checked ? '已开启会话后自动维护' : '已关闭会话后自动维护'))) {
    directory.value.auto = previous;
  }
}

async function changeSemantic(event: Event) {
  if (!directory.value) return;
  const target = event.target as HTMLInputElement;
  const checked = target.checked;
  if (checked && !directory.value.semanticAvailable) {
    target.checked = false;
    openEmbeddingDialog(true);
    return;
  }
  const previous = directory.value.semantic === true;
  const payload: Directory = {
    ...directory.value,
    semantic: checked,
    sources: directory.value.sources.map(s => ({ ...s })),
  };
  if (!(await persist(payload, checked ? '已开启相似来源向量检索' : '已关闭相似来源向量检索'))) {
    directory.value.semantic = previous;
  }
}

function openEmbeddingDialog(enableSemanticAfterSave = false) {
  if (!directory.value) return;
  const emb = directory.value.embedding;
  showEmbeddingKey.value = false;
  embeddingError.value = '';
  embeddingDraft.value = {
    url: emb?.url || '',
    model: emb?.model || '',
    apiKey: '',
    hasKey: !!emb?.hasKey,
    enableSemanticAfterSave,
  };
}

async function saveEmbedding() {
  if (!directory.value || !embeddingDraft.value) return;
  const draft = embeddingDraft.value;
  const url = draft.url.trim();
  const model = draft.model.trim();
  if (!url || !model) {
    embeddingError.value = '请完整填写 HTTPS Embeddings 端点与模型 ID';
    return;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('https');
  } catch {
    embeddingError.value = 'Embeddings 端点必须为公开 HTTPS 地址';
    return;
  }
  embeddingError.value = '';
  const payload: Directory = {
    ...directory.value,
    semantic: draft.enableSemanticAfterSave ? true : directory.value.semantic,
    embedding: {
      url,
      model,
      apiKey: draft.apiKey,
      hasKey: draft.hasKey,
    },
    sources: directory.value.sources.map(s => ({ ...s })),
  };
  busy.value = true;
  try {
    directory.value = await post('/api/search/wiki/save', { config: payload });
    embeddingDraft.value = null;
    notice.value = '向量模型配置已保存';
    ui.toast('向量模型配置已保存', { tone: 'success' });
  } catch (e: any) {
    embeddingError.value = e.message || '保存失败';
  } finally {
    busy.value = false;
  }
}

async function clearEmbedding() {
  if (!directory.value) return;
  if (!(await ui.confirm({
    title: '清除自定义向量模型配置？',
    message: '清除后将移除已保存的 Embeddings 端点、模型 ID 与 API 密钥。',
    confirmText: '清除配置',
    danger: true,
  }))) return;
  const payload: Directory = {
    ...directory.value,
    semantic: false,
    embedding: { url: '', model: '', apiKey: '' },
    sources: directory.value.sources.map(s => ({ ...s })),
  };
  busy.value = true;
  try {
    directory.value = await post('/api/search/wiki/save', { config: payload });
    embeddingDraft.value = null;
    notice.value = '已清除自定义向量配置';
    ui.toast('已清除自定义向量配置', { tone: 'success' });
  } catch (e: any) {
    embeddingError.value = e.message || '清除失败';
  } finally {
    busy.value = false;
  }
}

function openSourceDialog(source?: Source) {
  if (!directory.value) return;
  sourceError.value = '';
  if (source) {
    const index = directory.value.sources.indexOf(source);
    sourceDraft.value = {
      index,
      topic: source.topic,
      title: source.title,
      url: source.url,
      origin: source.origin || 'user',
      enabled: source.enabled !== false,
      failures: source.failures || 0,
      retry: false,
    };
  } else {
    sourceDraft.value = {
      index: -1,
      topic: topic.value,
      title: '',
      url: '',
      origin: 'user',
      enabled: true,
      failures: 0,
      retry: false,
    };
  }
}

async function saveSourceDraft() {
  if (!directory.value || !sourceDraft.value) return;
  const draft = sourceDraft.value;
  const title = draft.title.trim();
  const url = draft.url.trim();
  if (!title || !url) {
    sourceError.value = '请填写来源名称和完整的 HTTPS 网址';
    return;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('https');
  } catch {
    sourceError.value = '来源网址必须为公开 HTTPS 地址';
    return;
  }
  const nextSources = directory.value.sources.map(s => ({ ...s }));
  const item: Source = {
    topic: draft.topic,
    title,
    url,
    origin: draft.origin || 'user',
    enabled: draft.enabled,
    failures: draft.retry ? 0 : draft.failures,
    retry: draft.retry,
  };
  if (draft.index >= 0 && draft.index < nextSources.length) {
    nextSources.splice(draft.index, 1, item);
  } else {
    nextSources.push(item);
  }
  busy.value = true;
  sourceError.value = '';
  try {
    directory.value = await post('/api/search/wiki/save', {
      config: { ...directory.value, sources: nextSources },
    });
    topic.value = draft.topic;
    sourceDraft.value = null;
    notice.value = draft.index >= 0 ? '来源已更新' : '已添加搜索源';
    ui.toast(notice.value, { tone: 'success' });
  } catch (e: any) {
    sourceError.value = e.message || '保存失败';
  } finally {
    busy.value = false;
  }
}

async function removeSourcePrompt(source: Source) {
  if (!directory.value) return;
  if (!(await ui.confirm({
    title: '移除搜索源',
    message: `确定从当前账号目录中移除“${source.title}”吗？`,
    confirmText: '移除',
    danger: true,
  }))) return;
  const nextSources = directory.value.sources.filter(item => item !== source).map(s => ({ ...s }));
  await persist({ ...directory.value, sources: nextSources }, `已移除“${source.title}”`);
}

async function retrySource(source: Source) {
  if (!directory.value) return;
  const nextSources = directory.value.sources.map(item =>
    item === source ? { ...item, retry: true, failures: 0 } : { ...item }
  );
  await persist({ ...directory.value, sources: nextSources }, `已恢复“${source.title}”的推荐状态`);
}

function openDirectoryDialog() {
  if (!directory.value) return;
  directoryError.value = '';
  directoryTopic.value = topic.value;
  directoryDraft.value = directory.value.sources.map(s => ({ ...s }));
}

function addDraftRow() {
  if (!directoryDraft.value || directoryDraft.value.length >= 80) return;
  directoryDraft.value.push({
    topic: directoryTopic.value,
    title: '',
    url: '',
    origin: 'user',
    enabled: true,
  });
}

function removeDraftRow(index: number) {
  if (!directoryDraft.value) return;
  directoryDraft.value.splice(index, 1);
}

async function saveDirectoryDraft() {
  if (!directory.value || !directoryDraft.value) return;
  directoryError.value = '';
  busy.value = true;
  try {
    directory.value = await post('/api/search/wiki/save', {
      config: {
        ...directory.value,
        sources: directoryDraft.value,
      },
    });
    topic.value = directoryTopic.value;
    directoryDraft.value = null;
    notice.value = '搜索源目录已保存';
    ui.toast('搜索源目录已保存', { tone: 'success' });
  } catch (e: any) {
    directoryError.value = e.message || '保存目录失败';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="source-wiki" :class="{ 'is-open': expanded }">
    <button
      type="button"
      class="source-wiki-summary"
      :aria-expanded="expanded"
      @click="expanded = !expanded; if (expanded && !directory && !busy) load()"
    >
      <Icon name="chevron-right" :size="15" class="source-wiki-chevron" />
      <div class="source-wiki-heading">
        <strong>搜索源 Wiki</strong>
        <span>按主题管理推荐来源与向量检索，新增、停用和自动维护仅影响你的账号</span>
      </div>
      <div v-if="directory" class="source-wiki-badges">
        <span class="wiki-chip">{{ directory.sources.length }} 条来源</span>
        <span v-if="directory.semantic && directory.semanticAvailable" class="wiki-chip is-accent">向量检索开启</span>
      </div>
    </button>

    <div v-if="expanded" class="source-wiki-body">
      <p v-if="busy && !directory" class="question-hint" role="status">正在读取搜索源目录…</p>
      <p v-if="error" class="status-error" role="alert">{{ error }}</p>
      <button v-if="!directory && !busy" type="button" class="btn btn-quiet btn-sm" @click="load">重新读取</button>

      <template v-if="directory">
        <!-- 开关与向量服务配置卡片 -->
        <div class="wiki-config-group">
          <div class="wiki-setting-item">
            <div class="setting-info">
              <label for="wiki-auto" class="wiki-setting-title">会话结束后自动维护</label>
              <span>利用任务已访问的来源；连续三次访问失败会标记待核查，并从 Agent 的推荐中暂时移除。</span>
            </div>
            <input
              id="wiki-auto"
              :checked="directory.auto"
              type="checkbox"
              class="wiki-checkbox"
              :disabled="busy"
              @change="changeAuto"
            />
          </div>

          <div class="wiki-setting-item is-semantic">
            <div class="wiki-setting-top">
              <div class="setting-info">
                <label for="wiki-semantic" class="wiki-setting-title">发送消息时检索相似来源</label>
                <span>开启后，会将本轮消息的前 1800 字符和已启用的来源目录交给配置的向量服务；超时回退到主题匹配。</span>
              </div>
              <input
                id="wiki-semantic"
                :checked="directory.semantic"
                type="checkbox"
                class="wiki-checkbox"
                :disabled="busy"
                @change="changeSemantic"
              />
            </div>

            <div class="wiki-embedding-bar">
              <div class="wiki-embedding-info">
                <span class="wiki-embedding-kicker">向量检索模型 (Embedding)</span>
                <div v-if="directory.embedding?.model" class="wiki-embedding-detail">
                  <code class="wiki-model-pill">{{ directory.embedding.model }}</code>
                  <span v-if="embeddingHost" class="wiki-host-text">{{ embeddingHost }}</span>
                  <span v-if="directory.embedding?.hasKey" class="wiki-tag">已存密钥</span>
                </div>
                <div v-else-if="directory.semanticAvailable" class="wiki-embedding-detail">
                  <span class="wiki-host-text">当前使用服务端默认向量服务</span>
                </div>
                <div v-else class="wiki-embedding-detail">
                  <span class="wiki-host-text is-empty">尚未配置向量服务，请点击右侧按钮填写端点与模型</span>
                </div>
              </div>
              <button
                type="button"
                class="btn btn-quiet btn-sm"
                :disabled="busy"
                @click="openEmbeddingDialog(false)"
              >
                配置向量模型
              </button>
            </div>
          </div>
        </div>

        <!-- 主题筛选与操作工具栏 -->
        <div class="wiki-toolbar">
          <div class="wiki-toolbar-left">
            <SelectMenu v-model="topic" :options="topics" aria-label="搜索源主题" />
            <span class="wiki-topic-count">共 {{ rows.length }} 条</span>
          </div>
          <div class="wiki-toolbar-actions">
            <button type="button" class="btn btn-quiet btn-sm" :disabled="busy" @click="load">刷新</button>
            <button
              type="button"
              class="btn btn-quiet btn-sm"
              :disabled="busy || directory.sources.length >= 80"
              @click="openSourceDialog()"
            >
              添加来源
            </button>
            <button type="button" class="btn btn-quiet btn-sm" :disabled="busy" @click="openDirectoryDialog">
              编辑目录
            </button>
          </div>
        </div>

        <!-- 来源列表 -->
        <div v-if="!rows.length" class="wiki-empty">
          <span>此主题下暂无来源。</span>
          <button type="button" class="btn btn-quiet btn-sm" :disabled="busy" @click="openSourceDialog()">添加第一条来源</button>
        </div>
        <div v-else class="source-wiki-list">
          <div
            v-for="(source, i) in rows"
            :key="source.url + i"
            class="source-wiki-row"
            :class="{ 'is-disabled': !source.enabled }"
          >
            <div class="source-wiki-main">
              <div class="source-wiki-title-row">
                <a :href="source.url" target="_blank" rel="noopener noreferrer" class="source-wiki-link">
                  {{ source.title }}
                </a>
                <span class="wiki-tag">
                  {{ source.origin === 'builtin' ? '内置' : source.origin === 'agent' ? 'Agent 收录' : '个人添加' }}
                </span>
                <span v-if="!source.enabled" class="wiki-tag is-muted">已停用</span>
                <span v-else-if="(source.failures || 0) >= 3" class="wiki-tag is-warn">待核查</span>
              </div>
              <span class="source-wiki-url" :title="source.url">{{ source.url }}</span>
            </div>
            <div class="source-wiki-actions">
              <button
                v-if="(source.failures || 0) >= 3"
                type="button"
                class="btn btn-quiet btn-sm"
                :disabled="busy"
                @click="retrySource(source)"
              >
                恢复推荐
              </button>
              <button
                type="button"
                class="btn btn-quiet btn-sm"
                :disabled="busy"
                @click="openSourceDialog(source)"
              >
                编辑
              </button>
              <button
                type="button"
                class="btn btn-quiet btn-sm is-danger"
                :disabled="busy"
                @click="removeSourcePrompt(source)"
              >
                移除
              </button>
            </div>
          </div>
        </div>

        <p v-if="notice" class="question-hint wiki-notice" role="status">{{ notice }}</p>
      </template>
    </div>

    <!-- 弹窗 1：配置向量模型 (Embedding) -->
    <teleport to="body">
      <div v-if="embeddingDraft" class="wiki-dialog-backdrop" @click.self="closeAllDialogs">
        <form class="dialog" role="dialog" aria-modal="true" aria-label="配置向量模型" @submit.prevent="saveEmbedding">
          <div class="dialog-heading">
            <div>
              <h2>配置向量模型 (Embeddings)</h2>
              <p>用于按消息语义匹配最相关的搜索源。API 密钥仅保存在服务端，更改端点会清除旧密钥。</p>
            </div>
            <button type="button" class="icon-button" aria-label="关闭" @click="closeAllDialogs">
              <Icon name="x" />
            </button>
          </div>
          <div class="dialog-body">
            <label class="field">
              <span class="field-label">Embeddings HTTPS 端点</span>
              <input
                v-model.trim="embeddingDraft.url"
                type="url"
                placeholder="https://api.example.com/v1/embeddings"
                maxlength="1000"
                :disabled="busy"
              />
            </label>
            <label class="field">
              <span class="field-label">模型 ID</span>
              <input
                v-model.trim="embeddingDraft.model"
                placeholder="例如 Qwen/Qwen3-VL-Embedding-8B 或 text-embedding-3-small"
                maxlength="180"
                :disabled="busy"
              />
            </label>
            <label class="field">
              <span class="field-label">
                API 密钥 {{ embeddingDraft.hasKey ? '（已保存，留空则沿用现有密钥）' : '（服务需要鉴权时填写）' }}
              </span>
              <span class="search-key">
                <input
                  v-model="embeddingDraft.apiKey"
                  :type="showEmbeddingKey ? 'text' : 'password'"
                  autocomplete="new-password"
                  spellcheck="false"
                  :placeholder="embeddingDraft.hasKey ? '已保存，留空沿用' : '输入 Bearer API Key'"
                  :disabled="busy"
                />
                <button
                  type="button"
                  class="btn btn-quiet"
                  @click="showEmbeddingKey = !showEmbeddingKey"
                >
                  {{ showEmbeddingKey ? '隐藏' : '显示' }}
                </button>
              </span>
            </label>

            <p v-if="embeddingError" class="status-error" role="alert">{{ embeddingError }}</p>

            <div class="dialog-actions wiki-dialog-actions">
              <button
                v-if="directory?.embedding?.url || directory?.embedding?.model"
                type="button"
                class="btn btn-quiet is-danger wiki-btn-left"
                :disabled="busy"
                @click="clearEmbedding"
              >
                清除配置
              </button>
              <button type="button" class="btn btn-quiet" :disabled="busy" @click="closeAllDialogs">取消</button>
              <button type="submit" class="btn btn-solid" :disabled="busy">
                {{ busy ? '保存中…' : '保存配置' }}
              </button>
            </div>
          </div>
        </form>
      </div>

      <!-- 弹窗 2：添加 / 编辑单条搜索源 -->
      <div v-if="sourceDraft" class="wiki-dialog-backdrop" @click.self="closeAllDialogs">
        <form class="dialog" role="dialog" aria-modal="true" aria-label="编辑搜索源" @submit.prevent="saveSourceDraft">
          <div class="dialog-heading">
            <div>
              <h2>{{ sourceDraft.index >= 0 ? '编辑搜索源' : '添加搜索源' }}</h2>
              <p>来源需使用公开 HTTPS 地址，仅对当前账号生效。</p>
            </div>
            <button type="button" class="icon-button" aria-label="关闭" @click="closeAllDialogs">
              <Icon name="x" />
            </button>
          </div>
          <div class="dialog-body">
            <div class="field">
              <span class="field-label">所属主题</span>
              <SelectMenu v-model="sourceDraft.topic" :options="topics" aria-label="所属主题" />
            </div>
            <label class="field">
              <span class="field-label">来源名称</span>
              <input
                v-model="sourceDraft.title"
                placeholder="例如 Reuters World"
                maxlength="100"
                :disabled="busy"
              />
            </label>
            <label class="field">
              <span class="field-label">来源网址 (HTTPS)</span>
              <input
                v-model="sourceDraft.url"
                type="url"
                placeholder="https://…"
                maxlength="1000"
                :disabled="busy"
              />
            </label>
            <label class="capability-check">
              <input v-model="sourceDraft.enabled" type="checkbox" :disabled="busy" />
              <span>启用该搜索源</span>
            </label>
            <label v-if="sourceDraft.failures >= 3" class="capability-check">
              <input v-model="sourceDraft.retry" type="checkbox" :disabled="busy" />
              <span>恢复 Agent 推荐（清除连续失败待核查标记）</span>
            </label>

            <p v-if="sourceError" class="status-error" role="alert">{{ sourceError }}</p>

            <div class="dialog-actions">
              <button type="button" class="btn btn-quiet" :disabled="busy" @click="closeAllDialogs">取消</button>
              <button type="submit" class="btn btn-solid" :disabled="busy">
                {{ busy ? '保存中…' : '保存来源' }}
              </button>
            </div>
          </div>
        </form>
      </div>

      <!-- 弹窗 3：批量编辑搜索源目录 -->
      <div v-if="directoryDraft" class="wiki-dialog-backdrop" @click.self="closeAllDialogs">
        <form
          class="dialog dialog-wide"
          role="dialog"
          aria-modal="true"
          aria-label="编辑搜索源目录"
          @submit.prevent="saveDirectoryDraft"
        >
          <div class="dialog-heading">
            <div>
              <h2>编辑搜索源目录</h2>
              <p>按主题批量修改名称、网址与启停状态（上限 80 条，当前共 {{ directoryDraft.length }} 条）。</p>
            </div>
            <button type="button" class="icon-button" aria-label="关闭" @click="closeAllDialogs">
              <Icon name="x" />
            </button>
          </div>
          <div class="dialog-body">
            <div class="wiki-batch-toolbar">
              <div class="wiki-toolbar-left">
                <SelectMenu v-model="directoryTopic" :options="topics" aria-label="筛选编辑主题" />
                <span class="wiki-topic-count">当前主题 {{ draftRows.length }} 条</span>
              </div>
              <button
                type="button"
                class="btn btn-quiet btn-sm"
                :disabled="busy || directoryDraft.length >= 80"
                @click="addDraftRow"
              >
                在此主题新增一行
              </button>
            </div>

            <div v-if="!draftRows.length" class="wiki-empty">
              <span>此主题下暂无来源。</span>
              <button type="button" class="btn btn-quiet btn-sm" @click="addDraftRow">新增来源</button>
            </div>
            <div v-else class="wiki-batch-list">
              <div v-for="{ source, index } in draftRows" :key="index" class="wiki-batch-row">
                <input
                  v-model="source.title"
                  placeholder="来源名称"
                  :aria-label="'来源名称 ' + (index + 1)"
                  maxlength="100"
                  :disabled="busy"
                />
                <input
                  v-model="source.url"
                  placeholder="https://…"
                  :aria-label="'来源网址 ' + (index + 1)"
                  maxlength="1000"
                  type="url"
                  :disabled="busy"
                />
                <label class="wiki-batch-enable">
                  <input v-model="source.enabled" type="checkbox" :disabled="busy" />
                  <span>启用</span>
                </label>
                <button
                  v-if="(source.failures || 0) >= 3"
                  type="button"
                  class="btn btn-quiet btn-sm"
                  :disabled="busy || source.retry"
                  @click="source.retry = true"
                >
                  {{ source.retry ? '已恢复' : '恢复推荐' }}
                </button>
                <button
                  type="button"
                  class="btn btn-quiet btn-sm is-danger"
                  :disabled="busy"
                  @click="removeDraftRow(index)"
                >
                  移除
                </button>
              </div>
            </div>

            <p v-if="directoryError" class="status-error" role="alert">{{ directoryError }}</p>

            <div class="dialog-actions">
              <button type="button" class="btn btn-quiet" :disabled="busy" @click="closeAllDialogs">取消</button>
              <button type="submit" class="btn btn-solid" :disabled="busy">
                {{ busy ? '保存中…' : '保存目录' }}
              </button>
            </div>
          </div>
        </form>
      </div>
    </teleport>
  </section>
</template>

<style>
.source-wiki {
  margin: 14px 0 18px;
  border: 1px solid var(--line-2);
  border-radius: 14px;
  background: var(--surface-2);
}

.source-wiki-summary {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
  user-select: none;
  transition: background-color var(--fast);
}
.source-wiki-summary:hover {
  background: color-mix(in srgb, var(--text) 3.5%, transparent);
}

.source-wiki-chevron {
  flex: none;
  color: var(--muted);
  transition: transform var(--fast);
}
.source-wiki.is-open .source-wiki-chevron {
  transform: rotate(90deg);
  color: var(--text);
}

.source-wiki-heading {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.source-wiki-heading strong {
  font-size: 13.5px;
  font-weight: 640;
  color: var(--text);
}
.source-wiki-heading span {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.45;
}

.source-wiki-badges {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
}

.wiki-chip {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text) 6%, transparent);
  color: var(--text-2);
  font-size: 11px;
  font-weight: 560;
}
.wiki-chip.is-accent {
  background: color-mix(in srgb, var(--ink) 12%, transparent);
  color: var(--text);
}

.source-wiki-body {
  padding: 14px 16px 16px;
  border-top: 1px solid var(--line);
  border-radius: 0 0 14px 14px;
  background: var(--surface);
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.wiki-config-group {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface-2);
}

.wiki-setting-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 13px 15px;
}
.wiki-setting-item + .wiki-setting-item {
  border-top: 1px solid var(--line);
}
.wiki-setting-item.is-semantic {
  flex-direction: column;
  align-items: stretch;
  gap: 12px;
}
.wiki-setting-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.wiki-setting-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  cursor: pointer;
}
.wiki-checkbox {
  width: 16px;
  height: 16px;
  margin-top: 2px;
  flex: none;
  cursor: pointer;
  accent-color: var(--ink);
}

.wiki-embedding-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface);
}
.wiki-embedding-info {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.wiki-embedding-kicker {
  font-size: 11px;
  font-weight: 600;
  color: var(--muted);
}
.wiki-embedding-detail {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
}
.wiki-model-pill {
  padding: 2px 7px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--text) 7%, transparent);
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 12px;
}
.wiki-host-text {
  font-size: 12px;
  color: var(--text-2);
}
.wiki-host-text.is-empty {
  color: var(--muted);
}

.wiki-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
}
.wiki-toolbar-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.wiki-toolbar-left .iris-select {
  min-width: 156px;
}
.wiki-topic-count {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}
.wiki-toolbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.source-wiki-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
  background: var(--surface);
}

.source-wiki-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 11px 14px;
  border-bottom: 1px solid var(--line);
  transition: background-color var(--fast);
}
.source-wiki-row:last-child {
  border-bottom: 0;
}
.source-wiki-row:hover {
  background: color-mix(in srgb, var(--text) 2.5%, transparent);
}
.source-wiki-row.is-disabled {
  opacity: 0.65;
}

.source-wiki-main {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.source-wiki-title-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.source-wiki-link {
  font-size: 13px;
  font-weight: 580;
  color: var(--text);
  text-decoration: none;
}
.source-wiki-link:hover {
  text-decoration: underline;
}
.source-wiki-url {
  font-size: 11.5px;
  color: var(--muted);
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wiki-tag {
  display: inline-flex;
  align-items: center;
  height: 19px;
  padding: 0 6px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--text) 6%, transparent);
  color: var(--text-2);
  font-size: 11px;
  font-weight: 550;
}
.wiki-tag.is-muted {
  color: var(--muted);
}
.wiki-tag.is-warn {
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  color: var(--danger);
}

.source-wiki-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
}

.wiki-empty {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px;
  border: 1px dashed var(--line-2);
  border-radius: 12px;
  color: var(--muted);
  font-size: 12.5px;
}

.wiki-notice {
  margin: 0;
}

/* Dialog styles */
.wiki-dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 210;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(12, 13, 18, 0.48);
  backdrop-filter: blur(4px);
}
.wiki-dialog-actions {
  display: flex;
  align-items: center;
}
.wiki-btn-left {
  margin-right: auto;
}

.wiki-batch-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 12px;
}
.wiki-batch-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 52dvh;
  overflow-y: auto;
  padding-right: 2px;
}
.wiki-batch-row {
  display: grid;
  grid-template-columns: minmax(120px, 0.9fr) minmax(180px, 1.5fr) auto auto auto;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface-2);
}
.wiki-batch-row input:not([type='checkbox']) {
  width: 100%;
  min-height: 34px;
  padding: 6px 10px;
  border: 1px solid var(--line-2);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  font-size: 12.5px;
}
.wiki-batch-enable {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
  padding: 0 4px;
}

@media (max-width: 640px) {
  .wiki-embedding-bar,
  .source-wiki-row {
    flex-direction: column;
    align-items: flex-start;
  }
  .source-wiki-actions {
    width: 100%;
    justify-content: flex-end;
  }
  .wiki-batch-row {
    grid-template-columns: 1fr;
  }
}
</style>

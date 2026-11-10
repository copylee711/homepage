<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import Icon from '../Icon.vue';
import SelectMenu from '../SelectMenu.vue';
import { get, post } from '../../services/api';
import { useUi } from '../../stores/ui';
import { useSession } from '../../stores/session';

const ui = useUi();
const session = useSession();

const configs = ref<any>(null);
const loading = ref(true);
const editingId = ref<string>('');
const isNew = ref(false);
const busy = ref(false);
const probing = ref(false);
const status = ref('');
const statusTone = ref('');
const showKey = ref(false);

const customModelInput = ref('');
const probedModels = ref<string[]>([]);
const probeOpen = ref(false);
const probeQuery = ref('');

const apiOptions = [
  { value: 'openai-completions', label: 'OpenAI Chat Completions 兼容' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'google-generative-ai', label: 'Google Gemini' },
];

const form = ref({
  id: '',
  name: '',
  api: 'openai-completions',
  baseUrl: '',
  model: '',
  models: [] as string[],
  proxy: false,
  reasoning: true,
  apiKey: '',
  modelSettings: {} as Record<string, Record<string, number | ''>>,
});
const limitsOpen = ref(false);
const limitFields = [
  { key: 'contextWindow', label: '上下文窗口', unit: 'tokens' },
  { key: 'maxTokens', label: '最大输出', unit: 'tokens' },
  { key: 'input', label: '输入价', unit: '$/M' },
  { key: 'output', label: '输出价', unit: '$/M' },
];
function limitPlaceholder(id: string, key: string) {
  const saved = savedProviders.value.find((p: any) => p.id === form.value.id);
  const value = saved?.limits?.[id]?.[key];
  return value != null ? String(value) : key === 'maxTokens' ? '16384' : key === 'contextWindow' ? '128000' : '未计费';
}
function limitRow(id: string) { return (form.value.modelSettings[id] ||= {}); }

const savedProviders = computed(() => configs.value?.providers || []);
const sharedProviders = computed(() => configs.value?.shared || []);
const presets = computed(() =>
  (configs.value?.presets || []).filter((p: any) => ![...savedProviders.value, ...sharedProviders.value].some((s: any) => s.id === p.id))
);
const isSavedCurrent = computed(() => savedProviders.value.some((p: any) => p.id === form.value.id));
const canDelete = computed(() => isSavedCurrent.value);

const filteredProbed = computed(() => {
  const q = probeQuery.value.trim().toLowerCase();
  return q ? probedModels.value.filter(m => m.toLowerCase().includes(q)) : probedModels.value;
});

function fill(v: any, custom = false) {
  isNew.value = custom;
  editingId.value = custom ? '__new__' : (v.id || '');
  const list: string[] = Array.isArray(v.models) && v.models.length
    ? [...v.models]
    : (v.model ? [v.model] : []);
  form.value = {
    id: custom ? '' : (v.id || ''),
    name: v.name || '',
    api: v.api || 'openai-completions',
    baseUrl: v.baseUrl || '',
    model: v.model || list[0] || '',
    models: list,
    proxy: v.proxy === true,
    reasoning: v.reasoning === true,
    apiKey: '',
    modelSettings: JSON.parse(JSON.stringify(v.modelSettings || {})),
  };
  customModelInput.value = '';
  probedModels.value = [];
  probeOpen.value = false;
  probeQuery.value = '';
  status.value = '';
  statusTone.value = '';
}

function selectProvider(id: string) {
  const v =
    savedProviders.value.find((p: any) => p.id === id) ||
    (configs.value?.presets || []).find((p: any) => p.id === id);
  if (v) fill(v, false);
}

function newProvider() {
  fill({ name: '自定义供应商', api: 'openai-completions', baseUrl: '', model: '', models: [], proxy: false, reasoning: true }, true);
}

function addModelId(raw: string) {
  const parts = raw.split(/[\s,，;；]+/).map(s => s.trim()).filter(Boolean);
  let added = 0;
  for (const id of parts) {
    if (!/^[A-Za-z0-9_.:/-]{1,160}$/.test(id)) {
      ui.toast(`模型 ID 格式无效：${id}`, { tone: 'error' });
      continue;
    }
    if (!form.value.models.includes(id)) {
      form.value.models.push(id);
      added++;
    }
    if (!form.value.model) form.value.model = id;
  }
  return added;
}

function submitCustomModel() {
  if (!customModelInput.value.trim()) return;
  const n = addModelId(customModelInput.value);
  if (n > 0) customModelInput.value = '';
}

function toggleModel(id: string) {
  const idx = form.value.models.indexOf(id);
  if (idx >= 0) {
    form.value.models.splice(idx, 1);
    if (form.value.model === id) form.value.model = form.value.models[0] || '';
  } else {
    if (form.value.models.length >= 80) {
      ui.toast('单个供应商最多启用 80 个模型', { tone: 'warning' });
      return;
    }
    form.value.models.push(id);
    if (!form.value.model) form.value.model = id;
  }
}

function setPrimaryModel(id: string) {
  form.value.model = id;
  if (!form.value.models.includes(id)) form.value.models.unshift(id);
}

function selectAllFiltered() {
  for (const id of filteredProbed.value) {
    if (form.value.models.length >= 80) break;
    if (!form.value.models.includes(id)) form.value.models.push(id);
    if (!form.value.model) form.value.model = id;
  }
}

function clearProbedSelection() {
  const removeSet = new Set(filteredProbed.value);
  form.value.models = form.value.models.filter(m => !removeSet.has(m));
  if (!form.value.models.includes(form.value.model)) {
    form.value.model = form.value.models[0] || '';
  }
}

async function probeModels() {
  if (probing.value || busy.value) return;
  if (!form.value.baseUrl.trim()) {
    status.value = '请先填写 API 地址后再探测模型';
    statusTone.value = 'is-error';
    return;
  }
  probing.value = true;
  status.value = '正在向端点请求可用模型列表…';
  statusTone.value = '';
  try {
    const result = await post('/api/providers/models', {
      config: {
        id: form.value.id.trim(),
        api: form.value.api,
        baseUrl: form.value.baseUrl.trim(),
        apiKey: form.value.apiKey,
        proxy: form.value.proxy,
      },
    });
    probedModels.value = Array.isArray(result.models) ? result.models : [];
    if (probedModels.value.length > 0) {
      probeOpen.value = true;
      status.value = `${result.detail || `探测到 ${probedModels.value.length} 个模型`} · ${result.route || ''}${result.latency ? ` · ${result.latency} ms` : ''}（请勾选需要启用的模型）`;
      statusTone.value = 'is-success';
    } else {
      status.value = result.detail || '未探测到模型列表，请手动输入模型 ID';
      statusTone.value = 'is-error';
    }
  } catch (e: any) {
    status.value = e.message;
    statusTone.value = 'is-error';
  } finally {
    probing.value = false;
  }
}

function buildPayload() {
  if (customModelInput.value.trim()) submitCustomModel();
  const models = [...form.value.models];
  const primary = form.value.model && models.includes(form.value.model) ? form.value.model : (models[0] || '');
  return {
    id: form.value.id.trim(),
    name: form.value.name.trim(),
    api: form.value.api,
    baseUrl: form.value.baseUrl.trim(),
    model: primary,
    models: primary ? [primary, ...models.filter(m => m !== primary)] : models,
    proxy: form.value.proxy,
    reasoning: form.value.reasoning,
    apiKey: form.value.apiKey,
    modelSettings: Object.fromEntries(models.map(id => [id, Object.fromEntries(Object.entries(form.value.modelSettings[id] || {}).filter(([, v]) => v !== '' && v != null))]).filter(([, v]) => Object.keys(v as object).length)),
  };
}

async function act(save: boolean) {
  if (busy.value) return;
  const payload = buildPayload();
  busy.value = true;
  status.value = save ? '正在保存配置…' : '正在测试模型调用…';
  statusTone.value = '';
  try {
    const result = await post(save ? '/api/providers/save' : '/api/providers/test', { config: payload });
    if (save) {
      configs.value = result;
      const saved = result.providers.find((p: any) => p.id === payload.id) || result.providers.find((p: any) => p.id === result.active);
      if (saved) fill(saved, false);
      status.value = '个人供应商已保存。';
      statusTone.value = 'is-success';
      ui.toast('个人供应商已保存', { tone: 'success' });
      if (saved) await session.activateModel(saved.id, saved.model);
    } else {
      status.value = (result.detail || '测试完成') + ' · ' + (result.route || '') + (result.latency ? ' · ' + result.latency + ' ms' : '');
      statusTone.value = result.ok ? 'is-success' : 'is-error';
    }
  } catch (e: any) {
    status.value = e.message;
    statusTone.value = 'is-error';
  } finally {
    busy.value = false;
  }
}

async function removeProvider() {
  if (!canDelete.value || busy.value) return;
  if (!(await ui.confirm({ title: '删除供应商', message: `确定删除供应商“${form.value.name || form.value.id}”？`, confirmText: '删除', danger: true }))) return;
  busy.value = true;
  try {
    const result = await post('/api/providers/delete', { id: form.value.id });
    configs.value = result;
    const next = result.providers.find((p: any) => p.id === result.active) || result.providers[0];
    if (next) fill(next, false);
    else newProvider();
    ui.toast('供应商已删除', { tone: 'success' });
    void session.refreshIdentity();
  } catch (e: any) {
    status.value = e.message;
    statusTone.value = 'is-error';
  } finally {
    busy.value = false;
  }
}

async function activate(p: any) {
  try {
    const m = p.model || p.models?.[0];
    await session.activateModel(p.id, m);
    if (configs.value) {
      configs.value.active = p.id;
      configs.value.activeModel = m;
    }
    ui.toast(`已切换到 ${p.name} · ${m}`, { tone: 'success' });
  } catch (e: any) {
    ui.toast(e.message, { tone: 'error' });
  }
}

onMounted(async () => {
  try {
    configs.value = await get('/api/providers');
    const a = configs.value.providers.find((p: any) => p.id === configs.value.active);
    if (a) fill(a, false);
    else newProvider();
  } catch (e: any) {
    ui.toast(e.message, { tone: 'error' });
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="prov-wrap">
    <aside class="prov-rail">
      <div v-if="sharedProviders.length" class="prov-rail-sub">共享模型</div>
      <div v-if="sharedProviders.length" class="prov-list">
        <div v-for="p in sharedProviders" :key="p.id" class="prov-item" :class="{ 'is-active': configs?.active === p.id }">
          <span class="prov-dot"></span>
          <span class="prov-item-body">
            <span class="prov-item-name">{{ p.name }}</span>
            <span class="prov-item-sub">{{ p.model }}</span>
          </span>
          <span v-if="configs?.active === p.id" class="prov-active-tag">使用中</span>
          <button v-else type="button" class="prov-switch-btn is-visible" @click="activate(p)">启用</button>
        </div>
        <p class="prov-item-sub shared-note">共享模型在权限控制台修改。</p>
      </div>
      <div class="prov-rail-head">
        <span>我的供应商</span>
        <button type="button" class="icon-btn-sm" aria-label="新建供应商" title="新建自定义供应商" @click="newProvider">
          <Icon name="plus" :size="15" />
        </button>
      </div>
      <div v-if="loading" class="prov-empty">正在读取…</div>
      <div class="prov-list">
        <button
          v-for="p in savedProviders"
          :key="p.id"
          type="button"
          class="prov-item"
          :class="{ 'is-editing': !isNew && editingId === p.id, 'is-active': configs?.active === p.id }"
          @click="selectProvider(p.id)"
        >
          <span class="prov-dot"></span>
          <span class="prov-item-body">
            <span class="prov-item-name">{{ p.name }}</span>
            <span class="prov-item-sub">{{ (p.models?.length || 1) }} 个模型 · {{ p.model }}</span>
          </span>
          <span v-if="configs?.active === p.id" class="prov-active-tag">使用中</span>
          <span v-else class="prov-switch-btn" role="button" tabindex="0" title="设为当前供应商" @click.stop="activate(p)">启用</span>
        </button>
        <button v-if="isNew" type="button" class="prov-item is-editing" disabled>
          <span class="prov-dot"></span>
          <span class="prov-item-body">
            <span class="prov-item-name">{{ form.name || '新供应商' }}</span>
            <span class="prov-item-sub">尚未保存</span>
          </span>
        </button>
      </div>

      <template v-if="presets.length">
        <div class="prov-rail-sub">快速预设</div>
        <div class="prov-list prov-presets">
          <button
            v-for="p in presets"
            :key="p.id"
            type="button"
            class="prov-item"
            :class="{ 'is-editing': !isNew && editingId === p.id }"
            @click="selectProvider(p.id)"
          >
            <span class="prov-dot"></span>
            <span class="prov-item-body">
              <span class="prov-item-name">{{ p.name }}</span>
              <span class="prov-item-sub">点击填入预设</span>
            </span>
          </button>
        </div>
      </template>
    </aside>

    <form novalidate class="prov-form" @submit.prevent="act(true)">
      <div class="field-grid">
        <label class="field">
          <span class="field-label">配置标识</span>
          <input v-model="form.id" maxlength="40" placeholder="例如 openrouter / deepseek" autocomplete="off" spellcheck="false">
        </label>
        <label class="field">
          <span class="field-label">显示名称</span>
          <input v-model="form.name" maxlength="60" placeholder="例如 OpenRouter" autocomplete="off">
        </label>
      </div>

      <div class="field-grid">
        <div class="field">
          <span class="field-label">API 协议</span>
          <SelectMenu :model-value="form.api" :options="apiOptions" aria-label="API 协议" @update:model-value="v => form.api = String(v)" />
        </div>
        <label class="field">
          <span class="field-label">API 根地址</span>
          <input v-model="form.baseUrl" type="url" inputmode="url" placeholder="https://api.example.com/v1" autocomplete="off" spellcheck="false">
        </label>
      </div>

      <div class="field">
        <span class="field-label">API 密钥</span>
        <div class="key-row">
          <input
            v-model="form.apiKey"
            :type="showKey ? 'text' : 'password'"
            maxlength="1024"
            :placeholder="isSavedCurrent ? '留空保留已保存密钥，或输入新密钥覆盖' : '粘贴供应商 API Key'"
            autocomplete="new-password"
            spellcheck="false"
          >
          <button type="button" class="btn btn-quiet" @click="showKey = !showKey">{{ showKey ? '隐藏' : '显示' }}</button>
        </div>
        <p class="hint">密钥仅加密保存在服务端，不会回显到浏览器。</p>
      </div>

      <!-- Multi-model custom entry + auto-probe section -->
      <div class="field models-box">
        <div class="models-box-head">
          <div>
            <span class="field-label">启用模型列表</span>
            <span class="models-count">已启用 {{ form.models.length }} 个{{ form.model ? ` · 默认 ${form.model}` : '' }}</span>
          </div>
          <button type="button" class="btn btn-quiet btn-sm" :disabled="probing || busy" @click="probeModels">
            <span v-if="probing" class="spinner"></span>
            <Icon v-else name="refresh" :size="14" />
            <span>{{ probing ? '正在探测…' : '自动探测可用模型' }}</span>
          </button>
        </div>

        <!-- Custom model ID input -->
        <div class="custom-model-row">
          <input
            v-model="customModelInput"
            type="text"
            maxlength="320"
            placeholder="自定义模型 ID（支持逗号分隔多个，回车添加）"
            autocomplete="off"
            spellcheck="false"
            @keydown.enter.prevent="submitCustomModel"
          >
          <button type="button" class="btn btn-quiet btn-sm" :disabled="!customModelInput.trim()" @click="submitCustomModel">
            <Icon name="plus" :size="14" /><span>添加</span>
          </button>
        </div>

        <!-- Selected / enabled models -->
        <div v-if="form.models.length" class="enabled-models">
          <div
            v-for="m in form.models"
            :key="m"
            class="model-tag"
            :class="{ 'is-primary': form.model === m }"
          >
            <button type="button" class="model-tag-main" :title="form.model === m ? '当前默认模型' : '点击设为默认模型'" @click="setPrimaryModel(m)">
              <span class="model-tag-id">{{ m }}</span>
              <span v-if="form.model === m" class="model-tag-badge">默认</span>
            </button>
            <button type="button" class="model-tag-del" :aria-label="'移除 ' + m" title="移除" @click="toggleModel(m)">
              <Icon name="x" :size="12" />
            </button>
          </div>
        </div>
        <p v-else class="hint">尚未添加模型。可手动输入自定义模型 ID，或点击右上角“自动探测可用模型”勾选。</p>

        <div v-if="form.models.length" class="limits-box">
          <button type="button" class="link-btn limits-toggle" :aria-expanded="limitsOpen" @click="limitsOpen = !limitsOpen">
            <Icon name="chevron-right" :size="12" :class="{ 'is-open': limitsOpen }" />
            <span>模型参数：上下文、输出上限与价格</span>
          </button>
          <div v-if="limitsOpen" class="limits-table" role="table">
            <div class="limits-row is-head" role="row">
              <span role="columnheader">模型</span>
              <span v-for="f in limitFields" :key="f.key" role="columnheader">{{ f.label }}<small>{{ f.unit }}</small></span>
            </div>
            <div v-for="m in form.models" :key="m" class="limits-row" role="row">
              <span class="limits-id" :title="m">{{ m }}</span>
              <input v-for="f in limitFields" :key="f.key" v-model.number="limitRow(m)[f.key]" type="number" min="0" :step="f.unit === '$/M' ? '0.01' : '1024'" :placeholder="limitPlaceholder(m, f.key)" :aria-label="m + ' ' + f.label">
            </div>
            <p class="hint">留空使用推荐值（按模型系列推断）。输出上限超过供应商允许值会导致请求失败；填写价格后用量面板会显示费用。模型调用遇到限流、过载或 5xx 会自动重试 5 次。</p>
          </div>
        </div>

        <!-- Probed endpoint models checklist -->
        <div v-if="probeOpen && probedModels.length" class="probe-drawer">
          <div class="probe-toolbar">
            <div class="probe-search">
              <Icon name="search" :size="14" />
              <input v-model="probeQuery" type="text" placeholder="筛选探测到的模型…" autocomplete="off" spellcheck="false">
            </div>
            <div class="probe-actions">
              <button type="button" class="link-btn" @click="selectAllFiltered">全选({{ filteredProbed.length }})</button>
              <button type="button" class="link-btn" @click="clearProbedSelection">取消勾选</button>
              <button type="button" class="link-btn" @click="probeOpen = false">收起</button>
            </div>
          </div>
          <div class="probe-grid">
            <label v-for="m in filteredProbed" :key="m" class="probe-item" :class="{ 'is-checked': form.models.includes(m) }">
              <input type="checkbox" :checked="form.models.includes(m)" @change="toggleModel(m)">
              <span class="probe-id" :title="m">{{ m }}</span>
            </label>
            <p v-if="!filteredProbed.length" class="probe-empty">没有匹配的模型</p>
          </div>
        </div>
      </div>

      <div class="prov-checks">
        <label class="check"><input v-model="form.proxy" type="checkbox"><span>通过服务器 Mihomo 代理连接</span></label>
        <label class="check"><input v-model="form.reasoning" type="checkbox"><span>模型支持思考推理块 (Reasoning)</span></label>
      </div>

      <p v-if="status" class="provider-status" :class="statusTone">{{ status }}</p>

      <div class="prov-footer">
        <button v-if="canDelete" type="button" class="btn btn-quiet is-danger" :disabled="busy" @click="removeProvider">
          <Icon name="trash" :size="14" /><span>删除</span>
        </button>
        <span class="prov-spacer"></span>
        <button type="button" class="btn btn-quiet" :disabled="busy || probing" @click="act(false)">测试连接</button>
        <button type="submit" class="btn btn-solid" :disabled="busy || probing">保存并使用</button>
      </div>
    </form>
  </div>
</template>

<style>
.prov-wrap { display: grid; grid-template-columns: 216px minmax(0, 1fr); min-height: 100%; height: 100%; overflow: hidden; }
.prov-rail { display: flex; flex-direction: column; gap: 6px; padding: 14px 10px; border-right: 1px solid var(--line); background: color-mix(in srgb, var(--surface-2) 60%, var(--surface)); overflow-y: auto; }
.prov-rail-head { display: flex; align-items: center; justify-content: space-between; padding: 0 6px 2px; color: var(--muted); font-size: 11px; font-weight: 650; }
.prov-rail-sub { margin-top: 10px; padding: 0 6px 2px; color: var(--faint); font-size: 10.5px; font-weight: 650; }
.icon-btn-sm { width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; border-radius: 7px; color: var(--text-2); }
.icon-btn-sm:hover { background: color-mix(in srgb, var(--text) 7%, transparent); color: var(--text); }
.prov-empty { padding: 12px 8px; color: var(--muted); font-size: 12px; }
.prov-list { display: flex; flex-direction: column; gap: 3px; }
.prov-item { display: flex; align-items: center; gap: 8px; padding: 8px 9px; border-radius: 10px; border: 1px solid transparent; color: var(--text-2); text-align: left; transition: background-color var(--fast), border-color var(--fast); }
.prov-item:hover { background: color-mix(in srgb, var(--text) 5%, transparent); color: var(--text); }
.prov-item.is-editing { background: var(--surface); border-color: var(--line-strong); color: var(--text); box-shadow: var(--shadow-sm); }
.prov-dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--line-strong); }
.prov-item.is-active .prov-dot { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-soft); }
.prov-item-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.prov-item-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; font-weight: 580; }
.prov-item-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; color: var(--muted); font-family: var(--font-mono); }
.prov-active-tag { flex: none; font-size: 10px; color: var(--ok); font-weight: 650; }
.prov-switch-btn { flex: none; opacity: 0; padding: 2px 6px; border-radius: 6px; font-size: 10.5px; color: var(--text-2); background: color-mix(in srgb, var(--text) 7%, transparent); }
.prov-switch-btn.is-visible, .prov-item:hover .prov-switch-btn { opacity: 1; }
.shared-note { padding: 0 8px 8px; }
.prov-switch-btn:hover { background: var(--ink); color: var(--surface); }
.prov-presets .prov-item { opacity: 0.85; }

.prov-form { padding: 20px 24px 24px; overflow-y: auto; display: flex; flex-direction: column; gap: 16px; }
.prov-form .field-grid, .prov-form > .field { margin-top: 0; }
.key-row { display: flex; align-items: stretch; gap: 8px; }
.key-row input { flex: 1; min-width: 0; }
.btn-sm { min-height: 32px; padding: 0 11px; font-size: 12px; border-radius: 9px; }

.models-box { padding: 13px; border: 1px solid var(--line-2); border-radius: 13px; background: color-mix(in srgb, var(--surface-2) 50%, var(--surface)); gap: 10px; }
.models-box-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.models-box-head > div { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.models-count { color: var(--muted); font-size: 11px; font-family: var(--font-mono); }
.custom-model-row { display: flex; align-items: stretch; gap: 8px; }
.custom-model-row input { flex: 1; min-width: 0; min-height: 34px; padding: 6px 11px; font-family: var(--font-mono); font-size: 12.5px; background: var(--surface); }

.enabled-models { display: flex; flex-wrap: wrap; gap: 6px; }
.model-tag { display: inline-flex; align-items: center; max-width: 100%; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface); overflow: hidden; transition: border-color var(--fast); }
.model-tag.is-primary { border-color: var(--ink); background: color-mix(in srgb, var(--ink) 5%, var(--surface)); }
.model-tag-main { display: inline-flex; align-items: center; gap: 6px; min-width: 0; padding: 4px 8px; color: var(--text); font-size: 12px; font-family: var(--font-mono); }
.model-tag-id { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 240px; }
.model-tag-badge { flex: none; padding: 1px 5px; border-radius: 5px; background: var(--ink); color: var(--surface); font-family: var(--font-sans); font-size: 10px; font-weight: 600; }
.model-tag-del { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 26px; color: var(--muted); border-left: 1px solid var(--line); }
.model-tag-del:hover { background: var(--danger-soft); color: var(--danger); }

.limits-box { display: flex; flex-direction: column; gap: 8px; padding-top: 8px; border-top: 1px solid var(--line); }
.limits-toggle { align-self: flex-start; display: inline-flex; align-items: center; gap: 5px; }
.limits-toggle .is-open { transform: rotate(90deg); }
.limits-table { display: flex; flex-direction: column; gap: 4px; overflow-x: auto; }
.limits-row { display: grid; grid-template-columns: minmax(120px, 1.4fr) repeat(4, minmax(88px, 1fr)); gap: 6px; align-items: center; min-width: 520px; }
.limits-row.is-head span { color: var(--muted); font-size: 11px; font-weight: 600; }
.limits-row.is-head small { margin-left: 4px; color: var(--faint); font-weight: 500; }
.limits-id { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-size: 12px; color: var(--text); }
.limits-row input { min-width: 0; min-height: 30px; padding: 4px 8px; font-family: var(--font-mono); font-size: 12px; background: var(--surface); }
.probe-drawer { display: flex; flex-direction: column; gap: 8px; padding-top: 8px; border-top: 1px solid var(--line); }
.probe-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.probe-search { flex: 1; min-width: 160px; display: flex; align-items: center; gap: 7px; height: 32px; padding: 0 10px; border: 1px solid var(--line-2); border-radius: 8px; background: var(--surface); color: var(--muted); }
.probe-search:focus-within { border-color: var(--line-focus); }
.probe-search input { flex: 1; min-width: 0; min-height: 0; padding: 0; border: 0; outline: 0; background: transparent; color: var(--text); font-size: 12px; box-shadow: none !important; }
.probe-actions { display: flex; align-items: center; gap: 10px; }
.link-btn { color: var(--text-2); font-size: 11.5px; font-weight: 550; padding: 2px 4px; border-radius: 5px; }
.link-btn:hover { color: var(--text); background: color-mix(in srgb, var(--text) 6%, transparent); }
.probe-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 5px; max-height: 196px; overflow-y: auto; padding: 2px; }
.probe-item { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 6px 9px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); cursor: pointer; font-size: 12px; font-family: var(--font-mono); color: var(--text-2); transition: border-color var(--fast), background-color var(--fast); }
.probe-item:hover { border-color: var(--line-strong); color: var(--text); }
.probe-item.is-checked { border-color: var(--ink); background: color-mix(in srgb, var(--ink) 5%, var(--surface)); color: var(--text); }
.probe-id { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.probe-empty { grid-column: 1 / -1; margin: 8px 0; text-align: center; color: var(--muted); font-size: 12px; }

.prov-checks { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 14px; }
.check { display: inline-flex; align-items: center; gap: 8px; color: var(--text-2); font-size: 12.5px; cursor: pointer; user-select: none; }

.prov-footer { display: flex; align-items: center; gap: 9px; margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--line); }
.prov-spacer { flex: 1; }

@media (max-width: 720px) {
  .prov-wrap { grid-template-columns: minmax(0, 1fr); overflow-y: auto; }
  .prov-rail { border-right: 0; border-bottom: 1px solid var(--line); max-height: 170px; }
  .prov-form { overflow: visible; }
}
</style>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AnimatedSelect from './AnimatedSelect.vue'
import { confirmDialog } from '../composables/useConfirm'

interface Provider {
  id: string
  name: string
  api: string
  baseUrl: string
  model: string
  models: string[]
  proxy: boolean
  reasoning: boolean
  hasKey: boolean
  modelSettings?: Record<string, Record<string, number>>
}
interface Catalog {
  active: string
  activeModel: string
  providers: Provider[]
  quota: { daily_requests: number; daily_tokens: number }
  presets: { id: string; name: string; api: string; baseUrl: string; model?: string; models?: string[]; proxy?: boolean; reasoning?: boolean }[]
}
type Api = <T>(path: string, method?: string, data?: unknown) => Promise<T>

const props = defineProps<{ api: Api }>()
const catalog = ref<Catalog>()
const form = ref({
  id: '', name: '', api: 'openai-completions', baseUrl: '', model: '', models: [] as string[],
  proxy: false, reasoning: true, apiKey: '',
  modelSettings: {} as Record<string, Record<string, number | ''>>,
})
const saved = ref(false)
const formKey = ref(0)
const modelDraft = ref('')
const requestLimit = ref('0')
const tokenLimit = ref('0')
const discovered = ref<string[]>([])
const message = ref('')
const error = ref('')
const busy = ref('')
const apis = [
  { value: 'openai-completions', label: 'OpenAI Chat Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'google-generative-ai', label: 'Google Gemini' },
]
const limitFields = [
  { key: 'contextWindow', label: '上下文' },
  { key: 'maxTokens', label: '最大输出' },
  { key: 'input', label: '输入价' },
  { key: 'output', label: '输出价' },
]
const presetOptions = computed(() => [
  { value: '', label: '从常用供应商填入' },
  ...(catalog.value?.presets || [])
    .filter(item => !catalog.value?.providers.some(savedItem => savedItem.id === item.id))
    .map(item => ({ value: item.id, label: item.name })),
])
const limitsDirty = computed(() => !!catalog.value && (
  requestLimit.value.trim() !== String(catalog.value.quota.daily_requests) || tokenLimit.value.trim() !== String(catalog.value.quota.daily_tokens)))

function fill(value: Partial<Provider>, isSaved: boolean) {
  const models = value.models?.length ? [...value.models] : (value.model ? [value.model] : [])
  form.value = {
    id: value.id || '', name: value.name || '', api: value.api || 'openai-completions',
    baseUrl: value.baseUrl || '', model: value.model || models[0] || '', models,
    proxy: value.proxy === true, reasoning: value.reasoning !== false, apiKey: '',
    modelSettings: JSON.parse(JSON.stringify(value.modelSettings || {})),
  }
  saved.value = isSaved
  formKey.value++
  discovered.value = []
  modelDraft.value = ''
}
function selectProvider(id: string) {
  if (busy.value) return
  error.value = message.value = ''
  if (id === '__new__') {
    fill({ name: '自定义供应商', api: 'openai-completions', reasoning: true }, false)
    return
  }
  const current = catalog.value?.providers.find(item => item.id === id)
  if (current) fill(current, true)
}
function selectPreset(id: string) {
  if (busy.value) return
  const preset = catalog.value?.presets.find(item => item.id === id)
  if (preset) fill(preset, false)
}
function limitRow(id: string) { return (form.value.modelSettings[id] ||= {}) }
function addModel(value = modelDraft.value) {
  const id = value.trim()
  if (!id || form.value.models.includes(id)) return
  if (!/^[A-Za-z0-9_.:/-]{1,160}$/.test(id)) { error.value = '模型 ID 只能包含字母、数字和 _ . : / -'; return }
  if (form.value.models.length >= 80) { error.value = '每个供应商最多 80 个模型'; return }
  error.value = ''
  form.value.models.push(id)
  if (!form.value.model) form.value.model = id
  if (value === modelDraft.value) modelDraft.value = ''
}
function addDiscovered() {
  for (const id of discovered.value) if (form.value.models.length < 80) addModel(id)
}
function removeModel(id: string) {
  form.value.models = form.value.models.filter(item => item !== id)
  if (form.value.model === id) form.value.model = form.value.models[0] || ''
}
function payload() {
  const models = [...form.value.models]
  const primary = models.includes(form.value.model) ? form.value.model : models[0]
  const ordered = primary ? [primary, ...models.filter(item => item !== primary)] : models
  const modelSettings = Object.fromEntries(ordered.map(id => [id, Object.fromEntries(
    Object.entries(form.value.modelSettings[id] || {}).filter(([, value]) => value !== '' && value != null),
  )]).filter(([, value]) => Object.keys(value).length))
  return {
    id: form.value.id.trim(), name: form.value.name.trim(), api: form.value.api,
    baseUrl: form.value.baseUrl.trim(), model: primary || '', models: ordered,
    proxy: form.value.proxy, reasoning: form.value.reasoning, apiKey: form.value.apiKey, modelSettings,
  }
}
async function load() {
  catalog.value = await props.api<Catalog>('/api/admin/permissions/iris/providers')
  requestLimit.value = String(catalog.value.quota.daily_requests)
  tokenLimit.value = String(catalog.value.quota.daily_tokens)
  const current = catalog.value.providers.find(item => item.id === form.value.id)
    || catalog.value.providers.find(item => item.id === catalog.value?.active)
    || catalog.value.providers[0]
  if (current) fill(current, true)
}
async function work(label: string, action: () => Promise<void>) {
  if (busy.value) return
  busy.value = label
  error.value = ''
  message.value = ''
  try { await action() } catch (reason) { error.value = reason instanceof Error ? reason.message : '操作失败' }
  finally { busy.value = '' }
}
async function probe() {
  await work('probe', async () => {
    const result = await props.api<{ models?: string[]; detail?: string }>('/api/admin/permissions/iris/providers/models', 'POST', {
      config: { id: form.value.id.trim(), api: form.value.api, baseUrl: form.value.baseUrl.trim(), apiKey: form.value.apiKey, proxy: form.value.proxy },
    })
    discovered.value = result.models || []
    if (!discovered.value.length) throw new Error(result.detail || '未探测到模型，请手动填写模型 ID')
    message.value = `探测到 ${discovered.value.length} 个模型。`
  })
}
async function save() {
  await work('save', async () => {
    catalog.value = await props.api<Catalog>('/api/admin/permissions/iris/providers', 'POST', { config: payload() })
    const current = catalog.value.providers.find(item => item.id === form.value.id.trim())
    if (current) fill(current, true)
    message.value = '共享供应商已保存。'
  })
}
async function remove() {
  if (!saved.value) return
  if (!(await confirmDialog({ title: '删除共享供应商', message: `删除 ${form.value.name || form.value.id} 后，正在使用它的会话会停止。`, danger: true, confirmText: '删除' }))) return
  await work('delete', async () => {
    const id = form.value.id
    catalog.value = await props.api<Catalog>('/api/admin/permissions/iris/providers/delete', 'POST', { id })
    const next = catalog.value.providers.find(item => item.id === catalog.value?.active) || catalog.value.providers[0]
    if (next) fill(next, true)
    message.value = '已删除。'
  })
}
async function makeDefault() {
  await work('default', async () => {
    await props.api('/api/admin/permissions/iris/providers/default', 'POST', { id: form.value.id, model: form.value.model })
    await load()
    message.value = '已设为尚未自选模型的用户的默认项。'
  })
}
async function test() {
  await work('test', async () => {
    const result = await props.api<{ detail?: string; ok?: boolean; route?: string }>('/api/admin/permissions/iris/providers/test', 'POST', { config: payload() })
    if (result.ok === false) throw new Error(result.detail || '测试未通过')
    message.value = [result.detail || '测试完成', result.route].filter(Boolean).join(' · ')
  })
}
async function saveLimits() {
  await work('limits', async () => {
    const quota = { daily_requests: Number(requestLimit.value), daily_tokens: Number(tokenLimit.value) }
    if (![quota.daily_requests, quota.daily_tokens].every(value => Number.isInteger(value) && value >= 0)) {
      throw new Error('默认限额需为非负整数，0 表示不限制')
    }
    const result = await props.api<{ quota: Catalog['quota'] }>('/api/admin/permissions/iris/providers/quota', 'PUT', quota)
    if (catalog.value) catalog.value.quota = result.quota
    message.value = '默认每日限额已保存。'
  })
}
onMounted(() => work('load', load))
</script>

<template>
  <section class="admin-panel models">
    <div class="section-head">
      <div class="head-copy">
        <h2>共享模型</h2>
        <p class="field-hint">供应商可供所有已授权用户使用，密钥只保存在 Iris 服务上。用户自己的个人供应商不计入限额。</p>
      </div>
    </div>
    <p v-if="error" class="panel-note is-error" role="alert">{{ error }}</p>
    <p v-else-if="message" class="panel-note" role="status">{{ message }}</p>
    <p v-if="busy === 'load' && !catalog" class="subtle" role="status">正在读取共享模型…</p>
    <template v-if="catalog">
      <form class="quota-bar" @submit.prevent="saveLimits">
        <strong>默认每日限额</strong>
        <label class="unit-field"><span class="sr-only">每人每日请求数</span>
          <input v-model="requestLimit" inputmode="numeric" :disabled="!!busy" aria-label="每人每日请求数"><em>次请求 / 人</em>
        </label>
        <label class="unit-field"><span class="sr-only">每人每日 token</span>
          <input v-model="tokenLimit" inputmode="numeric" :disabled="!!busy" aria-label="每人每日 token"><em>token / 人</em>
        </label>
        <span class="field-hint">0 表示不限制 · 管理员同样受限 · 按上海时间自然日重置</span>
        <button :class="{ primary: limitsDirty }" :disabled="!!busy || !limitsDirty">{{ busy === 'limits' ? '保存中…' : '保存限额' }}</button>
      </form>

      <div class="models-layout">
        <nav class="provider-list" aria-label="共享供应商">
          <button v-for="item in catalog.providers" :key="item.id" type="button" class="provider-item"
            :aria-current="saved && form.id === item.id ? 'true' : undefined" :disabled="!!busy" @click="selectProvider(item.id)">
            <span class="provider-name">{{ item.name }}<i v-if="catalog.active === item.id" class="tag accent">默认</i></span>
            <span class="provider-meta">{{ item.id }} · {{ item.models.length || 1 }} 个模型<template v-if="!item.hasKey"> · 缺密钥</template></span>
          </button>
          <p v-if="!catalog.providers.length" class="field-hint empty">还没有共享供应商。</p>
          <button type="button" class="provider-item new" :aria-current="!saved ? 'true' : undefined" :disabled="!!busy" @click="selectProvider('__new__')">
            <span class="provider-name">＋ 新建供应商</span>
          </button>
          <AnimatedSelect v-if="presetOptions.length > 1" class="preset" model-value="" label="从预设新建" :options="presetOptions" :disabled="!!busy" @update:model-value="selectPreset" />
        </nav>

        <form class="edit-card provider-form" @submit.prevent="save">
          <header class="form-head">
            <div>
              <h3>{{ form.name || '未命名供应商' }}</h3>
              <span class="field-hint">{{ saved ? (catalog.active === form.id ? `当前默认：${catalog.activeModel}` : '已保存的共享供应商') : '新供应商，保存后生效' }}</span>
            </div>
            <div class="buttons">
              <button type="button" :disabled="!!busy" @click="test">{{ busy === 'test' ? '测试中…' : '测试连接' }}</button>
              <button type="button" :disabled="!!busy || !saved || !form.model || (catalog.active === form.id && catalog.activeModel === form.model)" @click="makeDefault">设为默认</button>
              <button class="danger" type="button" :disabled="!!busy || !saved" @click="remove">删除</button>
              <button class="primary" :disabled="!!busy">{{ busy === 'save' ? '保存中…' : '保存' }}</button>
            </div>
          </header>

          <fieldset class="conn-fields" :disabled="!!busy">
            <label>标识<input v-model="form.id" maxlength="40" required :disabled="saved || !!busy" autocomplete="off" spellcheck="false" placeholder="deepseek"></label>
            <label>名称<input v-model="form.name" maxlength="60" required placeholder="DeepSeek"></label>
            <AnimatedSelect v-model="form.api" class="api-field" label="协议" :options="apis" :disabled="!!busy" />
            <label class="wide">地址<input v-model="form.baseUrl" type="url" required spellcheck="false" placeholder="https://api.example.com/v1"></label>
            <label class="key-field">密钥<input v-model="form.apiKey" type="password" autocomplete="new-password" :placeholder="saved ? '留空则保留原密钥' : '必填'"></label>
            <div class="toggles">
              <label class="switch"><input v-model="form.proxy" type="checkbox"><span>经服务器代理</span></label>
              <label class="switch"><input v-model="form.reasoning" type="checkbox"><span>支持思考</span></label>
            </div>
          </fieldset>

          <div :key="formKey" class="model-table" role="table" aria-label="模型与限制">
            <div class="model-row head" role="row">
              <span role="columnheader">模型</span>
              <span v-for="field in limitFields" :key="field.key" role="columnheader">{{ field.label }}</span>
              <span role="columnheader" class="sr-only">操作</span>
            </div>
            <TransitionGroup name="row">
              <div v-for="id in form.models" :key="id" class="model-row" role="row" :class="{ primary: form.model === id }">
                <label class="model-id" role="cell" :title="form.model === id ? '默认模型' : '设为默认模型'">
                  <input v-model="form.model" type="radio" name="primary-model" :value="id" :disabled="!!busy">
                  <code>{{ id }}</code><i v-if="form.model === id" class="tag accent">默认</i>
                </label>
                <span v-for="field in limitFields" :key="field.key" role="cell" class="limit-cell" :data-label="field.label">
                  <input v-model="limitRow(id)[field.key]" inputmode="decimal" :disabled="!!busy" placeholder="自动" :aria-label="`${id} ${field.label}`">
                </span>
                <span role="cell"><button type="button" class="ghost" :disabled="!!busy" :aria-label="`移除 ${id}`" @click="removeModel(id)">移除</button></span>
              </div>
            </TransitionGroup>
            <p v-if="!form.models.length" class="field-hint empty">还没有模型。手动添加，或填好地址和密钥后探测。</p>
            <div class="model-add">
              <input v-model="modelDraft" placeholder="输入模型 ID 后回车" :disabled="!!busy" spellcheck="false" @keydown.enter.prevent="addModel()">
              <button type="button" :disabled="!!busy || !modelDraft.trim()" @click="addModel()">添加</button>
              <button type="button" :disabled="!!busy || !form.baseUrl" @click="probe">{{ busy === 'probe' ? '探测中…' : '探测模型' }}</button>
            </div>
          </div>
          <div v-if="discovered.length" class="discovered">
            <div class="discovered-head"><span class="field-hint">探测到 {{ discovered.length }} 个模型，点击加入</span>
              <button type="button" class="ghost" @click="addDiscovered">全部加入</button>
              <button type="button" class="ghost" @click="discovered = []">收起</button></div>
            <div class="chips">
              <button v-for="id in discovered" :key="id" type="button" :disabled="form.models.includes(id)" @click="addModel(id)">{{ id }}</button>
            </div>
          </div>
          <p class="field-hint foot">价格单位为每百万 token，留空则按模型系列默认值。单选按钮标记默认模型。</p>
        </form>
      </div>
    </template>
    <button v-else-if="busy !== 'load'" type="button" @click="work('load', load)">重试</button>
  </section>
</template>

<style scoped>
.head-copy { display:grid; gap:4px; }
.panel-note { margin:-14px 0 14px; padding:7px 12px; border-left:2px solid var(--accent); background:var(--accent-soft); font-size:13px; }
.panel-note.is-error { border-color:#d15c5c; background:rgba(209,92,92,.07); }
.quota-bar { display:flex; flex-wrap:wrap; align-items:center; gap:10px 14px; padding:12px 16px; margin-bottom:16px; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--surface); }
.quota-bar strong { font-size:13px; font-weight:600; }
.quota-bar .field-hint { flex:1; min-width:180px; }
.unit-field { flex-direction:row !important; align-items:center; gap:8px !important; }
.unit-field input { width:96px !important; padding-block:5px !important; }
.unit-field em { font-style:normal; color:var(--muted); font-size:12px; font-weight:400; white-space:nowrap; }
.models-layout { display:grid; grid-template-columns:220px minmax(0,1fr); gap:16px; align-items:start; }
.provider-list { position:sticky; top:calc(var(--header-h, 64px) + 16px); display:grid; gap:4px; }
.admin-panel .provider-item { display:grid; gap:1px; width:100%; padding:9px 12px; border:1px solid transparent; border-radius:10px; background:none; text-align:left; transition:background .2s,border-color .2s; }
.admin-panel .provider-item:hover:not(:disabled) { background:var(--bg-tint); border-color:transparent; color:var(--text); }
.admin-panel .provider-item[aria-current="true"] { background:var(--surface); border-color:var(--line); box-shadow:0 1px 2px rgba(17,24,39,.04); }
.admin-panel .provider-item:disabled { cursor:default; opacity:1; }
.provider-name { display:flex; align-items:center; gap:6px; font-weight:600; font-size:13px; }
.provider-name .tag { margin:0; font-style:normal; }
.provider-meta { color:var(--muted); font-size:11.5px; font-weight:400; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.provider-item.new .provider-name { color:var(--muted); font-weight:500; }
.preset { margin-top:8px; }
.empty { margin:4px 2px; }
.admin-panel .provider-form { padding:18px 20px 16px; margin:0; }
.form-head { display:flex; flex-wrap:wrap; align-items:flex-start; justify-content:space-between; gap:12px; padding-bottom:14px; margin-bottom:14px; border-bottom:1px solid var(--line); }
.form-head h3 { margin:0 0 2px; font-size:16px; }
.form-head .buttons { gap:6px; }
.conn-fields { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px 12px; align-items:end; }
.conn-fields .wide { grid-column:span 2; }
.toggles { grid-column:1 / -1; display:flex; flex-wrap:wrap; gap:18px; padding-top:2px; }
.model-table { margin-top:16px; border:1px solid var(--line); border-radius:10px; overflow:hidden; }
.model-row { display:grid; grid-template-columns:minmax(180px,2fr) repeat(4,minmax(64px,1fr)) 52px; align-items:center; gap:8px; padding:5px 10px; border-bottom:1px solid var(--line); transition:background .2s; }
.model-row.head { padding-block:7px; background:var(--bg-tint); color:var(--muted); font-size:11.5px; font-weight:500; }
.model-row:not(.head):hover { background:color-mix(in srgb,var(--bg-tint) 60%,transparent); }
.model-row.primary { background:var(--accent-soft); }
.admin-panel .model-id { flex-direction:row; align-items:center; gap:8px; min-width:0; cursor:pointer; font-weight:400; }
.model-id input { flex:none; width:14px; height:14px; margin:0; accent-color:var(--accent); }
.model-id code { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.model-id .tag { margin:0; font-style:normal; flex:none; }
.admin-panel .model-table .model-row input:not([type=radio]):not([type=checkbox]) { padding:4px 8px; font-size:12.5px; border-radius:7px; }
.admin-panel button.ghost { padding:4px 8px; border-color:transparent; background:none; color:var(--muted); font-size:12px; }
.admin-panel button.ghost:hover:not(:disabled) { color:var(--text); border-color:var(--line); }
.model-add { display:grid; grid-template-columns:minmax(0,1fr) auto auto; gap:8px; padding:8px 10px; background:color-mix(in srgb,var(--bg-tint) 50%,transparent); }
.admin-panel .model-table .model-add input:not([type=radio]):not([type=checkbox]) { padding:5px 10px; font-size:13px; }
.admin-panel .model-add button { padding:5px 12px; font-size:12.5px; }
.model-table .empty { padding:10px 12px; margin:0; border-bottom:1px solid var(--line); }
.discovered { margin-top:10px; padding:10px 12px; border:1px dashed var(--line-strong); border-radius:10px; }
.discovered-head { display:flex; align-items:center; gap:4px; margin-bottom:8px; }
.discovered-head .field-hint { flex:1; }
.chips { display:flex; flex-wrap:wrap; gap:6px; max-height:180px; overflow:auto; }
.admin-panel .chips button { padding:4px 10px; border-radius:999px; font:12px var(--font-mono); }
.admin-panel .chips button:disabled { opacity:.35; cursor:default; }
.foot { margin:10px 0 0; }
.row-enter-active, .row-leave-active { transition:opacity .22s var(--ease), transform .22s var(--ease); }
.row-enter-from, .row-leave-to { opacity:0; transform:translateY(-4px); }
@media (max-width:900px) {
  .models-layout { grid-template-columns:1fr; }
  .provider-list { position:static; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); }
  .preset { grid-column:1 / -1; }
}
@media (max-width:700px) {
  .conn-fields { grid-template-columns:1fr 1fr; }
  .conn-fields .wide, .conn-fields .api-field, .conn-fields .key-field { grid-column:1 / -1; }
  .model-row { grid-template-columns:repeat(4,minmax(0,1fr)); }
  .model-row.head { display:none; }
  .model-row .model-id { grid-column:1 / -2; }
  .model-row > span:last-child { grid-column:-2 / -1; grid-row:1; justify-self:end; }
  .limit-cell { display:grid; gap:2px; }
  .limit-cell::before { content:attr(data-label); color:var(--muted); font-size:11px; }
  .unit-field input { width:80px !important; }
}
</style>

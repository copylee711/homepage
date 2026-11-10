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
const providerOptions = computed(() => [
  ...(catalog.value?.providers || []).map(item => ({ value: item.id, label: item.name })),
  { value: '__new__', label: '新建供应商' },
])
const presetOptions = computed(() => [
  { value: '', label: '从常用供应商填入' },
  ...(catalog.value?.presets || [])
    .filter(item => !catalog.value?.providers.some(savedItem => savedItem.id === item.id))
    .map(item => ({ value: item.id, label: item.name })),
])
const modelOptions = computed(() => form.value.models.map(id => ({ value: id, label: id })))

function fill(value: Partial<Provider>, isSaved: boolean) {
  const models = value.models?.length ? [...value.models] : (value.model ? [value.model] : [])
  form.value = {
    id: value.id || '', name: value.name || '', api: value.api || 'openai-completions',
    baseUrl: value.baseUrl || '', model: value.model || models[0] || '', models,
    proxy: value.proxy === true, reasoning: value.reasoning !== false, apiKey: '',
    modelSettings: JSON.parse(JSON.stringify(value.modelSettings || {})),
  }
  saved.value = isSaved
  discovered.value = []
  modelDraft.value = ''
}
function selectProvider(id: string) {
  if (id === '__new__') {
    fill({ name: '自定义供应商', api: 'openai-completions', reasoning: true }, false)
    return
  }
  const current = catalog.value?.providers.find(item => item.id === id)
  if (current) fill(current, true)
}
function selectPreset(id: string) {
  const preset = catalog.value?.presets.find(item => item.id === id)
  if (preset) fill(preset, false)
}
function limitRow(id: string) { return (form.value.modelSettings[id] ||= {}) }
function addModel() {
  const id = modelDraft.value.trim()
  if (!/^[A-Za-z0-9_.:/-]{1,160}$/.test(id) || form.value.models.includes(id) || form.value.models.length >= 80) return
  form.value.models.push(id)
  if (!form.value.model) form.value.model = id
  modelDraft.value = ''
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
  <section class="admin-panel">
    <div class="section-head"><h2>共享模型</h2></div>
    <p class="subtle">这里配置的供应商可供所有已获得执行权限的用户使用。密钥只留在 Iris 服务上。个人供应商仍由用户在 Iris 设置里自己保存，不计入下面的限额。</p>
    <p v-if="error" class="subtle" role="alert">{{ error }}</p>
    <p v-else-if="message" class="subtle" role="status">{{ message }}</p>
    <p v-if="busy === 'load'" class="subtle" role="status">正在读取共享模型…</p>
    <template v-else-if="catalog">
      <form class="edit-card" @submit.prevent="saveLimits">
        <h3>默认每日限额</h3>
        <fieldset class="model-fields" :disabled="!!busy">
          <label>每人每日请求数<input v-model="requestLimit" inputmode="numeric"></label>
          <label>每人每日 token<input v-model="tokenLimit" inputmode="numeric"></label>
        </fieldset>
        <p class="subtle">0 表示不限制。管理员使用共享模型时同样受此限额约束。按上海时间的自然日计算。</p>
        <button class="primary" :disabled="!!busy">保存默认限额</button>
      </form>
      <form class="edit-card" @submit.prevent="save">
        <div class="model-fields">
          <AnimatedSelect :model-value="saved ? form.id : '__new__'" label="供应商" :options="providerOptions" @update:model-value="selectProvider" />
          <AnimatedSelect model-value="" label="预设" :options="presetOptions" @update:model-value="selectPreset" />
        </div>
        <fieldset class="model-fields" :disabled="!!busy">
          <label>标识<input v-model="form.id" maxlength="40" required :disabled="saved || !!busy" autocomplete="off" spellcheck="false"></label>
          <label>名称<input v-model="form.name" maxlength="60" required :disabled="!!busy"></label>
          <AnimatedSelect v-model="form.api" label="协议" :options="apis" />
          <label>地址<input v-model="form.baseUrl" type="url" required :disabled="!!busy" spellcheck="false"></label>
          <label>密钥<input v-model="form.apiKey" type="password" autocomplete="new-password" :placeholder="saved ? '留空则保留原密钥' : '必填'" :disabled="!!busy"></label>
          <label v-if="modelOptions.length">默认模型<AnimatedSelect v-model="form.model" label="默认模型" :options="modelOptions" /></label>
        </fieldset>
        <div class="model-list">
          <span>模型</span>
          <ul>
            <li v-for="id in form.models" :key="id"><code>{{ id }}</code><button type="button" :disabled="!!busy" @click="removeModel(id)">移除</button></li>
          </ul>
          <div class="model-add">
            <input v-model="modelDraft" placeholder="模型 ID" :disabled="!!busy" @keydown.enter.prevent="addModel">
            <button type="button" :disabled="!!busy" @click="addModel">添加</button>
            <button type="button" :disabled="!!busy" @click="probe">探测</button>
          </div>
          <ul v-if="discovered.length">
            <li v-for="id in discovered" :key="id"><button type="button" :disabled="form.models.includes(id)" @click="modelDraft = id; addModel()">{{ id }}</button></li>
          </ul>
        </div>
        <div v-if="form.models.length" class="limits">
          <div v-for="id in form.models" :key="id" class="limit-row">
            <code>{{ id }}</code>
            <label v-for="field in limitFields" :key="field.key">{{ field.label }}
              <input v-model="limitRow(id)[field.key]" inputmode="decimal" :disabled="!!busy">
            </label>
          </div>
        </div>
        <label class="check"><input v-model="form.proxy" type="checkbox" :disabled="!!busy">通过服务器代理连接</label>
        <label class="check"><input v-model="form.reasoning" type="checkbox" :disabled="!!busy">支持思考推理</label>
        <div class="buttons">
          <button class="primary" :disabled="!!busy">保存</button>
          <button type="button" :disabled="!!busy" @click="test">测试</button>
          <button type="button" :disabled="!!busy || !saved || !form.model" @click="makeDefault">设为默认模型</button>
          <button class="danger" type="button" :disabled="!!busy || !saved" @click="remove">删除</button>
        </div>
        <p v-if="catalog.active === form.id" class="subtle">当前默认模型：{{ catalog.activeModel }}</p>
      </form>
    </template>
    <button v-else type="button" @click="work('load', load)">重试</button>
  </section>
</template>

<style scoped>
h3 { margin: 0 0 12px; font-size: 17px; }
.model-fields, .model-add, .limit-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr)); gap: 12px; }
.model-list, .limits { display: grid; gap: 8px; margin: 12px 0; }
.model-list ul { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
.limit-row { align-items: end; margin-bottom: 8px; }
.check { display: flex; gap: 8px; align-items: center; margin: 8px 0; }
</style>

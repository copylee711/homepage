<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { confirmDialog } from '../composables/useConfirm'
import { formatSize } from '../drive'
import { irisQuotaFields, type IrisQuota as Quota, type IrisQuotaDefaults } from '../irisQuota'

type User = { id: string; name: string; email: string; disabled: boolean; admin: boolean; expires_at: number | null }
type QuotaState = IrisQuotaDefaults & { used_bytes: number | null }
const props = defineProps<{ api: <T>(path: string, method?: string, data?: unknown) => Promise<T>; query: string }>()
const emit = defineEmits<{ notify: [text: string]; fail: [text: string] }>()

const base = '/api/admin/permissions/iris'
const users = ref<User[] | null>(null), enabled = ref(false), busy = ref(false)
const duration = ref('7')
const durations = [{ value: '1', label: '1 天' }, { value: '7', label: '7 天' }, { value: '30', label: '30 天' }]
const selected = ref<User>(), quotaData = ref<QuotaState>(), draft = ref<Quota>()
const quotaError = ref('')
type ModelQuota = { defaults: { daily_requests: number; daily_tokens: number }; override: { daily_requests: number | null; daily_tokens: number | null }; limits: { daily_requests: number; daily_tokens: number }; used: { requests: number; tokens: number } }
const modelUser = ref<User>(), modelQuota = ref<ModelQuota>()
const requestDraft = ref(''), tokenDraft = ref(''), modelError = ref('')
const shown = computed(() => users.value?.filter(user => `${user.name} ${user.email}`.toLowerCase().includes(props.query)) ?? [])
const active = (user: User) => (user.expires_at ?? 0) > Date.now() / 1000
const date = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
const compact = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 })
const counts = computed(() => {
  const list = users.value ?? []
  return { active: list.filter(user => !user.disabled && !user.admin && active(user)).length, total: list.length }
})
function stateTone(user: User) {
  if (user.disabled) return 'off'
  if (user.admin || active(user)) return 'on'
  return user.expires_at ? 'warn' : 'off'
}
function remaining(user: User) {
  if (!active(user) || !user.expires_at) return ''
  const hours = (user.expires_at - Date.now() / 1000) / 3600
  return hours >= 24 ? `剩 ${Math.floor(hours / 24)} 天` : `剩 ${Math.max(1, Math.floor(hours))} 小时`
}
const usagePct = (used: number, limit: number) => limit > 0 ? Math.min(100, used / limit * 100) : 0
function stateText(user: User) {
  if (user.disabled) return '账户已停用'
  if (user.admin) return '管理员 · 始终可执行'
  if (active(user) && user.expires_at) return `至 ${date.format(user.expires_at * 1000)}`
  return user.expires_at ? '授权已过期' : '未授权'
}

async function work(task: () => Promise<void>, onError = (text: string) => emit('fail', text)) {
  if (busy.value) return
  busy.value = true
  try { await task() }
  catch (err) { onError(err instanceof Error ? err.message : '操作失败') }
  finally { busy.value = false }
}
async function load() {
  const result = await props.api<{ users: User[]; enabled: boolean }>(base + '/grants')
  users.value = result.users
  enabled.value = result.enabled
}
const change = (user: User, days: number) => work(async () => {
  if (!days && !await confirmDialog({
    title: `撤销 ${user.name} 的执行权限？`, message: '正在执行的 Iris 任务会停止。',
    confirmText: '撤销权限', danger: true,
  })) return
  const result = await props.api<{ expires_at: number | null; abort_pending?: boolean }>(
    base + '/grants', 'POST', { user_id: user.id, days },
  )
  user.expires_at = result.expires_at
  emit('notify', days ? '执行授权已保存。' : result.abort_pending
    ? '授权已撤销。暂未联系上 Iris，任务将在服务复查授权时停止。' : '执行权限已撤销。')
})
function setQuota(data: QuotaState) {
  quotaData.value = data
  draft.value = { ...data.quota }
}
function closeQuota() {
  selected.value = undefined
  quotaData.value = draft.value = undefined
  quotaError.value = ''
}
function closeModel() {
  modelUser.value = undefined
  modelQuota.value = undefined
  modelError.value = ''
}
function optionalNumber(value: string) {
  const text = value.trim()
  if (!text) return null
  if (!/^\d+$/.test(text)) throw new Error('限额需为非负整数，留空表示沿用默认')
  return Number(text)
}
const readQuota = (user: User) => work(async () => {
  closeModel()
  selected.value = user
  quotaError.value = ''
  setQuota(await props.api<QuotaState>(base + '/quota?user_id=' + encodeURIComponent(user.id)))
}, text => { quotaError.value = text })
const saveQuota = () => work(async () => {
  if (!selected.value || !draft.value || !quotaData.value) return
  quotaError.value = ''
  const quota = { ...draft.value }
  if (quota.disk_mib < quotaData.value.quota.disk_mib && !await confirmDialog({
    title: '缩小工作区磁盘？', message: '系统会离线检查并调整文件系统。现有数据无法容纳时，操作会被拒绝。',
    confirmText: '继续保存', danger: true,
  })) return
  setQuota(await props.api<QuotaState>(base + '/quota', 'POST', { user_id: selected.value.id, quota }))
  emit('notify', '沙箱配额已保存。')
}, text => { quotaError.value = text })
const readModel = (user: User) => work(async () => {
  closeQuota()
  modelUser.value = user
  modelError.value = ''
  modelQuota.value = await props.api<ModelQuota>(base + '/model-quota?user_id=' + encodeURIComponent(user.id))
  requestDraft.value = modelQuota.value.override.daily_requests == null ? '' : String(modelQuota.value.override.daily_requests)
  tokenDraft.value = modelQuota.value.override.daily_tokens == null ? '' : String(modelQuota.value.override.daily_tokens)
}, text => { modelError.value = text })
const saveModel = () => work(async () => {
  if (!modelUser.value) return
  modelError.value = ''
  modelQuota.value = await props.api<ModelQuota>(base + '/model-quota', 'POST', {
    user_id: modelUser.value.id,
    daily_requests: optionalNumber(requestDraft.value),
    daily_tokens: optionalNumber(tokenDraft.value),
  })
  emit('notify', '模型限额已保存。')
}, text => { modelError.value = text })
onMounted(() => work(load))
</script>

<template>
  <section class="admin-panel iris">
    <div class="section-head">
      <div class="head-copy">
        <h2>Iris 执行与配额</h2>
        <p class="field-hint">{{ users ? (enabled ? `${counts.active} 位普通用户持有有效授权，共 ${counts.total} 个账户。续期从保存时重新计算。` : '普通用户执行开关尚未开启，暂时无法新增或续期授权。') : '读取中…' }}</p>
      </div>
      <div class="buttons">
        <div v-if="users && enabled" class="duration" role="radiogroup" aria-label="授予与续期时长">
          <span>时长</span>
          <button v-for="item in durations" :key="item.value" type="button" role="radio" :aria-checked="duration === item.value"
            @click="duration = item.value">{{ item.label }}</button>
        </div>
        <button type="button" :disabled="busy" @click="work(load)">刷新</button>
      </div>
    </div>
    <p v-if="!users && busy" class="subtle" role="status">正在读取执行授权…</p>
    <p v-if="users && !shown.length" class="subtle">{{ query ? '没有符合条件的用户。' : '暂无用户。' }}</p>
    <div v-if="users && shown.length" class="rows">
      <div class="row head" aria-hidden="true"><span>用户</span><span>执行授权</span><span>操作</span></div>
      <article v-for="user in shown" :key="user.id" class="row-wrap" :class="{ open: selected?.id === user.id || modelUser?.id === user.id, muted: user.disabled }">
        <div class="row">
          <div class="identity"><strong>{{ user.name }}</strong><span>{{ user.email }}</span></div>
          <div class="grant"><i class="dot" :class="stateTone(user)" /><span>{{ stateText(user) }}</span><em v-if="remaining(user)">{{ remaining(user) }}</em></div>
          <div class="actions">
            <template v-if="!user.disabled && !user.admin">
              <button type="button" :class="{ primary: !active(user) }" :disabled="busy || !enabled" @click="change(user, Number(duration))">{{ active(user) ? '续期' : '授权' }}</button>
              <button v-if="active(user)" type="button" class="danger" :disabled="busy" @click="change(user, 0)">撤销</button>
            </template>
            <button type="button" :class="{ selected: selected?.id === user.id }" :aria-expanded="selected?.id === user.id" :disabled="busy"
              @click="selected?.id === user.id ? closeQuota() : readQuota(user)">沙箱</button>
            <button type="button" :class="{ selected: modelUser?.id === user.id }" :aria-expanded="modelUser?.id === user.id" :disabled="busy"
              @click="modelUser?.id === user.id ? closeModel() : readModel(user)">模型</button>
          </div>
        </div>
        <Transition name="expand">
          <div v-if="selected?.id === user.id" class="detail">
            <p v-if="quotaError" role="alert" class="detail-error">{{ quotaError }}</p>
            <form v-if="draft && quotaData" @submit.prevent="saveQuota">
              <fieldset class="quota-fields" :disabled="busy">
                <label v-for="field in irisQuotaFields" :key="field.key">{{ field.label }}
                  <input v-model.number="draft[field.key]" type="number" required :step="field.step"
                    :min="quotaData.ranges[field.key][0]" :max="quotaData.ranges[field.key][1]">
                </label>
                <button class="primary" type="submit" :disabled="busy">{{ busy ? '处理中…' : '保存' }}</button>
              </fieldset>
              <p class="field-hint">{{ quotaData.used_bytes === null ? '工作区尚未挂载' : `工作区已用 ${formatSize(quotaData.used_bytes)}` }} · 主机磁盘总预算 {{ formatSize(quotaData.total_disk_budget_mib * 1024 * 1024) }}</p>
            </form>
            <p v-else-if="busy" class="field-hint" role="status">正在读取沙箱配额…</p>
            <button v-else type="button" @click="readQuota(user)">重试</button>
          </div>
        </Transition>
        <Transition name="expand">
          <div v-if="modelUser?.id === user.id" class="detail">
            <p v-if="modelError" role="alert" class="detail-error">{{ modelError }}</p>
            <form v-if="modelQuota" @submit.prevent="saveModel">
              <div class="meters">
                <div class="meter"><span>今日请求</span><strong>{{ modelQuota.used.requests }}<small> / {{ modelQuota.limits.daily_requests || '不限' }}</small></strong>
                  <i><b :style="{ width: usagePct(modelQuota.used.requests, modelQuota.limits.daily_requests) + '%' }" /></i></div>
                <div class="meter"><span>今日 token</span><strong>{{ compact.format(modelQuota.used.tokens) }}<small> / {{ modelQuota.limits.daily_tokens ? compact.format(modelQuota.limits.daily_tokens) : '不限' }}</small></strong>
                  <i><b :style="{ width: usagePct(modelQuota.used.tokens, modelQuota.limits.daily_tokens) + '%' }" /></i></div>
              </div>
              <fieldset class="quota-fields" :disabled="busy">
                <label>每日请求数<input v-model="requestDraft" inputmode="numeric" :placeholder="`默认 ${modelQuota.defaults.daily_requests || '不限'}`"></label>
                <label>每日 token<input v-model="tokenDraft" inputmode="numeric" :placeholder="`默认 ${modelQuota.defaults.daily_tokens || '不限'}`"></label>
                <button class="primary" type="submit" :disabled="busy">{{ busy ? '处理中…' : '保存' }}</button>
              </fieldset>
              <p class="field-hint">留空沿用默认限额，0 表示不限制。</p>
            </form>
            <p v-else-if="busy" class="field-hint" role="status">正在读取模型用量…</p>
            <button v-else type="button" @click="readModel(user)">重试</button>
          </div>
        </Transition>
      </article>
    </div>
  </section>
</template>

<style scoped>
.head-copy { display:grid; gap:4px; }
.duration { display:inline-flex; align-items:center; gap:2px; padding:3px; border:1px solid var(--line); border-radius:10px; }
.duration > span { padding:0 6px 0 4px; color:var(--muted); font-size:12px; }
.admin-panel .duration button { padding:4px 10px; border:0; border-radius:7px; background:none; color:var(--muted); font-size:12px; }
.admin-panel .duration button[aria-checked="true"] { background:var(--accent-soft); color:var(--accent); }
.rows { border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--surface); overflow:hidden; }
.row { display:grid; grid-template-columns:minmax(0,1.2fr) minmax(0,1fr) 250px; align-items:center; gap:12px; padding:9px 14px; }
.row.head { padding-block:8px; background:var(--bg-tint); color:var(--muted); font-size:12px; }
.row.head span:last-child { text-align:right; }
.row-wrap { border-top:1px solid var(--line); transition:background .2s; }
.row-wrap:hover, .row-wrap.open { background:color-mix(in srgb,var(--bg-tint) 55%,transparent); }
.row-wrap.muted .identity, .row-wrap.muted .grant { opacity:.55; }
.identity { display:grid; min-width:0; line-height:1.35; }
.identity strong { font-size:13.5px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.identity span { color:var(--muted); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.grant { display:flex; align-items:center; gap:7px; min-width:0; font-size:12.5px; color:var(--text-2); }
.grant span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.grant em { flex:none; padding:0 6px; border-radius:999px; background:var(--accent-soft); color:var(--accent); font-size:11px; font-style:normal; }
.dot { flex:none; width:7px; height:7px; border-radius:50%; background:var(--line-strong); }
.dot.on { background:#2f9e6b; box-shadow:0 0 0 3px rgba(47,158,107,.14); }
.dot.warn { background:#d39a2c; }
.actions { display:flex; justify-content:flex-end; gap:6px; }
.admin-panel .actions button { padding:5px 11px; font-size:12px; border-radius:8px; }
.detail { padding:4px 14px 14px; overflow:hidden; }
.detail-error { margin:0 0 8px; color:#d15c5c; font-size:12.5px; }
.quota-fields { display:flex; flex-wrap:wrap; gap:10px; align-items:flex-end; border:0; padding:0; margin:0; min-width:0; }
.admin-panel .quota-fields label { flex:1 1 130px; max-width:190px; }
.admin-panel .quota-fields label { font-size:12px; gap:4px; }
.admin-panel .quota-fields input { padding:6px 10px; font-size:13px; }
.admin-panel .quota-fields button { flex:none; padding:7px 18px; }
.detail .field-hint { display:block; margin-top:6px; }
.meters { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,320px)); gap:10px 28px; margin:2px 0 12px; }
.meter { display:grid; grid-template-columns:auto 1fr; align-items:baseline; gap:2px 10px; }
.meter span { color:var(--muted); font-size:12px; }
.meter strong { justify-self:end; font-size:14px; font-variant-numeric:tabular-nums; }
.meter small { color:var(--muted); font-weight:400; font-size:12px; }
.meter i { grid-column:1 / -1; height:4px; border-radius:999px; background:var(--bg-tint); overflow:hidden; }
.meter b { display:block; height:100%; border-radius:inherit; background:var(--accent); transition:width .5s var(--ease); }
.expand-enter-active, .expand-leave-active { transition:opacity .2s var(--ease), transform .2s var(--ease); }
.expand-enter-from, .expand-leave-to { opacity:0; transform:translateY(-4px); }
@media (max-width:700px) {
  .row.head { display:none; }
  .row { grid-template-columns:1fr auto; gap:6px 10px; }
  .admin-panel .quota-fields label { max-width:none; }
  .grant { grid-column:1; grid-row:2; }
  .actions { grid-column:2; grid-row:1 / span 2; flex-wrap:wrap; max-width:150px; }
}
</style>

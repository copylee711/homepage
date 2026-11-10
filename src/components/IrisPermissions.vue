<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { confirmDialog } from '../composables/useConfirm'
import { formatSize } from '../drive'
import { irisQuotaFields, type IrisQuota as Quota, type IrisQuotaDefaults } from '../irisQuota'
import AnimatedSelect from './AnimatedSelect.vue'

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
const shown = computed(() => users.value?.filter(user => `${user.name} ${user.email}`.toLowerCase().includes(props.query)) ?? [])
const active = (user: User) => (user.expires_at ?? 0) > Date.now() / 1000
const date = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
function stateText(user: User) {
  if (user.disabled) return '账户已停用'
  if (user.admin) return '管理员 · 已有执行权限'
  if (active(user) && user.expires_at) return `授权至 ${date.format(user.expires_at * 1000)}`
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
const readQuota = (user: User) => work(async () => {
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
onMounted(() => work(load))
</script>

<template>
  <section class="admin-panel">
    <div class="section-head">
      <h2>Iris 执行与配额</h2>
      <div class="buttons"><button type="button" :disabled="busy" @click="work(load)">刷新账户</button></div>
    </div>
    <p v-if="!users && busy" class="subtle" role="status">正在读取执行授权…</p>
    <p v-if="users" class="subtle">{{ enabled ? '普通用户获得限时授权后可执行工具。续期从保存时重新计算。' : '普通用户执行开关尚未开启，暂时无法新增或续期授权。' }}</p>
    <div v-if="users && enabled" class="duration">
      <AnimatedSelect v-model="duration" label="授予与续期时长" :options="durations" />
    </div>
    <p v-if="users && !shown.length" class="subtle">{{ query ? '没有符合条件的用户。' : '暂无用户。' }}</p>
    <article v-for="user in shown" :key="user.id" class="edit-card">
      <header class="iris-user">
        <div class="identity">
          <strong>{{ user.name }}</strong>
          <span class="field-hint">{{ user.email }}</span>
          <span class="grant-state">{{ stateText(user) }}</span>
        </div>
        <div class="buttons">
          <template v-if="!user.disabled && !user.admin">
            <button type="button" class="primary" :disabled="busy || !enabled" @click="change(user, Number(duration))">{{ active(user) ? '续期' : '授予执行权限' }}</button>
            <button v-if="active(user)" type="button" class="danger" :disabled="busy" @click="change(user, 0)">撤销</button>
          </template>
          <button type="button" :aria-expanded="selected?.id === user.id" :disabled="busy"
            @click="selected?.id === user.id ? closeQuota() : (closeQuota(), readQuota(user))">{{ selected?.id === user.id ? '收起配额' : '编辑配额' }}</button>
        </div>
      </header>
      <div v-if="selected?.id === user.id" class="quota">
        <p v-if="quotaError" role="alert" class="subtle">{{ quotaError }}</p>
        <template v-if="draft && quotaData">
          <p class="subtle">{{ quotaData.used_bytes === null ? '工作区尚未挂载' : `工作区已用 ${formatSize(quotaData.used_bytes)}` }} · 主机磁盘总预算 {{ formatSize(quotaData.total_disk_budget_mib * 1024 * 1024) }}</p>
          <form @submit.prevent="saveQuota">
            <fieldset class="quota-fields" :disabled="busy">
              <label v-for="field in irisQuotaFields" :key="field.key">{{ field.label }}
                <input v-model.number="draft[field.key]" type="number" required :step="field.step"
                  :min="quotaData.ranges[field.key][0]" :max="quotaData.ranges[field.key][1]">
              </label>
            </fieldset>
            <button class="primary" type="submit" :disabled="busy">{{ busy ? '处理中…' : '保存配额' }}</button>
          </form>
        </template>
        <p v-else-if="busy" role="status">正在读取沙箱配额…</p>
        <button v-else type="button" @click="readQuota(user)">重试</button>
      </div>
    </article>
  </section>
</template>

<style scoped>
.duration { width:min(100%, 190px); margin-bottom:18px; }
.iris-user { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:14px; }
.identity { display:grid; gap:2px; min-width:0; overflow-wrap:anywhere; }
.grant-state { margin-top:4px; color:var(--muted); font-size:13px; }
.quota { border-top:1px solid var(--line); margin-top:18px; padding-top:12px; }
.quota-fields { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,140px),1fr)); gap:12px; border:0; padding:0; margin:0 0 16px; min-width:0; }
</style>

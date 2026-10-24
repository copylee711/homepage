<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { formatSize } from '../drive'
import type { DriveMount, StorageSummary } from '../drive'
import '../styles/admin-panel.css'

type Row = { id: string; email: string; name: string; disabled: boolean; storage: StorageSummary; login: string; mounts: DriveMount[] }
type State = { users: Row[]; admin_images: number; image_count: number; oss_configured: boolean; connection: { sftp_host: string; sftp_port: number; dav_url: string } }
type Draft = { drive_enabled: boolean; images_enabled: boolean; quota_mb: number; max_image_mb: number; login: string }
const props = defineProps<{ api: <T>(path: string, method?: string, data?: unknown) => Promise<T> }>()
const emit = defineEmits<{ notify: [text: string]; fail: [text: string] }>()

const MiB = 1024 * 1024
const state = ref<State>()
const drafts = ref<Record<string, Draft>>({})
const mountForm = ref<Record<string, { path: string; location: string; quota_mb: number; read_only: boolean } | undefined>>({})
const filter = ref<'enabled' | 'all'>('enabled')
const busy = ref(false)

const shown = computed(() => (state.value?.users ?? []).filter(user => filter.value === 'all' || user.storage.drive_enabled || user.storage.images_enabled || user.storage.used))

function draftOf(user: Row): Draft {
  return { drive_enabled: user.storage.drive_enabled, images_enabled: user.storage.images_enabled,
    quota_mb: Math.round((user.storage.quota ?? 200 * MiB) / MiB), max_image_mb: Math.round(user.storage.max_image / MiB), login: user.login }
}
function replace(row: Row) {
  const users = state.value!.users
  users.splice(users.findIndex(user => user.id === row.id), 1, row)
  drafts.value[row.id] = draftOf(row)
}
async function work(task: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  try { await task() } catch (err) { emit('fail', err instanceof Error ? err.message : '操作失败') }
  finally { busy.value = false }
}
async function load() {
  state.value = await props.api<State>('/api/admin/storage')
  drafts.value = Object.fromEntries(state.value.users.map(user => [user.id, draftOf(user)]))
}
const savePlan = (user: Row) => work(async () => {
  const draft = drafts.value[user.id]!
  replace(await props.api<Row>(`/api/admin/storage/users/${user.id}`, 'PUT', { drive_enabled: draft.drive_enabled, images_enabled: draft.images_enabled, quota_mb: draft.quota_mb, max_image_mb: draft.max_image_mb }))
  emit('notify', `已保存 ${user.email} 的存储方案。`)
})
const saveLogin = (user: Row) => work(async () => {
  replace(await props.api<Row>(`/api/admin/storage/users/${user.id}/login`, 'PUT', { login: drafts.value[user.id]!.login }))
  emit('notify', `${user.email} 的 SFTP/WebDAV 登录名已更新。`)
})
const addMount = (user: Row) => work(async () => {
  const form = mountForm.value[user.id]!
  replace(await props.api<Row>(`/api/admin/storage/users/${user.id}/mounts`, 'POST', form))
  mountForm.value[user.id] = undefined
  emit('notify', `已为 ${user.email} 添加挂载点 ${form.path}。`)
})
const updateMount = (user: Row, mount: DriveMount, quotaMb: number, readOnly: boolean) => work(async () => {
  replace(await props.api<Row>(`/api/admin/storage/users/${user.id}/mounts/${mount.id}`, 'PUT', { quota_mb: quotaMb, read_only: readOnly }))
  emit('notify', `挂载点 ${mount.path} 已更新。`)
})
const removeMount = (user: Row, mount: DriveMount) => work(async () => {
  if (!confirm(`移除挂载点 ${mount.path}？只解除挂载，OSS 上的文件不会删除。`)) return
  replace(await props.api<Row>(`/api/admin/storage/users/${user.id}/mounts/${mount.id}/remove`, 'POST'))
  emit('notify', `挂载点 ${mount.path} 已移除。`)
})
const rescan = (user: Row) => work(async () => {
  replace(await props.api<Row>(`/api/admin/storage/users/${user.id}/rescan`, 'POST'))
  emit('notify', '用量已重新统计。')
})

onMounted(() => work(load))
</script>

<template>
  <section class="admin-panel storage">
    <div class="section-head"><div><p class="eyebrow">Storage</p><h1>网盘与图床</h1></div>
      <div class="buttons"><button :class="{ selected: filter === 'enabled' }" @click="filter = 'enabled'">已开通</button><button :class="{ selected: filter === 'all' }" @click="filter = 'all'">全部用户</button><button @click="work(load)">刷新</button></div></div>
    <p class="subtle">新注册用户默认没有网盘与图床，在这里逐个开通。网盘与图床共用总配额；单独设置配额的挂载点不计入总配额。管理员不受配额限制。</p>
    <p v-if="state" class="field-hint connection">SFTP：<code>{{ state.connection.sftp_host }}:{{ state.connection.sftp_port }}</code> · WebDAV：<code>{{ state.connection.dav_url }}</code> · OSS {{ state.oss_configured ? '已配置' : '未配置（OSS 挂载点暂不可用）' }}</p>
    <p v-if="state && !shown.length" class="subtle">还没有开通存储的用户，切换到“全部用户”为他们开通。</p>
    <article v-for="user in shown" :key="user.id" class="edit-card user" :class="{ muted: user.disabled }">
      <header>
        <div class="who"><strong>{{ user.name }}</strong><span>{{ user.email }}</span></div>
        <div class="usage"><strong>{{ formatSize(user.storage.used) }}</strong><span>/ {{ user.storage.quota === null ? '不限' : formatSize(user.storage.quota) }}</span><span class="field-hint">网盘 {{ formatSize(user.storage.drive_used) }} · 图床 {{ formatSize(user.storage.images_used) }}</span></div>
      </header>
      <form v-if="drafts[user.id]" class="plan" @submit.prevent="savePlan(user)">
        <label class="switch"><input v-model="drafts[user.id]!.drive_enabled" type="checkbox"><span>网盘</span></label>
        <label class="switch"><input v-model="drafts[user.id]!.images_enabled" type="checkbox"><span>图床</span></label>
        <label class="inline">总配额 MiB<input v-model.number="drafts[user.id]!.quota_mb" type="number" min="1" max="10000000"></label>
        <label class="inline">单张图片 MiB<input v-model.number="drafts[user.id]!.max_image_mb" type="number" min="1" max="20"></label>
        <button class="primary" type="submit" :disabled="busy">保存方案</button>
      </form>
      <template v-if="user.storage.drive_enabled && drafts[user.id]">
        <form class="plan" @submit.prevent="saveLogin(user)">
          <label class="inline grow">SFTP/WebDAV 登录名<input v-model="drafts[user.id]!.login" maxlength="32" placeholder="留空时使用邮箱登录"></label>
          <button type="submit" :disabled="busy || !drafts[user.id]!.login || drafts[user.id]!.login === user.login">保存登录名</button>
          <button type="button" :disabled="busy" @click="rescan(user)">重新统计用量</button>
        </form>
        <table class="mounts">
          <thead><tr><th>挂载点</th><th>存储</th><th>用量</th><th>单独配额 MiB</th><th>只读</th><th></th></tr></thead>
          <tbody>
            <tr v-for="mount in user.mounts" :key="mount.id">
              <td><code>{{ mount.path }}</code></td>
              <td>{{ mount.kind === 'local' ? '本地磁盘' : `OSS · ${mount.location}` }}</td>
              <td>{{ formatSize(mount.used) }} · {{ mount.files }} 个文件</td>
              <td><input v-if="mount.path !== '/'" type="number" min="0" :value="Math.round(mount.quota / MiB)" aria-label="单独配额" @change="updateMount(user, mount, Number(($event.target as HTMLInputElement).value), mount.read_only)"><span v-else class="field-hint">计入总配额</span></td>
              <td><label v-if="mount.path !== '/'" class="switch"><input type="checkbox" :checked="mount.read_only" @change="updateMount(user, mount, Math.round(mount.quota / MiB), !mount.read_only)"></label></td>
              <td><button v-if="mount.path !== '/'" class="danger" :disabled="busy" @click="removeMount(user, mount)">移除</button></td>
            </tr>
          </tbody>
        </table>
        <form v-if="mountForm[user.id]" class="plan" @submit.prevent="addMount(user)">
          <label class="inline">路径<input v-model="mountForm[user.id]!.path" required maxlength="64" placeholder="/archive"></label>
          <label class="inline grow">OSS 对象前缀<input v-model="mountForm[user.id]!.location" required maxlength="512" placeholder="users/name/"></label>
          <label class="inline">单独配额 MiB<input v-model.number="mountForm[user.id]!.quota_mb" type="number" min="0"></label>
          <label class="switch"><input v-model="mountForm[user.id]!.read_only" type="checkbox"><span>只读</span></label>
          <button class="primary" type="submit" :disabled="busy">添加</button><button type="button" @click="mountForm[user.id] = undefined">取消</button>
        </form>
        <button v-else class="add" type="button" @click="mountForm[user.id] = { path: '/archive', location: `users/${user.login || user.id}/`, quota_mb: 10240, read_only: false }">＋ 添加 OSS 挂载点</button>
      </template>
    </article>
  </section>
</template>

<style scoped>
.connection { margin:-8px 0 20px; }
.user.muted { opacity:.6; }
.user header { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap; }
.who { display:flex; flex-direction:column; }
.who strong { font-weight:500; }
.who span { color:var(--muted); font-size:12px; }
.usage { display:flex; flex-wrap:wrap; align-items:baseline; gap:6px; justify-content:flex-end; }
.usage strong { font-size:18px; }
.usage > span:not(.field-hint) { color:var(--muted); font-size:13px; }
.usage .field-hint { flex-basis:100%; text-align:right; }
.plan { display:flex; flex-wrap:wrap; align-items:flex-end; gap:12px 16px; margin-top:18px; }
.plan .switch { margin-bottom:10px; }
.inline input { width:120px; }
.inline.grow { flex:1; min-width:220px; }
.inline.grow input { width:100%; }
.mounts { width:100%; margin-top:18px; border-collapse:collapse; font-size:13px; }
.mounts th { padding:8px 6px; border-bottom:1px solid var(--line); color:var(--muted); font-weight:500; text-align:left; }
.mounts td { padding:10px 6px; border-bottom:1px solid var(--line); vertical-align:middle; }
.mounts td input[type=number] { width:110px; padding:6px 8px; }
.add { margin-top:14px; }
@media (max-width:860px) { .mounts thead { display:none; } .mounts tr { display:grid; grid-template-columns:1fr 1fr; padding:8px 0; border-bottom:1px solid var(--line); } .mounts td { border:0; padding:4px 6px; } }
</style>

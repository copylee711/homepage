<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { confirmDialog } from '../composables/useConfirm'
import { formatSize } from '../drive'
import type { DriveMount, StorageSummary } from '../drive'
import '../styles/admin-panel.css'

type Row = { id: string; email: string; name: string; disabled: boolean; has_plan: boolean; storage: StorageSummary; login: string; mounts: DriveMount[] }
type Server = { disk_total: number; disk_used: number; disk_free: number; drive_local: number; images: number; allocated: number; oss_used: number; oss_allocated: number }
type State = { users: Row[]; server: Server; admin_images: number; image_count: number; oss_configured: boolean; connection: { sftp_host: string; sftp_port: number; dav_url: string } }
type Draft = { drive_enabled: boolean; images_enabled: boolean; quota_mb: number; max_image_mb: number; login: string }
const props = defineProps<{ api: <T>(path: string, method?: string, data?: unknown) => Promise<T>; query: string; defaults?: Pick<Draft, 'quota_mb' | 'max_image_mb'> }>()
const emit = defineEmits<{ notify: [text: string]; fail: [text: string] }>()

const MiB = 1024 * 1024
const state = ref<State>()
const drafts = ref<Record<string, Draft>>({})
const mountForm = ref<Record<string, { path: string; location: string; quota_mb: number; read_only: boolean } | undefined>>({})
const filter = ref<'enabled' | 'all'>('all')
const busy = ref(false)
const expanded = ref(new Set<string>())
function toggle(id: string) {
  const next = new Set(expanded.value)
  if (!next.delete(id)) next.add(id)
  expanded.value = next
}
function dirty(user: Row) {
  const draft = drafts.value[user.id]
  if (!draft) return false
  const saved = draftOf(user)
  return draft.drive_enabled !== saved.drive_enabled || draft.images_enabled !== saved.images_enabled
    || draft.quota_mb !== saved.quota_mb || draft.max_image_mb !== saved.max_image_mb
}

const server = computed(() => state.value?.server)
const pct = (part: number, whole: number) => whole ? Math.min(100, part / whole * 100) : 0
// 已分配配额超过“当前占用 + 剩余空间”时，所有用户都用满会写满磁盘。
const overcommit = computed(() => server.value ? server.value.allocated > server.value.drive_local + server.value.images + server.value.disk_free : false)
const shown = computed(() => (state.value?.users ?? []).filter(user =>
  (filter.value === 'all' || user.storage.drive_enabled || user.storage.images_enabled || user.storage.used) &&
  `${user.name} ${user.email}`.toLowerCase().includes(props.query)))

function draftOf(user: Row): Draft {
  return { drive_enabled: user.storage.drive_enabled, images_enabled: user.storage.images_enabled,
    quota_mb: Math.round((user.storage.quota ?? 200 * MiB) / MiB), max_image_mb: Math.round(user.storage.max_image / MiB), login: user.login }
}
watch(() => props.defaults, next => {
  if (!next) return
  for (const user of state.value?.users ?? []) {
    const draft = drafts.value[user.id]
    if (user.has_plan || !draft) continue
    const previous = draftOf(user)
    if (draft.quota_mb === previous.quota_mb) draft.quota_mb = next.quota_mb
    if (draft.max_image_mb === previous.max_image_mb) draft.max_image_mb = next.max_image_mb
    user.storage.quota = next.quota_mb * MiB
    user.storage.max_image = next.max_image_mb * MiB
  }
})
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
  if (!await confirmDialog({ title: `移除挂载点 ${mount.path}？`, message: '只解除挂载，OSS 上的文件不会删除。', confirmText: '移除', danger: true })) return
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
    <div class="section-head">
      <div class="head-copy">
        <h2>云盘与图床</h2>
        <p class="field-hint">新用户默认未开通，在此逐个开通。云盘与图床共用总配额；单独设置配额的挂载点不计入总配额，管理员同样按方案计算。</p>
      </div>
      <div class="buttons">
        <div class="filter" role="radiogroup" aria-label="筛选">
          <button type="button" role="radio" :aria-checked="filter === 'enabled'" @click="filter = 'enabled'">已开通</button>
          <button type="button" role="radio" :aria-checked="filter === 'all'" @click="filter = 'all'">全部</button>
        </div>
        <button type="button" :disabled="busy" @click="work(load)">刷新</button>
      </div>
    </div>
    <section v-if="server" class="server">
      <div class="server-bar">
        <div class="disk" role="img" :aria-label="`磁盘已用 ${formatSize(server.disk_used)}，共 ${formatSize(server.disk_total)}`">
          <span class="seg drive" :style="{ width: `${pct(server.drive_local, server.disk_total)}%` }" :title="`云盘 ${formatSize(server.drive_local)}`" />
          <span class="seg images" :style="{ width: `${pct(server.images, server.disk_total)}%` }" :title="`图床 ${formatSize(server.images)}`" />
          <span class="seg other" :style="{ width: `${pct(Math.max(server.disk_used - server.drive_local - server.images, 0), server.disk_total)}%` }" title="系统与其他文件" />
        </div>
        <span class="disk-total">{{ formatSize(server.disk_used) }} / {{ formatSize(server.disk_total) }}</span>
      </div>
      <dl class="figures">
        <div><dt><i class="dot drive" />云盘</dt><dd>{{ formatSize(server.drive_local) }}</dd></div>
        <div><dt><i class="dot images" />图床</dt><dd>{{ formatSize(server.images) }}</dd></div>
        <div><dt>剩余</dt><dd>{{ formatSize(server.disk_free) }}</dd></div>
        <div :title="overcommit ? '超过可用空间，用户都用满会写满磁盘' : ''"><dt>已分配</dt><dd :class="{ warn: overcommit }">{{ formatSize(server.allocated) }}<small v-if="!overcommit"> · 可再分配 {{ formatSize(Math.max(server.drive_local + server.images + server.disk_free - server.allocated, 0)) }}</small><small v-else> · 超额</small></dd></div>
        <div v-if="state?.oss_configured"><dt>OSS</dt><dd>{{ formatSize(server.oss_used) }}<small> · 挂载配额 {{ formatSize(server.oss_allocated) }}</small></dd></div>
      </dl>
      <p v-if="state" class="field-hint connection">SFTP <code>{{ state.connection.sftp_host }}:{{ state.connection.sftp_port }}</code> · WebDAV <code>{{ state.connection.dav_url }}</code> · OSS {{ state.oss_configured ? '已配置' : '未配置' }}</p>
    </section>
    <p v-if="busy && !state" class="subtle" role="status">正在读取存储方案…</p>
    <p v-if="state && !shown.length" class="subtle">{{ query ? '没有符合条件的用户。' : filter === 'enabled' ? '暂无已开通的用户。' : '暂无用户。' }}</p>
    <div v-if="state && shown.length" class="rows">
      <div class="row head" aria-hidden="true"><span>用户</span><span>用量</span><span>云盘</span><span>图床</span><span>总配额 MiB</span><span>单图 MiB</span><span /></div>
      <article v-for="user in shown" :key="user.id" class="row-wrap" :class="{ muted: user.disabled, open: expanded.has(user.id) }">
        <form v-if="drafts[user.id]" class="row" @submit.prevent="savePlan(user)">
          <div class="who">
            <strong>{{ user.name }}<em v-if="user.disabled" class="tag">已停用</em><em v-else-if="(user.storage.drive_enabled || user.storage.images_enabled) && !user.storage.agreed" class="tag">待同意协议</em></strong>
            <span>{{ user.email }}</span>
          </div>
          <div class="usage" :title="`云盘 ${formatSize(user.storage.drive_used)} · 图床 ${formatSize(user.storage.images_used)}`">
            <span><strong>{{ formatSize(user.storage.used) }}</strong> / {{ user.storage.quota === null ? '不限' : formatSize(user.storage.quota) }}</span>
            <i><b :style="{ width: (user.storage.quota ? pct(user.storage.used, user.storage.quota) : 0) + '%' }" :class="{ hot: user.storage.quota && user.storage.used / user.storage.quota > .9 }" /></i>
          </div>
          <label class="switch" data-label="云盘"><input v-model="drafts[user.id]!.drive_enabled" type="checkbox" aria-label="云盘"></label>
          <label class="switch" data-label="图床"><input v-model="drafts[user.id]!.images_enabled" type="checkbox" aria-label="图床"></label>
          <label class="num" data-label="总配额 MiB"><input v-model.number="drafts[user.id]!.quota_mb" type="number" min="1" max="10000000" required aria-label="总配额 MiB"></label>
          <label class="num" data-label="单图 MiB"><input v-model.number="drafts[user.id]!.max_image_mb" type="number" min="1" max="20" required aria-label="单张图片 MiB"></label>
          <div class="actions">
            <button type="submit" :class="{ primary: dirty(user) }" :disabled="busy || !dirty(user)">保存</button>
            <span v-if="!user.storage.drive_enabled" class="more-gap" aria-hidden="true" />
            <button v-else type="button" class="more" :aria-expanded="expanded.has(user.id)" :aria-label="expanded.has(user.id) ? '收起云盘设置' : '展开云盘设置'" title="登录名与挂载点" @click="toggle(user.id)">
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4" /></svg>
            </button>
          </div>
        </form>
        <Transition name="expand">
          <div v-if="user.storage.drive_enabled && drafts[user.id] && expanded.has(user.id)" class="detail">
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
                  <td><label v-if="mount.path !== '/'" class="switch"><input type="checkbox" :checked="mount.read_only" aria-label="只读" @change="updateMount(user, mount, Math.round(mount.quota / MiB), !mount.read_only)"></label></td>
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
          </div>
        </Transition>
      </article>
    </div>
  </section>
</template>

<style scoped>
.head-copy { display:grid; gap:4px; }
.filter { display:inline-flex; gap:2px; padding:3px; border:1px solid var(--line); border-radius:10px; }
.admin-panel .filter button { padding:4px 10px; border:0; border-radius:7px; background:none; color:var(--muted); font-size:12px; }
.admin-panel .filter button[aria-checked="true"] { background:var(--accent-soft); color:var(--accent); }
.server { margin-bottom:16px; padding:14px 16px; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--surface); }
.server-bar { display:flex; align-items:center; gap:12px; }
.disk { flex:1; display:flex; height:8px; border-radius:999px; background:var(--bg-tint); overflow:hidden; }
.disk-total { font-size:12.5px; font-variant-numeric:tabular-nums; white-space:nowrap; }
.seg { height:100%; transition:width .6s var(--ease); }
.seg.drive,.dot.drive { background:var(--accent); }
.seg.images,.dot.images { background:#7ea2ff; }
.seg.other { background:var(--line-strong); }
.figures { display:flex; flex-wrap:wrap; gap:6px 22px; margin:10px 0 0; }
.figures div { display:flex; align-items:baseline; gap:6px; }
.figures dt { color:var(--muted); font-size:12px; }
.figures dd { margin:0; font-size:13px; font-weight:600; font-variant-numeric:tabular-nums; }
.figures small { color:var(--muted); font-weight:400; font-size:11.5px; }
.figures dd.warn { color:#d15c5c; }
.dot { display:inline-block; width:7px; height:7px; margin-right:5px; border-radius:2px; }
.connection { margin:6px 0 0; }
.rows { border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--surface); overflow:hidden; }
.row { display:grid; grid-template-columns:minmax(0,1.4fr) minmax(120px,1fr) 44px 44px 104px 84px 92px; align-items:center; gap:10px; padding:8px 14px; }
.row.head { padding-block:8px; background:var(--bg-tint); color:var(--muted); font-size:12px; }
.row-wrap { border-top:1px solid var(--line); transition:background .2s; }
.row-wrap:hover, .row-wrap.open { background:color-mix(in srgb,var(--bg-tint) 55%,transparent); }
.row-wrap.muted .who, .row-wrap.muted .usage { opacity:.55; }
.who { display:grid; min-width:0; line-height:1.35; }
.who strong { display:flex; align-items:center; font-size:13.5px; font-weight:600; min-width:0; }
.who strong em { font-style:normal; }
.admin-panel .who .tag { margin-left:6px; flex:none; }
.who span { color:var(--muted); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.usage { display:grid; gap:4px; font-size:12px; color:var(--muted); font-variant-numeric:tabular-nums; }
.usage strong { color:var(--text); font-weight:600; }
.usage i { height:4px; border-radius:999px; background:var(--bg-tint); overflow:hidden; }
.usage b { display:block; height:100%; border-radius:inherit; background:var(--accent); transition:width .5s var(--ease); }
.usage b.hot { background:#d15c5c; }
.admin-panel .rows .row .num input:not([type=checkbox]) { padding:4px 8px; font-size:13px; border-radius:8px; }
.actions { display:flex; justify-content:flex-end; align-items:center; gap:4px; }
.admin-panel .actions button { padding:5px 11px; font-size:12px; border-radius:8px; }
.admin-panel .actions .more { display:inline-grid; place-items:center; width:28px; height:28px; padding:0; border-color:transparent; background:none; }
.more-gap { width:28px; flex:none; }
.more svg { width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:1.6; transition:transform .25s var(--ease); }
.more[aria-expanded="true"] svg { transform:rotate(180deg); }
.detail { padding:2px 14px 14px; }
.plan { display:flex; flex-wrap:wrap; align-items:flex-end; gap:10px 12px; margin-top:8px; }
.plan .switch { margin-bottom:8px; }
.admin-panel .detail .plan input:not([type=checkbox]) { padding:5px 10px; font-size:13px; }
.inline.grow { max-width:360px; }
.admin-panel .plan label { font-size:12px; gap:4px; }
.inline input { width:120px; }
.inline.grow { flex:1; min-width:220px; }
.inline.grow input { width:100%; }
.mounts { width:100%; margin-top:12px; border-collapse:collapse; font-size:12.5px; }
.mounts th { padding:6px; border-bottom:1px solid var(--line); color:var(--muted); font-weight:500; text-align:left; }
.mounts td { padding:6px; border-bottom:1px solid var(--line); vertical-align:middle; }
.mounts td input[type=number] { width:100px; padding:4px 8px; }
.admin-panel .mounts button { padding:4px 10px; font-size:12px; }
.add { margin-top:10px; }
.expand-enter-active, .expand-leave-active { transition:opacity .2s var(--ease), transform .2s var(--ease); }
.expand-enter-from, .expand-leave-to { opacity:0; transform:translateY(-4px); }
@media (max-width:900px) {
  .row.head { display:none; }
  .row { grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px 10px; padding:10px 14px; }
  .who { grid-column:1 / 3; }
  .usage { grid-column:3 / 5; }
  .row > label[data-label] { display:grid; gap:3px; font-size:11px; font-weight:400; color:var(--muted); }
  .row > label[data-label]::before { content:attr(data-label); }
  .actions { grid-column:1 / -1; }
}
@media (max-width:860px) { .mounts thead { display:none; } .mounts tr { display:grid; grid-template-columns:1fr 1fr; padding:8px 0; border-bottom:1px solid var(--line); } .mounts td { border:0; padding:4px 6px; } }
@media (max-width:700px) {
  .inline input { width:100%; }
  .inline.grow { min-width:0; flex-basis:100%; }
}
</style>

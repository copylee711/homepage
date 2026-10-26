<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { confirmDialog } from '../../composables/useConfirm'
import { docsApi, roleName } from '../../docs'
import type { DocItem, DocLink, DocMember, Person } from '../../docs'
import MenuSelect from '../MenuSelect.vue'

const props = defineProps<{ doc: DocItem }>()
const emit = defineEmits<{ close: []; changed: [doc: Partial<DocItem>] }>()
const open = ref(true)

const owner = ref<Person & { email: string }>()
const members = ref<DocMember[]>([])
const email = ref(''), role = ref<'view' | 'edit'>('view'), canShare = ref(false)
const error = ref(''), notice = ref(''), busy = ref(false)
const isOwner = computed(() => props.doc.role === 'owner')
// 非所有者只能授予不超过自己的权限。
const grantable = computed(() => props.doc.role === 'view' ? ['view'] as const : ['view', 'edit'] as const)
const roleOptions = computed(() => grantable.value.map(value => ({ value, label: roleName[value] })))

const link = ref<DocLink | undefined>(props.doc.link)
const password = ref('')
const expiry = ref('keep')
const expiryOptions = [{ value: 'keep', label: '保持不变' }, { value: '0', label: '永久有效' }, { value: '1', label: '1 天' },
  { value: '7', label: '7 天' }, { value: '30', label: '30 天' }]

async function work<T>(task: () => Promise<T>, done = '') {
  busy.value = true; error.value = ''; notice.value = ''
  try { const result = await task(); notice.value = done; return result }
  catch (err) { error.value = err instanceof Error ? err.message : '操作失败' }
  finally { busy.value = false }
}

async function load() {
  const data = await work(() => docsApi<{ owner: Person & { email: string }; members: DocMember[] }>(`/${props.doc.id}/members`))
  if (data) { owner.value = data.owner; members.value = data.members }
}

async function invite() {
  if (!email.value.trim()) return
  const data = await work(() => docsApi<{ members: DocMember[] }>(`/${props.doc.id}/members`, 'POST', { email: email.value.trim(), role: role.value, can_share: canShare.value }), '已添加')
  if (data) { members.value = data.members; email.value = '' }
}

async function update(member: DocMember, changes: Partial<DocMember>) {
  const data = await work(() => docsApi<{ members: DocMember[] }>(`/${props.doc.id}/members`, 'POST', { email: member.email, role: changes.role ?? member.role, can_share: changes.can_share ?? member.can_share }), '已更新')
  if (data) members.value = data.members
}

async function remove(member: DocMember) {
  if (!await confirmDialog({ title: `移除 ${member.name}？`, message: '对方会立即失去这篇文档的访问权限。', confirmText: '移除', danger: true })) return
  const data = await work(() => docsApi<{ members: DocMember[] }>(`/${props.doc.id}/members/${member.id}/remove`, 'POST'), '已移除')
  if (data) members.value = data.members
}

async function saveLink(changes: { role?: DocLink['role']; regenerate?: boolean; clearPassword?: boolean } = {}) {
  if (!link.value) return
  const expires = expiry.value === 'keep' ? link.value.expires_at : expiry.value === '0' ? 0 : Date.now() / 1000 + Number(expiry.value) * 86400
  const body = { role: changes.role ?? link.value.role, expires_at: expires, regenerate: !!changes.regenerate,
                 password: changes.clearPassword ? '' : password.value || null }
  const data = await work(() => docsApi<DocLink>(`/${props.doc.id}/link`, 'PUT', body), changes.regenerate ? '已生成新链接，旧链接失效' : '链接设置已保存')
  if (data) { link.value = data; password.value = ''; expiry.value = 'keep'; emit('changed', { link: data }) }
}

async function regenerate() {
  if (!await confirmDialog({ title: '重新生成链接？', message: '旧链接会立即失效，需要把新链接重新发给对方。', confirmText: '重新生成' })) return
  await saveLink({ regenerate: true })
}

async function copyLink() {
  if (!link.value) return
  try { await navigator.clipboard.writeText(link.value.url); notice.value = '链接已复制' } catch { error.value = '复制失败，请手动复制' }
}

async function setAllowCopy(value: boolean) {
  const data = await work(() => docsApi<DocItem>(`/${props.doc.id}`, 'PATCH', { allow_copy: value }), '已保存')
  if (data) emit('changed', { allow_copy: data.allow_copy })
}

const expiresText = computed(() => {
  const at = link.value?.expires_at
  if (!at) return '永久有效'
  return at * 1000 < Date.now() ? '已过期' : `有效期至 ${new Date(at * 1000).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })}`
})

onMounted(load)
</script>

<template>
  <DialogRoot :open="open" @update:open="value => { if (!value) emit('close') }">
    <DialogPortal>
      <DialogOverlay class="confirm-overlay" />
      <DialogContent class="share-dialog">
        <div class="share-head">
          <DialogTitle class="confirm-title">分享「{{ doc.title }}」</DialogTitle>
          <DialogClose class="close" aria-label="关闭">×</DialogClose>
        </div>
        <DialogDescription class="d-muted">邀请已注册的用户协作，或通过链接分享。未登录的访客最多只能查看。</DialogDescription>

        <form class="invite" @submit.prevent="invite">
          <input v-model="email" class="d-input" type="email" placeholder="对方的注册邮箱" autocomplete="off" required>
          <MenuSelect v-model="role" :options="roleOptions" label="邀请的权限" />
          <button class="d-btn primary" type="submit" :disabled="busy">邀请</button>
        </form>
        <label class="d-check small"><input v-model="canShare" type="checkbox">允许对方再分享给其他人</label>

        <p v-if="error" class="d-note error" role="alert">{{ error }}</p>
        <p v-else-if="notice" class="d-note ok" role="status">{{ notice }}</p>

        <ul class="people">
          <li v-if="owner">
            <span class="avatar"><img v-if="owner.avatar" :src="owner.avatar" alt=""><template v-else>{{ owner.name.slice(0, 1) }}</template></span>
            <span class="who"><strong>{{ owner.name }}</strong><small>{{ owner.email }}</small></span>
            <span class="fixed">所有者</span>
          </li>
          <li v-for="member in members" :key="member.id">
            <span class="avatar"><img v-if="member.avatar" :src="member.avatar" alt=""><template v-else>{{ member.name.slice(0, 1) }}</template></span>
            <span class="who"><strong>{{ member.name }}</strong><small>{{ member.email }}</small></span>
            <span class="controls">
              <MenuSelect :model-value="member.role" :options="roleOptions" :label="`${member.name} 的权限`" :disabled="busy || (!isOwner && member.role === 'edit' && doc.role !== 'edit')" @update:model-value="value => update(member, { role: value as 'view' | 'edit' })" />
              <label class="d-check small" title="允许再分享"><input type="checkbox" :checked="member.can_share" :disabled="busy" @change="update(member, { can_share: ($event.target as HTMLInputElement).checked })">可分享</label>
              <button class="d-btn danger small" type="button" :disabled="busy" @click="remove(member)">移除</button>
            </span>
          </li>
        </ul>

        <section v-if="isOwner && link" class="link">
          <h3>链接分享</h3>
          <div class="segmented" role="radiogroup" aria-label="链接权限">
            <button v-for="value in (['none', 'view', 'edit'] as const)" :key="value" type="button" role="radio" :aria-checked="link.role === value" :class="{ on: link.role === value }" :disabled="busy" @click="saveLink({ role: value })">{{ value === 'none' ? '关闭' : value === 'view' ? '可查看' : '登录用户可编辑' }}</button>
          </div>
          <template v-if="link.role !== 'none'">
            <div class="url">
              <input class="d-input" :value="link.url" readonly @focus="($event.target as HTMLInputElement).select()">
              <button class="d-btn" type="button" @click="copyLink">复制</button>
            </div>
            <p class="d-muted small">{{ link.role === 'edit' ? '登录用户打开链接即可编辑，未登录访客只能查看。' : '持有链接的人都可以查看，包括未登录的访客。' }} {{ expiresText }}{{ link.has_password ? ' · 已设密码' : '' }}</p>
            <div class="row">
              <input v-model="password" class="d-input" type="text" :placeholder="link.has_password ? '输入新密码以更换' : '设置访问密码（可选）'" autocomplete="off" maxlength="128">
              <MenuSelect v-model="expiry" :options="expiryOptions" label="链接有效期" />
              <button class="d-btn" type="button" :disabled="busy || (!password && expiry === 'keep')" @click="saveLink()">保存</button>
            </div>
            <div class="row end">
              <button v-if="link.has_password" class="d-btn small" type="button" :disabled="busy" @click="saveLink({ clearPassword: true })">取消密码</button>
              <button class="d-btn small" type="button" :disabled="busy" @click="regenerate">重新生成链接</button>
            </div>
          </template>
          <label class="d-check small copy"><input type="checkbox" :checked="doc.allow_copy" :disabled="busy" @change="setAllowCopy(($event.target as HTMLInputElement).checked)">允许只读的人复制内容和导出 Markdown</label>
        </section>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style>
.share-dialog { position:fixed; z-index:81; left:50%; top:50%; transform:translate(-50%,-50%); width:min(560px,calc(100vw - 32px)); max-height:calc(100vh - 48px); overflow:auto; padding:24px 26px; border:1px solid var(--line); border-radius:var(--radius); background:var(--bg); color:var(--text); font-family:var(--font); box-shadow:0 30px 60px -20px rgba(0,0,0,.35); outline:none; }
.share-dialog[data-state=open] { animation:confirm-rise .28s var(--ease); }
.share-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
.share-dialog .close { border:0; background:none; color:var(--muted); font-size:24px; line-height:1; cursor:pointer; }
.share-dialog > .d-muted { margin:6px 0 16px; font-size:13px; }
.share-dialog .invite, .share-dialog .row, .share-dialog .url { display:flex; gap:8px; }
.share-dialog .invite input, .share-dialog .row input, .share-dialog .url input { flex:1; min-width:0; }
.share-dialog .menu-select { flex:none; }
.share-dialog .small { font-size:12.5px; }
.share-dialog .d-check.small { margin-top:8px; }
.share-dialog .d-note { margin-top:12px; }
.share-dialog .people { list-style:none; margin:16px 0 0; padding:0; border-top:1px solid var(--line); }
.share-dialog .people li { display:flex; align-items:center; gap:12px; padding:12px 0; border-bottom:1px solid var(--line); }
.share-dialog .avatar { flex:none; display:grid; place-items:center; width:34px; height:34px; border-radius:50%; overflow:hidden; background:var(--accent-soft); color:var(--accent); font-weight:600; }
.share-dialog .avatar img { width:100%; height:100%; object-fit:cover; }
.share-dialog .who { flex:1; display:flex; flex-direction:column; min-width:0; }
.share-dialog .who strong { font-weight:500; font-size:14px; }
.share-dialog .who small { color:var(--faint); font-size:12px; overflow:hidden; text-overflow:ellipsis; }
.share-dialog .fixed { color:var(--muted); font-size:13px; }
.share-dialog .controls { display:flex; align-items:center; gap:8px; }
.share-dialog .controls .d-check { margin:0; }
.share-dialog .d-btn.small { padding:5px 10px; font-size:12.5px; }
.share-dialog .link { margin-top:22px; }
.share-dialog .link h3 { margin:0 0 10px; font-size:15px; }
.share-dialog .link > * + * { margin-top:10px; }
.share-dialog .row.end { justify-content:flex-end; }
.share-dialog .segmented { display:inline-flex; padding:3px; border:1px solid var(--line); border-radius:10px; background:var(--surface); }
.share-dialog .segmented button { padding:6px 12px; border:0; border-radius:7px; background:none; color:var(--text-2); font:13px var(--font); cursor:pointer; }
.share-dialog .segmented button.on { background:var(--btn-bg); color:var(--btn-fg); }
.share-dialog .copy { padding-top:12px; border-top:1px solid var(--line); }
@media (max-width:760px) {
  .share-dialog { top:auto; bottom:0; left:0; width:100%; max-height:92vh; transform:none; padding:18px 18px calc(20px + env(safe-area-inset-bottom)); border-radius:22px 22px 0 0; }
  .share-dialog[data-state=open] { animation:confirm-sheet .32s var(--ease); }
  .share-dialog .people li { flex-wrap:wrap; }
  .share-dialog .controls { width:100%; justify-content:flex-end; }
  .share-dialog .row { flex-wrap:wrap; }
}
</style>

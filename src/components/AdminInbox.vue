<script setup lang="ts">
import { formatTime } from '../drive'
import { onMounted, ref, watch } from 'vue'
import { confirmDialog } from '../composables/useConfirm'
import '../styles/admin-panel.css'

type Item = { id: string; category: 'suggestion' | 'bug' | 'other'; content: string; page: string; status: 'new' | 'read' | 'done'; reply: string; created_at: number; replied_at: number | null; user: { id: string; email: string; name: string } }
type Inbox = { items: Item[]; total: number; page: number; page_size: number; unread: number }
const props = defineProps<{ api: <T>(path: string, method?: string, data?: unknown) => Promise<T> }>()
const emit = defineEmits<{ unread: [value: number]; notify: [text: string]; fail: [text: string] }>()

const filters = [['', '全部'], ['new', '未读'], ['read', '已读'], ['done', '已处理']] as const
const categoryLabel = { suggestion: '建议', bug: '问题', other: '其他' }
const statusLabel = { new: '未读', read: '已读', done: '已处理' }
const status = ref<'' | Item['status']>('new')
const inbox = ref<Inbox>()
const replies = ref<Record<string, string>>({})
const busy = ref(false)

const time = (value: number) => formatTime(value)
const pages = () => Math.max(1, Math.ceil((inbox.value?.total ?? 0) / (inbox.value?.page_size ?? 30)))

async function work(task: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  try { await task() } catch (err) { emit('fail', err instanceof Error ? err.message : '操作失败') }
  finally { busy.value = false }
}
async function load(page = 1) {
  inbox.value = await props.api<Inbox>(`/api/admin/inbox?page=${page}&status=${status.value}`)
  replies.value = Object.fromEntries(inbox.value.items.map(item => [item.id, item.reply]))
  emit('unread', inbox.value.unread)
}
// 只更新这一条，不重新加载列表：在“未读”筛选下打开一条后它不会立刻消失。
const update = (item: Item, next: Item['status'], reply?: string) => work(async () => {
  const before = item.status
  Object.assign(item, await props.api<Item>(`/api/admin/inbox/${item.id}`, 'PUT', { status: next, ...(reply === undefined ? {} : { reply }) }))
  if (inbox.value) {
    inbox.value.unread += Number(next === 'new') - Number(before === 'new')
    emit('unread', inbox.value.unread)
  }
  if (reply !== undefined) emit('notify', reply ? '回复已保存，用户会在账户页的反馈记录中看到。' : '回复已清除。')
})
const remove = (item: Item) => work(async () => {
  if (!await confirmDialog({ title: '删除这条反馈？', message: '用户的反馈记录中也会消失。', confirmText: '删除', danger: true })) return
  await props.api(`/api/admin/inbox/${item.id}/remove`, 'POST')
  await load(inbox.value?.page ?? 1)
})
// 打开即视为已读，避免逐条手动标记。
const open = (item: Item) => { if (item.status === 'new') void update(item, 'read') }

watch(status, () => work(() => load(1)))
onMounted(() => work(() => load(1)))
</script>

<template>
  <section class="admin-panel inbox">
    <div class="section-head"><div><p class="eyebrow">Inbox</p><h1>收件箱</h1></div>
      <div class="buttons"><button v-for="[value, label] in filters" :key="value" :class="{ selected: status === value }" @click="status = value">{{ label }}</button><button @click="work(() => load(inbox?.page ?? 1))">刷新</button></div></div>
    <p class="subtle">登录用户在账户页提交的建议。提交前需通过安全验证，并按用户与 IP 限流。回复会显示在用户的反馈记录中。</p>
    <p v-if="inbox && !inbox.items.length" class="subtle">{{ status === 'new' ? '没有未读反馈。' : '这里还没有反馈。' }}</p>
    <details v-for="item in inbox?.items ?? []" :key="item.id" class="edit-card message" :class="item.status" @toggle="($event.target as HTMLDetailsElement).open && open(item)">
      <summary>
        <span class="dot" aria-hidden="true" />
        <span class="who"><strong>{{ item.user.name }}</strong><span>{{ item.user.email }}</span></span>
        <span class="preview">{{ item.content }}</span>
        <span class="tag">{{ categoryLabel[item.category] }}</span>
        <span class="tag" :class="{ accent: item.status === 'done' }">{{ statusLabel[item.status] }}</span>
        <time>{{ time(item.created_at) }}</time>
      </summary>
      <p class="body">{{ item.content }}</p>
      <p v-if="item.page" class="field-hint">来源页面：{{ item.page }}</p>
      <label class="reply">回复<textarea v-model="replies[item.id]" rows="3" maxlength="2000" placeholder="写给用户的回复，会显示在其账户页"></textarea></label>
      <div class="buttons actions">
        <button class="primary" :disabled="busy" @click="update(item, 'done', replies[item.id] ?? '')">保存回复并标记已处理</button>
        <button v-if="item.status !== 'done'" :disabled="busy" @click="update(item, 'done')">标记已处理</button>
        <button v-else :disabled="busy" @click="update(item, 'read')">重新打开</button>
        <button v-if="item.status !== 'new'" :disabled="busy" @click="update(item, 'new')">标为未读</button>
        <button class="danger" :disabled="busy" @click="remove(item)">删除</button>
      </div>
    </details>
    <div v-if="inbox && pages() > 1" class="buttons pager"><button :disabled="inbox.page <= 1" @click="work(() => load(inbox!.page - 1))">上一页</button><span class="field-hint">{{ inbox.page }} / {{ pages() }}</span><button :disabled="inbox.page >= pages()" @click="work(() => load(inbox!.page + 1))">下一页</button></div>
  </section>
</template>

<style scoped>
.message { padding:0; margin-bottom:10px; }
.message summary { display:grid; grid-template-columns:10px minmax(0,180px) minmax(0,1fr) auto auto auto; align-items:center; gap:14px; padding:16px 22px; cursor:pointer; list-style:none; }
.message summary::-webkit-details-marker { display:none; }
.dot { width:8px; height:8px; border-radius:50%; background:transparent; }
.message.new .dot { background:var(--accent); box-shadow:0 0 0 4px var(--accent-soft); }
.message.new .who strong { color:var(--text); }
.who { display:flex; flex-direction:column; min-width:0; }
.who strong { font-weight:500; font-size:14px; color:var(--text-2); }
.who span { color:var(--muted); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.preview { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--muted); font-size:13px; }
.message summary .tag { margin:0; }
time { color:var(--faint); font:12px var(--font-mono); white-space:nowrap; }
.message[open] summary { border-bottom:1px solid var(--line); }
.body { margin:18px 22px 6px; white-space:pre-wrap; overflow-wrap:anywhere; font-size:15px; line-height:1.8; }
.message > .field-hint { margin:0 22px; }
.reply { margin:16px 22px 0; }
.actions { margin:14px 22px 20px; }
.pager { justify-content:center; margin-top:16px; }
@media (max-width:860px) {
  .message summary { grid-template-columns:10px minmax(0,1fr) auto; grid-template-areas:'dot who time' '. preview preview'; row-gap:6px; padding:14px 16px; }
  .dot { grid-area:dot; } .who { grid-area:who; } time { grid-area:time; }
  .preview { grid-area:preview; }
  .message summary .tag { display:none; }
  .body { margin:14px 16px 4px; }
  .message > .field-hint { margin:0 16px; }
  .reply { margin:14px 16px 0; }
  .actions { display:grid; grid-template-columns:1fr 1fr; margin:12px 16px 16px; }
  .actions .primary { grid-column:1 / -1; }
}
</style>

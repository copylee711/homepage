<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { account, accountChecked, features, loadAccount } from '../../account'
import { confirmDialog } from '../../composables/useConfirm'
import { docUrl, roleName, timeAgo } from '../../docs'
import type { Person } from '../../docs'
import { accountUrl, formatSize } from '../../drive'
import type { DriveEntry } from '../../drive'
import { messageFileUrl, refreshUnread, socialApi } from '../../friends'
import type { ChatMessage, Conversation, FriendsOverview } from '../../friends'
import '../../styles/drive.css'
import PreviewDialog from '../drive/PreviewDialog.vue'
import DriveDialog from '../drive/DriveDialog.vue'
import { kindIcons, kindOf } from '../drive/fileKinds'
import AddFriend from './AddFriend.vue'
import DocInvitePicker from './DocInvitePicker.vue'
import FilePicker from './FilePicker.vue'

type Peer = Person & { email: string }
const params = new URLSearchParams(location.search)
const tab = ref<'chats' | 'friends'>('chats')
const overview = ref<FriendsOverview>({ friends: [], incoming: [], outgoing: [] })
const conversations = ref<Conversation[]>([])
const loading = ref(true), error = ref('')

const activeId = ref(params.get('with') ?? '')
const peer = ref<Peer>()
const messages = ref<ChatMessage[]>([])
const more = ref(false), loadingOlder = ref(false), chatError = ref('')
const draft = ref(''), sending = ref(false)
const list = ref<HTMLElement>()
let cursor = 0

const adding = ref(false), pickingFile = ref(false), pickingDoc = ref(false)
const preview = ref<{ entry: DriveEntry; id: string }>()
const invite = ref<{ token: string; user?: Person; self?: boolean; friend?: boolean; error?: string }>()
const inviteBusy = ref(false)

const active = computed(() => conversations.value.find(item => item.user.id === activeId.value))
const requestCount = computed(() => overview.value.incoming.length)

async function guard<T>(task: () => Promise<T>, target = error): Promise<T | undefined> {
  try { target.value = ''; return await task() }
  catch (err) { target.value = err instanceof Error ? err.message : '操作失败'; return undefined }
}

async function loadAll() {
  const [friends, chats] = await Promise.all([
    guard(() => socialApi<FriendsOverview>('/friends')),
    guard(() => socialApi<{ items: Conversation[] }>('/messages/conversations')),
  ])
  if (friends) overview.value = friends
  // 正在看的会话由轮询标为已读，列表里不再显示它的未读数。
  if (chats) conversations.value = chats.items.map(item => item.user.id === activeId.value ? { ...item, unread: 0 } : item)
}

function setUrl() {
  const search = new URLSearchParams(location.search)
  search.delete('invite')
  if (activeId.value) search.set('with', activeId.value); else search.delete('with')
  history.replaceState(null, '', `${location.pathname}${search.size ? `?${search}` : ''}`)
}

// —— 会话 ——

function merge(items: ChatMessage[]) {
  const byId = new Map(messages.value.map(item => [item.id, item]))
  for (const item of items) byId.set(item.id, item)
  messages.value = [...byId.values()].sort((a, b) => a.created_at - b.created_at)
  for (const item of items) cursor = Math.max(cursor, item.updated_at)
}

const nearBottom = () => !list.value || list.value.scrollHeight - list.value.scrollTop - list.value.clientHeight < 80
async function toBottom() { await nextTick(); list.value?.scrollTo({ top: list.value.scrollHeight }) }

async function openChat(id: string) {
  activeId.value = id; tab.value = 'chats'
  messages.value = []; peer.value = undefined; cursor = 0; more.value = false; draft.value = ''
  setUrl()
  const data = await guard(() => socialApi<{ user: Peer; items: ChatMessage[]; more: boolean }>(`/messages/with/${id}`), chatError)
  if (!data || activeId.value !== id) return
  peer.value = data.user; more.value = data.more
  merge(data.items)
  const item = conversations.value.find(entry => entry.user.id === id)
  if (item) item.unread = 0
  refreshUnread()
  toBottom()
}

function closeChat() { activeId.value = ''; peer.value = undefined; messages.value = []; setUrl() }

async function loadOlder() {
  if (!messages.value.length || loadingOlder.value) return
  loadingOlder.value = true
  const box = list.value, height = box?.scrollHeight ?? 0
  const data = await guard(() => socialApi<{ items: ChatMessage[]; more: boolean }>(`/messages/with/${activeId.value}?before=${messages.value[0]!.created_at}`), chatError)
  loadingOlder.value = false
  if (!data) return
  more.value = data.more
  merge(data.items)
  // 保持当前阅读位置，不被新插入的旧消息顶走。
  await nextTick()
  if (box) box.scrollTop += box.scrollHeight - height
}

async function poll() {
  const id = activeId.value
  if (!id || !peer.value || document.visibilityState !== 'visible') return
  const query = cursor ? `?after=${cursor}` : ''
  const data = await socialApi<{ items: ChatMessage[] }>(`/messages/with/${id}${query}`).catch(() => null)
  if (!data || activeId.value !== id || !data.items.length) return
  const stick = nearBottom()
  merge(data.items)
  if (stick) toBottom()
}

async function send(body: Record<string, unknown>) {
  if (!activeId.value || sending.value) return false
  sending.value = true
  const message = await guard(() => socialApi<ChatMessage>(`/messages/with/${activeId.value}`, 'POST', body), chatError)
  sending.value = false
  if (!message) return false
  merge([message])
  toBottom()
  const item = conversations.value.find(entry => entry.user.id === activeId.value)
  if (item) { item.last = message; item.at = message.created_at; conversations.value.sort((a, b) => b.at - a.at) }
  return true
}

async function sendText() {
  const body = draft.value.trim()
  if (!body) return
  if (await send({ kind: 'text', body })) draft.value = ''
}

function onKey(event: KeyboardEvent) {
  // Enter 发送，Shift+Enter 换行；输入法组字时不发送。
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendText() }
}

async function sendFile(entry: DriveEntry) {
  pickingFile.value = false
  await send({ kind: 'file', path: entry.path })
}

async function sendInvite(choice: { doc_id: string; role: 'view' | 'edit'; can_share: boolean }) {
  pickingDoc.value = false
  await send({ kind: 'doc_invite', ...choice })
}

async function revoke(message: ChatMessage) {
  const what = message.kind === 'file' ? '撤回后对方无法再打开这个文件。' : message.kind === 'doc_invite' ? '撤回后对方无法再接受这个邀请；已接受的不受影响。' : '撤回后对方将看不到这条消息。'
  if (!await confirmDialog({ title: '撤回这条消息？', message: what, confirmText: '撤回' })) return
  const data = await guard(() => socialApi<ChatMessage>(`/messages/${message.id}/revoke`, 'POST'), chatError)
  if (data) merge([data])
}

async function answer(message: ChatMessage, accept: boolean) {
  const data = await guard(() => socialApi<ChatMessage>(`/messages/${message.id}/${accept ? 'accept' : 'decline'}`, 'POST'), chatError)
  if (data) merge([data])
  // 邀请失效时服务器已把状态改为 expired，重新拉一次让卡片同步。
  else poll()
}

function openFile(message: ChatMessage) {
  if (!message.data) return
  preview.value = { id: message.id, entry: { name: message.data.name, path: message.id, size: message.data.size, dir: false, mtime: 0 } }
}

// —— 好友 ——

async function friendAction(path: string, done?: () => void) {
  const data = await guard(() => socialApi<FriendsOverview>(path, 'POST'))
  if (!data) return
  overview.value = data
  done?.()
  const chats = await guard(() => socialApi<{ items: Conversation[] }>('/messages/conversations'))
  if (chats) conversations.value = chats.items
  refreshUnread()
}

async function removeFriend(user: Peer) {
  if (!await confirmDialog({ title: `删除好友 ${user.name}？`, message: '删除后双方都不能再发私信，对方无法再打开你发过的文件。聊天记录会保留，再次成为好友后仍能看到。', confirmText: '删除', danger: true })) return
  await friendAction(`/friends/${user.id}/remove`, () => { if (activeId.value === user.id) closeChat() })
}

function friendsChanged(data: FriendsOverview) {
  overview.value = data
  loadAll()
}

// —— 邀请链接 ——

async function loadInvite(token: string) {
  try { invite.value = { token, ...await socialApi<{ user: Person; self: boolean; friend: boolean }>(`/friends/invite/${encodeURIComponent(token)}`) } }
  catch (err) { invite.value = { token, error: err instanceof Error ? err.message : '邀请链接不存在或已失效' } }
}

async function acceptInvite() {
  if (!invite.value) return
  inviteBusy.value = true
  const data = await guard(() => socialApi<FriendsOverview & { friend: Person }>(`/friends/invite/${encodeURIComponent(invite.value!.token)}/accept`, 'POST'))
  inviteBusy.value = false
  if (!data) return
  overview.value = data
  const id = data.friend.id
  invite.value = undefined
  await loadAll()
  openChat(id)
}

function closeInvite() { invite.value = undefined; setUrl() }

// —— 展示 ——

const clock = (seconds: number) => new Date(seconds * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
const day = (seconds: number) => new Date(seconds * 1000).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' })
// 与上一条相隔超过 10 分钟时显示时间分隔。
const showTime = (index: number) => index === 0 || messages.value[index]!.created_at - messages.value[index - 1]!.created_at > 600

function snippet(message: ChatMessage | null) {
  if (!message) return '成为好友了，打个招呼吧'
  if (message.revoked) return message.mine ? '你撤回了一条消息' : '对方撤回了一条消息'
  if (message.kind === 'file') return `[文件] ${message.data?.name ?? ''}`
  if (message.kind === 'doc_invite') return `[协作邀请] ${message.data?.title ?? ''}`
  return message.body
}

const statusText: Record<string, string> = { accepted: '已接受', declined: '已拒绝', expired: '已失效' }

let timer: ReturnType<typeof setInterval> | undefined
let ticks = 0
onMounted(async () => {
  await loadAccount()
  if (!account.value) { loading.value = false; return }
  await loadAll()
  loading.value = false
  const token = params.get('invite')
  if (token) loadInvite(token)
  if (activeId.value && overview.value.friends.some(friend => friend.id === activeId.value)) openChat(activeId.value)
  else if (activeId.value) closeChat()
  // 打开的会话每 4 秒拉一次增量，会话列表与好友申请每 20 秒刷新一次。
  timer = setInterval(() => {
    if (document.visibilityState !== 'visible') return
    poll()
    if (++ticks % 5 === 0) loadAll()
  }, 4000)
})
onBeforeUnmount(() => clearInterval(timer))
watch(account, value => { if (!value) clearInterval(timer) })
</script>

<template>
  <section v-if="accountChecked && !account" class="messages signin">
    <h2>私信</h2>
    <p class="d-muted">{{ params.get('invite') ? '有人邀请你成为好友，登录后即可确认。' : '登录后可以添加好友、发私信，以及分享云盘文件和协作文档。' }}</p>
    <a class="d-btn primary" :href="accountUrl()">登录</a>
  </section>
  <section v-else class="messages" :class="{ chatting: !!activeId }">
    <aside class="side">
      <header class="side-head">
        <h2>私信</h2>
        <button class="d-btn" type="button" @click="adding = true">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 19a6 6 0 0 0-12 0M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm10-3v6m3-3h-6" /></svg>添加好友
        </button>
      </header>
      <div class="tabs" role="tablist">
        <button type="button" role="tab" :aria-selected="tab === 'chats'" :class="{ on: tab === 'chats' }" @click="tab = 'chats'">会话</button>
        <button type="button" role="tab" :aria-selected="tab === 'friends'" :class="{ on: tab === 'friends' }" @click="tab = 'friends'">好友<span v-if="requestCount" class="badge">{{ requestCount }}</span></button>
      </div>
      <p v-if="error" class="d-note error" role="alert">{{ error }}</p>
      <p v-if="loading" class="d-muted empty">正在读取…</p>

      <template v-else-if="tab === 'chats'">
        <div v-if="!conversations.length" class="empty-state">
          <p>还没有好友。添加好友后就可以发私信、分享文件和邀请协作。</p>
          <button class="d-btn primary" type="button" @click="adding = true">添加好友</button>
        </div>
        <ul v-else class="chats">
          <li v-for="item in conversations" :key="item.user.id">
            <button type="button" :class="{ on: item.user.id === activeId }" @click="openChat(item.user.id)">
              <span class="avatar"><img v-if="item.user.avatar" :src="item.user.avatar" alt=""><template v-else>{{ item.user.name.slice(0, 1) }}</template></span>
              <span class="text">
                <span class="line"><strong>{{ item.user.name }}</strong><small>{{ timeAgo(item.at) }}</small></span>
                <span class="line"><span class="snippet">{{ snippet(item.last) }}</span><span v-if="item.unread" class="badge">{{ item.unread > 99 ? '99+' : item.unread }}</span></span>
              </span>
            </button>
          </li>
        </ul>
      </template>

      <div v-else class="friends">
        <template v-if="overview.incoming.length">
          <h3>好友申请</h3>
          <ul>
            <li v-for="request in overview.incoming" :key="request.id">
              <span class="avatar"><img v-if="request.user.avatar" :src="request.user.avatar" alt=""><template v-else>{{ request.user.name.slice(0, 1) }}</template></span>
              <span class="who"><strong>{{ request.user.name }}</strong><small>{{ request.message || request.user.email }}</small></span>
              <span class="actions">
                <button class="d-btn primary small" type="button" @click="friendAction(`/friends/requests/${request.id}/accept`)">同意</button>
                <button class="d-btn small" type="button" @click="friendAction(`/friends/requests/${request.id}/decline`)">拒绝</button>
              </span>
            </li>
          </ul>
        </template>
        <template v-if="overview.outgoing.length">
          <h3>等待对方同意</h3>
          <ul>
            <li v-for="request in overview.outgoing" :key="request.id">
              <span class="avatar"><img v-if="request.user.avatar" :src="request.user.avatar" alt=""><template v-else>{{ request.user.name.slice(0, 1) }}</template></span>
              <span class="who"><strong>{{ request.user.name }}</strong><small>{{ request.user.email }}</small></span>
              <span class="actions"><button class="d-btn small" type="button" @click="friendAction(`/friends/requests/${request.id}/cancel`)">撤回</button></span>
            </li>
          </ul>
        </template>
        <h3>我的好友<span>{{ overview.friends.length }}</span></h3>
        <p v-if="!overview.friends.length" class="d-muted">还没有好友。</p>
        <ul v-else>
          <li v-for="friend in overview.friends" :key="friend.id">
            <span class="avatar"><img v-if="friend.avatar" :src="friend.avatar" alt=""><template v-else>{{ friend.name.slice(0, 1) }}</template></span>
            <span class="who"><strong>{{ friend.name }}</strong><small>{{ friend.email }}</small></span>
            <span class="actions">
              <button class="d-btn small" type="button" @click="openChat(friend.id)">发消息</button>
              <button class="d-btn danger small" type="button" @click="removeFriend(friend)">删除</button>
            </span>
          </li>
        </ul>
      </div>
    </aside>

    <div class="chat">
      <div v-if="!activeId" class="placeholder">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h16v10H9l-4 3.5v-3.5H4Z" /></svg>
        <p>选择一位好友开始聊天</p>
      </div>
      <template v-else>
        <header class="chat-head">
          <button class="back" type="button" aria-label="返回会话列表" @click="closeChat"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 6-6 6 6 6" /></svg></button>
          <template v-if="peer ?? active?.user">
            <span class="avatar"><img v-if="(peer ?? active!.user).avatar" :src="(peer ?? active!.user).avatar" alt=""><template v-else>{{ (peer ?? active!.user).name.slice(0, 1) }}</template></span>
            <span class="who"><strong>{{ (peer ?? active!.user).name }}</strong><small>{{ (peer ?? active!.user).email }}</small></span>
            <button class="d-btn quiet small" type="button" @click="removeFriend((peer ?? active!.user))">删除好友</button>
          </template>
        </header>

        <div ref="list" class="log" aria-live="polite">
          <button v-if="more" class="d-btn quiet small older" type="button" :disabled="loadingOlder" @click="loadOlder">{{ loadingOlder ? '正在读取…' : '查看更早的消息' }}</button>
          <p v-if="peer && !messages.length" class="d-muted hello">你们已经是好友了，发条消息打个招呼吧。</p>
          <template v-for="(message, index) in messages" :key="message.id">
            <p v-if="showTime(index)" class="stamp">{{ day(message.created_at) }} {{ clock(message.created_at) }}</p>
            <p v-if="message.revoked" class="revoked">{{ message.mine ? '你撤回了一条消息' : '对方撤回了一条消息' }}</p>
            <div v-else class="msg" :class="{ mine: message.mine }">
              <div v-if="message.kind === 'text'" class="bubble" :title="clock(message.created_at)">{{ message.body }}</div>

              <div v-else-if="message.kind === 'file' && message.data" class="card file">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="kindIcons[kindOf(message.data.name)]" /></svg>
                <div class="card-body">
                  <strong :title="message.data.name">{{ message.data.name }}</strong>
                  <small>{{ formatSize(message.data.size) }}{{ message.mine && message.data.path ? ` · ${message.data.path}` : '' }}</small>
                  <div class="card-actions">
                    <button class="d-btn small" type="button" @click="openFile(message)">查看</button>
                    <a class="d-btn small" :href="messageFileUrl(message.id)" download>下载</a>
                  </div>
                </div>
              </div>

              <div v-else-if="message.kind === 'doc_invite' && message.data" class="card doc">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20V3.5ZM14 3.5V8h4M10 12h5M10 15.5h5" /></svg>
                <div class="card-body">
                  <small class="eyebrow">协作邀请</small>
                  <strong>{{ message.data.title }}</strong>
                  <small>{{ message.mine ? '邀请对方' : '邀请你' }}{{ roleName[message.data.role ?? 'view'] }}{{ message.data.can_share ? '，可再分享' : '' }}</small>
                  <div class="card-actions">
                    <template v-if="message.data.status === 'pending' && !message.mine">
                      <button class="d-btn primary small" type="button" @click="answer(message, true)">接受</button>
                      <button class="d-btn small" type="button" @click="answer(message, false)">拒绝</button>
                    </template>
                    <span v-else-if="message.data.status === 'pending'" class="state">等待对方接受</span>
                    <span v-else class="state" :class="message.data.status">{{ statusText[message.data.status ?? ''] }}</span>
                    <a v-if="message.data.status === 'accepted' || message.mine" class="d-btn small" :href="docUrl(message.data.doc_id!)">打开文档</a>
                  </div>
                </div>
              </div>

              <button v-if="message.mine" class="revoke" type="button" title="撤回" aria-label="撤回这条消息" @click="revoke(message)">撤回</button>
            </div>
          </template>
        </div>

        <p v-if="chatError" class="d-note error chat-error" role="alert">{{ chatError }}</p>
        <form class="composer" @submit.prevent="sendText">
          <div class="tools">
            <button v-if="features.drive" class="tool" type="button" title="发送云盘文件" aria-label="发送云盘文件" :disabled="!peer" @click="pickingFile = true">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 18.5h11a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.1 4.75 4.75 0 0 0 6.5 18.5Z" /></svg>
            </button>
            <button class="tool" type="button" title="邀请协作文档" aria-label="邀请协作文档" :disabled="!peer" @click="pickingDoc = true">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20V3.5ZM14 3.5V8h4M10 12h5M10 15.5h5" /></svg>
            </button>
          </div>
          <textarea v-model="draft" class="d-input" rows="1" maxlength="2000" placeholder="输入消息，Enter 发送，Shift+Enter 换行" aria-label="消息内容" :disabled="!peer" @keydown="onKey" />
          <button class="d-btn primary" type="submit" :disabled="!peer || sending || !draft.trim()">发送</button>
        </form>
      </template>
    </div>

    <AddFriend v-if="adding" @close="adding = false" @changed="friendsChanged" />
    <FilePicker v-if="pickingFile" @close="pickingFile = false" @pick="sendFile" />
    <DocInvitePicker v-if="pickingDoc && peer" :name="peer.name" @close="pickingDoc = false" @pick="sendInvite" />
    <PreviewDialog v-if="preview" :entry="preview.entry" :url="inline => messageFileUrl(preview!.id, inline)" @close="preview = undefined" />
    <DriveDialog v-if="invite" title="好友邀请" @close="closeInvite">
      <p v-if="invite.error" class="d-note error">{{ invite.error }}</p>
      <template v-else-if="invite.user">
        <div class="invite-who">
          <span class="avatar large"><img v-if="invite.user.avatar" :src="invite.user.avatar" alt=""><template v-else>{{ invite.user.name.slice(0, 1) }}</template></span>
          <p v-if="invite.self">这是你自己的邀请链接，发给别人，对方打开后即可添加你为好友。</p>
          <p v-else-if="invite.friend">你和 <strong>{{ invite.user.name }}</strong> 已经是好友了。</p>
          <p v-else><strong>{{ invite.user.name }}</strong> 邀请你成为好友。成为好友后可以互发私信、分享文件和邀请协作。</p>
        </div>
        <div class="d-actions">
          <button class="d-btn" type="button" @click="closeInvite">{{ invite.self || invite.friend ? '关闭' : '暂不' }}</button>
          <button v-if="invite.friend" class="d-btn primary" type="button" @click="openChat(invite.user.id); invite = undefined">发消息</button>
          <button v-else-if="!invite.self" class="d-btn primary" type="button" :disabled="inviteBusy" @click="acceptInvite">成为好友</button>
        </div>
      </template>
      <p v-else class="d-muted">正在读取…</p>
    </DriveDialog>
  </section>
</template>

<style scoped>
.signin { display:grid; justify-items:start; gap:12px; }
h2 { font-size:20px; }
.messages:not(.signin) { display:grid; grid-template-columns:320px minmax(0,1fr); height:min(720px,calc(100vh - var(--header-h) - 88px)); min-height:480px; border:1px solid var(--line); border-radius:var(--radius); background:var(--surface); overflow:hidden; }
.avatar { flex:none; display:grid; place-items:center; width:38px; height:38px; border-radius:50%; overflow:hidden; background:var(--accent-soft); color:var(--accent); font-weight:600; }
.avatar img { width:100%; height:100%; object-fit:cover; }
.avatar.large { width:56px; height:56px; font-size:22px; }
.badge { display:inline-grid; place-items:center; min-width:18px; height:18px; padding:0 5px; border-radius:9px; background:#e0607e; color:#fff; font-size:11px; font-weight:600; line-height:1; }
.small { padding:5px 10px; font-size:12.5px; }

/* —— 侧栏 —— */
.side { display:flex; flex-direction:column; min-height:0; border-right:1px solid var(--line); }
.side-head { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:18px 18px 12px; }
.tabs { display:flex; gap:6px; padding:0 18px 12px; border-bottom:1px solid var(--line); }
.tabs button { display:flex; align-items:center; gap:6px; padding:6px 14px; border:1px solid var(--line); border-radius:999px; background:none; color:var(--text-2); font:13px var(--font); cursor:pointer; transition:all .2s; }
.tabs button.on { border-color:var(--accent); background:var(--accent-soft); color:var(--accent); }
.side > .d-note { margin:12px 18px 0; }
.empty { padding:28px 18px; }
.empty-state { display:grid; justify-items:center; gap:14px; padding:40px 24px; color:var(--muted); font-size:13.5px; text-align:center; line-height:1.7; }
.chats { flex:1; list-style:none; margin:0; padding:6px; overflow:auto; }
.chats button { display:flex; align-items:center; gap:12px; width:100%; padding:10px 12px; border:0; border-radius:12px; background:none; color:var(--text); font:14px var(--font); text-align:left; cursor:pointer; transition:background .15s; }
.chats button:hover { background:var(--bg-tint); }
.chats button.on { background:var(--accent-soft); }
.text { flex:1; display:flex; flex-direction:column; gap:3px; min-width:0; }
.line { display:flex; align-items:center; justify-content:space-between; gap:8px; min-width:0; }
.line strong { font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.line small { flex:none; color:var(--faint); font-size:11.5px; }
.snippet { flex:1; min-width:0; color:var(--muted); font-size:12.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.friends { flex:1; overflow:auto; padding:6px 18px 18px; }
.friends h3 { display:flex; align-items:center; gap:6px; margin:16px 0 8px; color:var(--muted); font-size:12.5px; font-weight:500; }
.friends h3 span { color:var(--faint); }
.friends ul { list-style:none; margin:0; padding:0; }
.friends li { display:flex; align-items:center; gap:10px; padding:9px 0; border-bottom:1px solid var(--line); }
.friends .avatar { width:34px; height:34px; }
.who { flex:1; display:flex; flex-direction:column; min-width:0; }
.who strong { font-weight:500; font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.who small { color:var(--faint); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.actions { display:flex; gap:6px; flex:none; }

/* —— 会话 —— */
.chat { display:flex; flex-direction:column; min-width:0; min-height:0; background:var(--bg); }
.placeholder { flex:1; display:grid; place-content:center; justify-items:center; gap:10px; color:var(--muted); font-size:14px; }
.placeholder svg, .tool svg, .back svg, .card > svg { fill:none; stroke:currentColor; stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round; }
.placeholder svg { width:40px; height:40px; color:var(--faint); }
.chat-head { display:flex; align-items:center; gap:12px; padding:14px 18px; border-bottom:1px solid var(--line); background:var(--surface); }
.back { display:none; flex:none; width:32px; height:32px; padding:4px; border:0; border-radius:8px; background:none; color:var(--text-2); cursor:pointer; }
.back svg { width:22px; height:22px; }
.log { flex:1; overflow:auto; padding:18px 20px; display:flex; flex-direction:column; gap:10px; }
.older { align-self:center; }
.hello, .stamp, .revoked { align-self:center; margin:4px 0; color:var(--faint); font-size:12px; }
.msg { display:flex; align-items:flex-end; gap:8px; max-width:78%; }
.msg.mine { align-self:flex-end; flex-direction:row-reverse; }
.bubble { padding:9px 13px; border-radius:16px 16px 16px 4px; background:var(--surface); border:1px solid var(--line); color:var(--text); font-size:14px; line-height:1.6; white-space:pre-wrap; overflow-wrap:anywhere; }
.mine .bubble { border-color:transparent; border-radius:16px 16px 4px 16px; background:var(--accent); color:#fff; }
.revoke { flex:none; padding:2px 6px; border:0; border-radius:6px; background:none; color:var(--faint); font:12px var(--font); cursor:pointer; opacity:0; transition:opacity .2s,color .2s; }
.msg:hover .revoke, .revoke:focus-visible { opacity:1; }
.revoke:hover { color:#d15c5c; }
.card { display:flex; gap:12px; width:min(320px,100%); padding:14px; border:1px solid var(--line); border-radius:14px; background:var(--surface); }
.mine .card { border-color:color-mix(in srgb,var(--accent) 35%,var(--line)); }
.card > svg { flex:none; width:30px; height:30px; color:var(--accent); }
.card-body { flex:1; display:flex; flex-direction:column; gap:3px; min-width:0; }
.card-body strong { font-weight:500; font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.card-body small { color:var(--faint); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.card-body .eyebrow { color:var(--accent); letter-spacing:.06em; }
.card-actions { display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin-top:8px; }
.state { color:var(--muted); font-size:12.5px; margin-right:4px; }
.state.accepted { color:#2f9e6e; }
.state.declined, .state.expired { color:var(--faint); }
.chat-error { margin:0 18px 8px; }
.composer { display:flex; align-items:flex-end; gap:8px; padding:12px 14px; border-top:1px solid var(--line); background:var(--surface); }
.composer textarea { flex:1; min-width:0; min-height:42px; max-height:160px; resize:none; field-sizing:content; }
.tools { display:flex; gap:2px; padding-bottom:4px; }
.tool { display:grid; place-items:center; width:34px; height:34px; border:0; border-radius:9px; background:none; color:var(--muted); cursor:pointer; transition:background .15s,color .15s; }
.tool:hover:not(:disabled) { background:var(--bg-tint); color:var(--accent); }
.tool:disabled { opacity:.4; cursor:default; }
.tool svg { width:20px; height:20px; }
.invite-who { display:flex; align-items:center; gap:14px; margin-top:12px; color:var(--text-2); font-size:14px; line-height:1.7; }
.invite-who p { margin:0; }

@media (hover:none) { .revoke { opacity:1; } }
@media (max-width:760px) {
  .messages:not(.signin) { grid-template-columns:1fr; height:calc(100dvh - var(--header-h) - 48px); min-height:0; border-radius:16px; }
  .messages.chatting .side { display:none; }
  .messages:not(.chatting) .chat { display:none; }
  .side { border-right:0; }
  .back { display:block; }
  .msg { max-width:88%; }
  .log { padding:14px; }
  .chat-head { padding:10px 12px; }
}
</style>

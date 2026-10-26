<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { account, accountChecked, csrfToken, loadAccount } from '../../account'
import { accountUrl, mainSite } from '../../drive'
import { CLOSE_FORBIDDEN, CLOSE_GONE, CLOSE_LOGIN, CLOSE_RECONNECT, colorOf, docsApi, roleName, timeAgo, withLink } from '../../docs'
import { connect } from '../../docs-live'
import type { DocItem, DocLinkInfo } from '../../docs'
import '../../styles/drive.css'
import DriveTopBar from '../drive/DriveTopBar.vue'
import MarkdownEditor from '../editor/MarkdownEditor.vue'
import DocHistory from './DocHistory.vue'
import DocShare from './DocShare.vue'

// /doc/<id> 直接打开；/d/<token> 是链接分享，先解析出文档再按链接权限打开。
const match = /^\/(doc|d)\/([A-Za-z0-9]+)\/?$/.exec(location.pathname)!
const byLink = match[1] === 'd'
const link = byLink ? match[2] : ''
const docId = ref(byLink ? '' : match[2])

const doc = ref<DocItem>()
const state = ref<'loading' | 'password' | 'login' | 'forbidden' | 'gone' | 'ready'>('loading')
const message = ref('')
const password = ref(''), unlocking = ref(false)
const session = shallowRef<ReturnType<typeof connect>>()
const status = ref<'connecting' | 'connected' | 'disconnected'>('connecting')
const synced = ref(false)
const peers = ref<{ id: number; name: string; color: string }[]>([])
const sharing = ref(false), history = ref(false)
// 大纲：宽屏默认显示在正文左侧，记住用户的选择。
// 宽屏记住用户的选择（默认展开）；窄屏是盖在正文上的抽屉，默认收起。
const wide = () => matchMedia('(min-width: 1101px)').matches
const outlineOpen = ref(wide() && (() => { try { return localStorage.getItem('doc-outline') !== '0' } catch { return true } })())
function toggleOutline() {
  outlineOpen.value = !outlineOpen.value
  if (wide()) try { localStorage.setItem('doc-outline', outlineOpen.value ? '1' : '0') } catch { /* 隐私模式下忽略 */ }
}
function jump(pos: number) {
  editor.value?.jumpTo(pos)
  if (!wide()) outlineOpen.value = false
}
const headings = computed(() => editor.value?.headings ?? [])
const words = computed(() => editor.value?.words ?? 0)
const editor = ref<InstanceType<typeof MarkdownEditor>>()
const title = ref('')
const listUrl = `${mainSite}/docs`

const canEdit = computed(() => doc.value?.role === 'owner' || doc.value?.role === 'edit')
// 阅读模式只影响当前页面：编辑器变为只读、收起工具栏，不改变权限，也不影响其他协作者。
const reading = ref(false)
const editable = computed(() => canEdit.value && !reading.value)
const me = computed(() => ({ name: account.value?.name ?? '访客', color: colorOf(account.value?.id ?? 'guest') }))
const collab = computed(() => session.value ? { doc: session.value.doc, provider: session.value.provider, user: me.value } : undefined)

async function start() {
  state.value = 'loading'
  await loadAccount()
  try {
    if (byLink) {
      const info = await docsApi<DocLinkInfo>(`/link/${link}`)
      docId.value = info.id
      if (info.needs_password && !info.unlocked) { state.value = 'password'; return }
    }
    doc.value = await docsApi<DocItem>(withLink(`/${docId.value}`, link))
    title.value = doc.value.title
    document.title = `${doc.value.title} · Copy Lee`
    open()
  } catch (err) {
    const code = (err as { status?: number }).status
    message.value = err instanceof Error ? err.message : '读取失败'
    state.value = code === 401 && !account.value ? 'login' : code === 401 ? 'password' : code === 404 ? 'gone' : 'forbidden'
  }
}

function open() {
  close()
  synced.value = false
  const next = connect(docId.value, link, code => {
    if (code === CLOSE_RECONNECT) { void reload(); return }
    state.value = code === CLOSE_LOGIN ? 'login' : code === CLOSE_GONE ? 'gone' : 'forbidden'
    message.value = code === CLOSE_GONE ? '文档已被删除。' : code === CLOSE_FORBIDDEN ? '你已没有这篇文档的访问权限。' : ''
    close()
  })
  next.provider.on('status', ({ status: value }: { status: typeof status.value }) => { status.value = value })
  next.provider.on('sync', (value: boolean) => { synced.value = value })
  next.provider.awareness.on('change', () => {
    peers.value = [...next.provider.awareness.getStates().entries()]
      .filter(([id, value]) => id !== next.doc.clientID && value.user)
      .map(([id, value]) => ({ id, name: value.user.name as string, color: value.user.color as string }))
  })
  session.value = next
  state.value = 'ready'
}

function close() {
  session.value?.provider.destroy()
  session.value?.doc.destroy()
  session.value = undefined
}

// 权限变化后服务器要求重连：重新读取权限，编辑器按新的权限重建。
async function reload() {
  try { doc.value = await docsApi<DocItem>(withLink(`/${docId.value}`, link)); open() }
  catch { state.value = 'forbidden'; message.value = '你已没有这篇文档的访问权限。'; close() }
}

async function unlock() {
  unlocking.value = true; message.value = ''
  try { await docsApi(`/link/${link}/unlock`, 'POST', { password: password.value }); await start() }
  catch (err) { message.value = err instanceof Error ? err.message : '密码错误' }
  finally { unlocking.value = false }
}

let titleTimer = 0
function onTitle() {
  clearTimeout(titleTimer)
  titleTimer = window.setTimeout(async () => {
    if (!doc.value || !title.value.trim() || title.value === doc.value.title) return
    try { doc.value = { ...doc.value, ...(await docsApi<DocItem>(withLink(`/${doc.value.id}`, link), 'PATCH', { title: title.value })) }; document.title = `${doc.value.title} · Copy Lee` }
    catch (err) { message.value = err instanceof Error ? err.message : '标题保存失败' }
  }, 600)
}

function exportMarkdown() {
  const markdown = editor.value?.getMarkdown() ?? ''
  const blob = new Blob([`# ${doc.value?.title ?? ''}\n\n${markdown}`], { type: 'text/markdown;charset=utf-8' })
  const anchor = document.createElement('a')
  anchor.href = URL.createObjectURL(blob)
  anchor.download = `${(doc.value?.title || '文档').replace(/[\\/:*?"<>|]/g, '_')}.md`
  anchor.click()
  URL.revokeObjectURL(anchor.href)
}

// 粘贴、拖入或从工具栏选择的图片上传到这篇文档的图片存储，返回插入正文的地址。
async function uploadImage(file: File) {
  if (file.size > 10 * 1024 * 1024) throw new Error('图片不能超过 10 MiB')
  const response = await fetch(`/api/docs${withLink(`/${docId.value}/images`, link)}`, {
    method: 'POST', body: file, credentials: 'same-origin',
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-CSRF-Token': csrfToken() },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '图片上传失败')
  return data.url as string
}

function restore(content: object) {
  editor.value?.setJSON(content)
  history.value = false
}

// 只读且不允许复制时拦下复制与拖拽；这只是界面限制，无法阻止截屏或查看源码。
function guard(event: Event) {
  if (doc.value && !doc.value.can_copy) event.preventDefault()
}

const statusText = computed(() => status.value === 'connected' ? (synced.value ? '已同步' : '同步中…') : status.value === 'connecting' ? '连接中…' : '连接已断开，正在重试…')
const loginUrl = accountUrl()

onMounted(start)
onBeforeUnmount(() => { clearTimeout(titleTimer); close() })
</script>

<template>
  <div class="doc-shell">
    <DriveTopBar />
    <main v-if="state !== 'ready'" class="state">
      <div class="state-card">
        <template v-if="state === 'loading'"><p class="d-muted">正在打开文档…</p></template>
        <template v-else-if="state === 'password'">
          <h1>需要访问密码</h1>
          <p>这篇文档的分享链接设置了密码。</p>
          <form class="unlock" @submit.prevent="unlock">
            <input v-model="password" class="d-input" type="password" placeholder="访问密码" autocomplete="off" required>
            <button class="d-btn primary" type="submit" :disabled="unlocking">打开</button>
          </form>
          <p v-if="message" class="d-note error">{{ message }}</p>
        </template>
        <template v-else-if="state === 'login'">
          <h1>登录后查看</h1>
          <p>{{ message || '这篇文档需要登录后才能访问。' }}</p>
          <a class="d-btn primary" :href="loginUrl">登录</a>
        </template>
        <template v-else-if="state === 'gone'">
          <h1>文档不存在</h1>
          <p>{{ message || '文档可能已被删除，或链接已失效。' }}</p>
          <a class="d-btn" :href="listUrl">我的文档</a>
        </template>
        <template v-else>
          <h1>无法访问</h1>
          <p>{{ message || '你没有这篇文档的访问权限，可以联系所有者邀请你。' }}</p>
          <a v-if="accountChecked && !account" class="d-btn primary" :href="loginUrl">登录</a>
          <a v-else class="d-btn" :href="listUrl">我的文档</a>
        </template>
      </div>
    </main>

    <template v-else-if="doc">
      <div class="doc-bar">
        <a class="back" :href="listUrl" title="我的文档" aria-label="返回文档列表"><svg viewBox="0 0 24 24"><path d="m14 6-6 6 6 6" /></svg></a>
        <div class="meta">
          <span class="status" :class="status"><i />{{ statusText }}</span>
          <span class="d-muted">{{ roleName[doc.role] }}<template v-if="doc.updated_by"> · {{ doc.updated_by.name }} {{ timeAgo(doc.updated_at) }}编辑</template> · {{ words.toLocaleString() }} 字</span>
        </div>
        <div class="peers" :aria-label="`${peers.length} 人在线`">
          <span v-for="peer in peers.slice(0, 5)" :key="peer.id" class="peer" :style="{ background: peer.color }" :title="peer.name">{{ peer.name.slice(0, 1) }}</span>
          <span v-if="peers.length > 5" class="peer more">+{{ peers.length - 5 }}</span>
        </div>
        <div class="actions">
          <button v-if="canEdit" class="d-btn mode-toggle" :class="{ on: reading }" type="button" :aria-pressed="reading" :title="reading ? '回到编辑' : '只读预览，避免误修改（只影响当前页面）'" @click="reading = !reading">{{ reading ? '编辑' : '阅读' }}</button>
          <button class="d-btn outline-toggle" :class="{ on: outlineOpen }" type="button" :aria-pressed="outlineOpen" @click="toggleOutline">大纲</button>
          <button v-if="canEdit" class="d-btn" type="button" @click="history = true">历史</button>
          <button v-if="doc.can_copy" class="d-btn" type="button" @click="exportMarkdown">导出</button>
          <button v-if="doc.can_share" class="d-btn primary" type="button" @click="sharing = true">分享</button>
        </div>
      </div>
      <p v-if="!canEdit" class="readonly">
        {{ account ? '你只能查看这篇文档。' : '你正在以访客身份查看，访客不能编辑。' }}
        <a v-if="!account" :href="loginUrl">登录</a>
      </p>
      <div class="doc-body" :class="{ 'with-outline': outlineOpen }">
        <aside class="outline" :class="{ open: outlineOpen }" aria-label="文档大纲" :aria-hidden="!outlineOpen" :inert="!outlineOpen">
          <div class="outline-head">
            <span>大纲</span>
            <button type="button" class="outline-close" aria-label="收起大纲" title="收起大纲" @click="toggleOutline"><svg viewBox="0 0 24 24"><path d="m14 6-6 6 6 6" /></svg></button>
          </div>
          <nav class="outline-list">
            <p v-if="!headings.length" class="outline-empty">使用标题后，这里会列出文档结构。</p>
            <button v-for="item in headings" :key="item.pos" type="button" :style="{ paddingLeft: `${(item.level - 1) * 14 + 12}px` }" :class="`level-${item.level}`" @click="jump(item.pos)">{{ item.text || '（空标题）' }}</button>
          </nav>
          <p class="outline-count">{{ words.toLocaleString() }} 字 · {{ headings.length }} 个标题</p>
        </aside>
        <div v-if="outlineOpen" class="outline-scrim" @click="toggleOutline" />
        <article class="paper" :class="{ 'no-copy': !doc.can_copy }" @copy="guard" @cut="guard" @dragstart="guard" @contextmenu="guard">
          <input v-model="title" class="title" :readonly="!editable" maxlength="200" placeholder="未命名文档" aria-label="标题" @input="onTitle">
          <MarkdownEditor v-if="collab" :key="`${doc.role}-${session?.doc.guid}`" ref="editor" :collab="collab" :editable="editable" :upload="editable && account ? uploadImage : undefined" />
        </article>
      </div>
      <DocShare v-if="sharing" :doc="doc" @close="sharing = false" @changed="value => doc = { ...doc!, ...value }" />
      <DocHistory v-if="history" :doc-id="doc.id" :link="link" @close="history = false" @restore="restore" />
    </template>
  </div>
</template>

<style scoped>
.doc-shell { min-height:100vh; }
.state { display:grid; place-items:center; min-height:70vh; padding:24px; }
.state-card { width:min(440px,100%); padding:36px; border:1px solid var(--line); border-radius:var(--radius); background:var(--surface); text-align:center; box-shadow:0 30px 60px -40px rgba(17,24,39,.35); }
.state-card h1 { font-size:24px; letter-spacing:-.02em; }
.state-card p { margin:10px 0 22px; color:var(--muted); font-size:14px; line-height:1.7; }
.unlock { display:flex; gap:8px; }
.unlock input { flex:1; }
.doc-bar { position:sticky; top:var(--header-h); z-index:15; display:flex; align-items:center; gap:14px; padding:10px clamp(16px,3vw,32px); border-bottom:1px solid var(--line); background:var(--header-bg); -webkit-backdrop-filter:blur(16px); backdrop-filter:blur(16px); }
.back { display:grid; place-items:center; width:32px; height:32px; border-radius:8px; color:var(--muted); transition:background .2s,color .2s; }
.back:hover { background:color-mix(in srgb,var(--text) 6%,transparent); color:var(--text); }
.back svg { width:20px; height:20px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
.meta { flex:1; display:flex; align-items:center; gap:14px; min-width:0; font-size:12.5px; white-space:nowrap; overflow:hidden; }
.status { display:inline-flex; align-items:center; gap:6px; color:var(--muted); }
.status i { width:7px; height:7px; border-radius:50%; background:#d9822b; }
.status.connected i { background:#2f9e6e; }
.status.disconnected i { background:#d15c5c; }
.peers { display:flex; }
.peer { display:grid; place-items:center; width:28px; height:28px; margin-left:-6px; border:2px solid var(--bg); border-radius:50%; color:#fff; font-size:12px; font-weight:600; }
.peer.more { background:var(--muted); }
.actions { display:flex; gap:8px; }
.readonly { max-width:860px; margin:16px auto 0; padding:10px 14px; border-radius:10px; background:var(--accent-soft); color:var(--text-2); font-size:13px; }
.readonly a { margin-left:8px; color:var(--accent); }
.doc-body { display:grid; grid-template-columns:0 minmax(0,1fr); }
.doc-body.with-outline { grid-template-columns:268px minmax(0,1fr); }
.outline { position:sticky; top:calc(var(--header-h) + 53px); align-self:start; display:flex; flex-direction:column; width:268px; height:calc(100vh - var(--header-h) - 53px); border-right:1px solid var(--line); background:var(--bg); overflow:hidden; opacity:0; visibility:hidden; transform:translateX(-12px); transition:opacity .25s ease,transform .3s var(--ease),visibility .3s; }
.outline.open { opacity:1; visibility:visible; transform:none; }
.outline-head { display:flex; align-items:center; justify-content:space-between; padding:18px 12px 10px 22px; color:var(--faint); font-size:12px; font-weight:600; letter-spacing:.12em; }
.outline-close { display:grid; place-items:center; width:28px; height:28px; border:0; border-radius:7px; background:none; color:var(--muted); cursor:pointer; transition:background .2s,color .2s; }
.outline-close:hover { background:color-mix(in srgb,var(--text) 6%,transparent); color:var(--text); }
.outline-close svg { width:18px; height:18px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
.outline-list { flex:1; display:flex; flex-direction:column; gap:1px; padding:0 10px; overflow:auto; scrollbar-width:thin; }
.outline-list button { flex:none; padding:6px 12px; border:0; border-radius:8px; background:none; color:var(--text-2); font:13.5px/1.5 var(--font); text-align:left; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:pointer; transition:background .2s,color .2s; }
.outline-list button:hover { background:color-mix(in srgb,var(--text) 5%,transparent); color:var(--text); }
.outline-list button.level-1 { color:var(--text); font-weight:600; }
.outline-empty { margin:4px 12px; color:var(--faint); font-size:12.5px; line-height:1.7; }
.outline-count { margin:0; padding:12px 22px 16px; border-top:1px solid var(--line); color:var(--faint); font:12px var(--font-mono); }
.outline-toggle.on, .mode-toggle.on { border-color:var(--accent); color:var(--accent); }
.outline-scrim { display:none; }
/* 窄屏：大纲作为抽屉盖在正文上，点遮罩收起 */
@media (max-width:1100px) {
  .doc-body, .doc-body.with-outline { grid-template-columns:minmax(0,1fr); }
  .outline { position:fixed; top:0; left:0; z-index:70; height:100vh; height:100dvh; width:min(300px,84vw); box-shadow:12px 0 40px -20px rgba(17,24,39,.4); transform:translateX(-100%); }
  .outline.open { transform:none; }
  .outline-scrim { display:block; position:fixed; inset:0; z-index:69; background:rgba(12,13,16,.35); }
  .paper { grid-column:1; }
}
.paper { box-sizing:border-box; width:100%; max-width:860px; margin:0 auto; padding:36px clamp(16px,4vw,24px) 40px; }
.paper :deep(.md-toolbar:not(.docked)) { top:calc(var(--header-h) + 53px); }
.title { width:100%; margin:0 0 18px; padding:0; border:0; background:none; color:var(--text); font:800 clamp(1.9rem,4vw,2.6rem)/1.2 var(--font); letter-spacing:-.03em; outline:none; }
.title::placeholder { color:var(--faint); }
.no-copy :deep(.md-content) { user-select:none; -webkit-user-select:none; }
@media (max-width:760px) {
  .doc-bar { gap:10px; }
  .meta .d-muted { display:none; }
  .actions .d-btn { padding:7px 10px; }
  .paper { padding-top:24px; }
}
</style>

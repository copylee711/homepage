<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { account, accountChecked, csrfToken, loadAccount } from '../../account'
import { accountUrl, mainSite } from '../../drive'
import { CLOSE_FORBIDDEN, CLOSE_GONE, CLOSE_LOGIN, CLOSE_RECONNECT, colorOf, docsApi, roleName, timeAgo, withLink } from '../../docs'
import { connect } from '../../docs-live'
import type { DocItem, DocLinkInfo } from '../../docs'
import '../../styles/drive.css'
import DriveTopBar from '../drive/DriveTopBar.vue'
import AppIcon from '../AppIcon.vue'
import LogoMark from '../LogoMark.vue'
import { useTheme } from '../../composables/useTheme'
import MarkdownEditor from '../editor/MarkdownEditor.vue'
import DocHistory from './DocHistory.vue'
import DocShare from './DocShare.vue'
import ImageSettings from './ImageSettings.vue'
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuSeparator, DropdownMenuTrigger } from 'reka-ui'

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
const sharing = ref(false), history = ref(false), menuOpen = ref(false)
const imageSettings = ref<'doc' | 'user' | null>(null)
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
const profileUrl = mainSite ? `${mainSite}/account` : '/account'
const { theme, toggle: toggleTheme } = useTheme()

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
  <!-- 编辑页不显示站点顶栏，文档栏顶到最上方，给正文腾出空间；加载、登录等状态页仍显示顶栏。 -->
  <div class="doc-shell" :class="{ editing: state === 'ready' }">
    <DriveTopBar v-if="state !== 'ready'" />
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
        <a class="brand" :href="mainSite || '/'" title="Copy Lee 主页" aria-label="返回主页"><LogoMark class="logo" /></a>
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
          <!-- 宽屏：常用操作是无边框图标按钮；导出、图片存储等收进“更多”。窄屏只留分享与“更多”。 -->
          <button v-if="canEdit" class="tool wide-only mode-toggle" :class="{ on: reading }" type="button" :aria-pressed="reading" :aria-label="reading ? '回到编辑' : '阅读模式'" :data-tip="reading ? '回到编辑' : '阅读模式（只影响当前页面）'" @click="reading = !reading">
            <svg v-if="reading" viewBox="0 0 24 24"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4ZM13.5 6.5l4 4" /></svg>
            <svg v-else viewBox="0 0 24 24"><path d="M12 6.5C10.5 5 8 4.5 4 4.5v13c4 0 6.5.5 8 2 1.5-1.5 4-2 8-2v-13c-4 0-6.5.5-8 2Zm0 0v13" /></svg>
          </button>
          <button class="tool wide-only outline-toggle" :class="{ on: outlineOpen }" type="button" :aria-pressed="outlineOpen" aria-label="大纲" data-tip="大纲" @click="toggleOutline">
            <svg viewBox="0 0 24 24"><path d="M5 6h14M9 12h10M13 18h6M5 12h.01M5 18h.01M9 18h.01" /></svg>
          </button>
          <button v-if="canEdit" class="tool wide-only" type="button" aria-label="版本历史" data-tip="版本历史" @click="history = true">
            <svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.3-5.6L4 8.7M4 4v4.7h4.7M12 8v4.5l3 2" /></svg>
          </button>
          <DropdownMenuRoot v-model:open="menuOpen">
            <DropdownMenuTrigger class="tool" aria-label="更多操作" data-tip="更多">
              <svg viewBox="0 0 24 24"><path d="M6 12h.01M12 12h.01M18 12h.01" /></svg>
            </DropdownMenuTrigger>
            <DropdownMenuPortal>
              <DropdownMenuContent class="doc-menu" align="end" :side-offset="8" :collision-padding="12">
                <DropdownMenuItem v-if="canEdit" class="doc-menu-item narrow-only" @select="reading = !reading">{{ reading ? '回到编辑' : '阅读模式' }}</DropdownMenuItem>
                <DropdownMenuItem class="doc-menu-item narrow-only" @select="toggleOutline">{{ outlineOpen ? '收起大纲' : '大纲' }}</DropdownMenuItem>
                <DropdownMenuItem v-if="canEdit" class="doc-menu-item narrow-only" @select="history = true">版本历史</DropdownMenuItem>
                <DropdownMenuItem v-if="doc.can_copy" class="doc-menu-item" @select="exportMarkdown">导出 Markdown</DropdownMenuItem>
                <DropdownMenuSeparator v-if="doc.role === 'owner' || account" class="doc-menu-sep" />
                <DropdownMenuItem v-if="doc.role === 'owner'" class="doc-menu-item" @select="imageSettings = 'doc'">这篇文档的图片存储</DropdownMenuItem>
                <DropdownMenuItem v-if="account" class="doc-menu-item" @select="imageSettings = 'user'">我的默认图片存储</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenuPortal>
          </DropdownMenuRoot>
          <button v-if="doc.can_share" class="share-btn" type="button" @click="sharing = true">
            <svg viewBox="0 0 24 24"><path d="M12 15V4m0 0L8 8m4-4 4 4M5 13v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" /></svg>分享
          </button>
        </div>
        <div class="corner">
          <button class="icon-btn" type="button" :aria-label="theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'" @click="toggleTheme"><AppIcon :name="theme === 'dark' ? 'moon' : 'sun'" /></button>
          <a class="avatar" :href="account ? profileUrl : loginUrl" :title="account ? account.name : '登录'" :aria-label="account ? `账户：${account.name}` : '登录'">
            <img v-if="account?.avatar" :src="account.avatar" alt="">
            <span v-else-if="account">{{ account.name.slice(0, 1).toUpperCase() }}</span>
            <svg v-else viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.5" r="3.5" /><path d="M5 19.5a7 7 0 0 1 14 0" /></svg>
          </a>
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
      <ImageSettings v-if="imageSettings" :doc-id="imageSettings === 'doc' ? doc.id : undefined" @close="imageSettings = null" />
      <DocShare v-if="sharing" :doc="doc" @close="sharing = false" @changed="value => doc = { ...doc!, ...value }" />
      <DocHistory v-if="history" :doc-id="doc.id" :link="link" @close="history = false" @restore="restore" />
    </template>
  </div>
</template>

<style scoped>
.doc-shell { min-height:100vh; }
.doc-shell.editing { --header-h: 0px; }
.brand { display:grid; place-items:center; width:32px; height:32px; color:var(--text); }
.brand .logo { width:26px; height:auto; }
.corner { display:flex; align-items:center; gap:6px; margin-left:4px; padding-left:12px; border-left:1px solid var(--line); }
.icon-btn, .avatar { display:grid; place-items:center; width:32px; height:32px; border-radius:50%; overflow:hidden; color:var(--muted); }
.icon-btn { border:0; background:none; cursor:pointer; transition:background .2s,color .2s; }
.icon-btn:hover { background:color-mix(in srgb,var(--text) 6%,transparent); color:var(--text); }
.icon-btn :deep(svg) { width:18px; height:18px; }
.avatar { background:var(--accent-soft); color:var(--accent); font-size:13px; font-weight:600; }
.avatar img { width:100%; height:100%; object-fit:cover; }
.avatar svg { width:18px; height:18px; fill:none; stroke:currentColor; stroke-width:1.6; }
.state { display:grid; place-items:center; min-height:70vh; padding:24px; }
.state-card { width:min(440px,100%); padding:36px; border:1px solid var(--line); border-radius:var(--radius); background:var(--surface); text-align:center; box-shadow:0 30px 60px -40px rgba(17,24,39,.35); }
.state-card h1 { font-size:24px; letter-spacing:-.02em; }
.state-card p { margin:10px 0 22px; color:var(--muted); font-size:14px; line-height:1.7; }
.unlock { display:flex; gap:8px; }
.unlock input { flex:1; }
.doc-bar { position:sticky; top:var(--header-h); z-index:15; box-sizing:border-box; height:56px; display:flex; align-items:center; gap:14px; padding:10px clamp(16px,3vw,32px); border-bottom:1px solid var(--line); background:var(--header-bg); -webkit-backdrop-filter:blur(16px); backdrop-filter:blur(16px); }
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
.actions { display:flex; align-items:center; gap:2px; }
.tool { position:relative; display:grid; place-items:center; width:36px; height:36px; border:0; border-radius:10px; background:none; color:var(--muted); cursor:pointer; transition:background .2s,color .2s; }
.tool:hover, .tool[data-state=open] { background:color-mix(in srgb,var(--text) 6%,transparent); color:var(--text); }
.tool.on { background:var(--accent-soft); color:var(--accent); }
.tool svg, .share-btn svg { width:19px; height:19px; fill:none; stroke:currentColor; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round; }
/* 悬停提示：比原生 title 更快出现，样式与站点一致 */
.tool[data-tip]::after { content:attr(data-tip); position:absolute; top:calc(100% + 8px); left:50%; z-index:30; padding:4px 8px; border-radius:6px; background:var(--btn-bg); color:var(--btn-fg); font:12px/1.4 var(--font); white-space:nowrap; opacity:0; transform:translate(-50%,-2px); pointer-events:none; transition:opacity .15s ease .3s,transform .15s ease .3s; }
.tool[data-tip]:hover::after { opacity:1; transform:translate(-50%,0); }
.tool[data-state=open]::after { display:none; }
.share-btn { display:inline-flex; align-items:center; gap:6px; height:36px; margin-left:8px; padding:0 14px 0 12px; border:0; border-radius:10px; background:var(--btn-bg); color:var(--btn-fg); font:500 14px var(--font); cursor:pointer; transition:filter .2s,transform .2s var(--ease); }
.share-btn:hover { filter:brightness(1.12); }
.share-btn:active { transform:scale(.97); }
:global(.doc-menu) { z-index:60; min-width:190px; padding:5px; border:1px solid var(--line); border-radius:12px; background:var(--surface); color:var(--text); box-shadow:0 16px 40px -12px rgba(17,24,39,.3); transform-origin:var(--reka-dropdown-menu-content-transform-origin); animation:menu-select-in .2s var(--ease); }
:global(.doc-menu-item) { padding:9px 12px; border-radius:8px; color:var(--text-2); font:14px var(--font); cursor:pointer; outline:none; }
:global(.doc-menu-item[data-highlighted]) { background:var(--accent-soft); color:var(--accent); }
:global(.doc-menu-sep) { height:1px; margin:5px 6px; background:var(--line); }
:global(.doc-menu .narrow-only) { display:none; }
@media (max-width:760px) {
  .wide-only { display:none; }
  :global(.doc-menu .narrow-only) { display:block; }
}
.readonly { max-width:860px; margin:16px auto 0; padding:10px 14px; border-radius:10px; background:var(--accent-soft); color:var(--text-2); font-size:13px; }
.readonly a { margin-left:8px; color:var(--accent); }
.doc-body { display:grid; grid-template-columns:0 minmax(0,1fr); }
.doc-body.with-outline { grid-template-columns:268px minmax(0,1fr); }
.outline { position:sticky; top:calc(var(--header-h) + 56px); align-self:start; display:flex; flex-direction:column; width:268px; height:calc(100vh - var(--header-h) - 56px); border-right:1px solid var(--line); background:var(--bg); overflow:hidden; opacity:0; visibility:hidden; transform:translateX(-12px); transition:opacity .25s ease,transform .3s var(--ease),visibility .3s; }
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
.paper :deep(.md-toolbar:not(.docked)) { top:calc(var(--header-h) + 56px); }
.title { width:100%; margin:0 0 18px; padding:0; border:0; background:none; color:var(--text); font:800 clamp(1.9rem,4vw,2.6rem)/1.2 var(--font); letter-spacing:-.03em; outline:none; }
.title::placeholder { color:var(--faint); }
.no-copy :deep(.md-content) { user-select:none; -webkit-user-select:none; }
@media (max-width:760px) {
  .doc-bar { gap:8px; padding-inline:12px; }
  .meta .d-muted, .brand, .icon-btn { display:none; }
  .status { font-size:0; gap:0; }
  .corner { margin-left:0; padding-left:8px; }
  .share-btn { margin-left:4px; padding:0 12px; }
  .paper { padding-top:24px; }
}
</style>

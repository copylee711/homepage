<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { fetchJson } from '../content'
import AdminInbox from './AdminInbox.vue'
import AdminStorage from './AdminStorage.vue'
import type { HostedImage, ImageToken } from '../account'
import type { SiteContent } from '../types'
import { useTheme } from '../composables/useTheme'
import { UNKNOWN_PASSKEY, forgetPasskey, passkeyAvailable, usePasskey } from '../passkeys'
import { noteSlug, postSlug } from '../slug'
import AnimatedSelect from './AnimatedSelect.vue'
import AppIcon from './AppIcon.vue'
import LogoMark from './LogoMark.vue'

type Draft = { title: string; slug: string; summary: string; markdown: string; cover: string }
type Article = { id: string; revision: number; draft: Draft; published: object | null; slug_locked: boolean }
type ArticleItem = { id: string; title: string; slug: string; published: boolean; updated_at: string }
type SyncState = { last_success: string | null; last_error: string; items: unknown[] }
const { theme, toggle } = useTheme()
const csrf = ref(''), loading = ref(true), busy = ref(false), error = ref(''), message = ref('')
// 成功提示 4 秒后自动消失；错误提示保留到手动关闭或下一次操作。
let messageTimer: ReturnType<typeof setTimeout> | undefined
watch(message, value => { clearTimeout(messageTimer); if (value) messageTimer = setTimeout(() => { message.value = '' }, 4000) })
const email = ref(''), password = ref('')
// 两步验证码不常驻：密码通过后服务器提示需要验证码，再弹出第二步。
const OTP_REQUIRED = '请输入两步验证码或恢复码'
const otpFor = ref<null | 'login'>(null), otpCode = ref(''), otpInput = ref<HTMLInputElement>()
function needsOtp(err: unknown) { return err instanceof Error && err.message === OTP_REQUIRED }
function askOtp(target: 'login') {
  otpFor.value = target; otpCode.value = ''; error.value = ''
}
// 请求结束、表单解除禁用后再聚焦验证码输入框。
watch([otpFor, busy], ([target, working]) => { if (target && !working) nextTick(() => otpInput.value?.focus()) }, { flush: 'post' })
function submitOtp() { return login() }
const tab = ref<'profile' | 'portals' | 'repos' | 'posts' | 'notes' | 'storage' | 'accounts' | 'inbox'>('profile')
const unread = ref(0)
// 侧栏导航：图标为 24×24 描边路径
const navItems: { id: typeof tab.value; name: string; icon: string }[] = [
  { id: 'profile', name: '主页设置', icon: 'M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1Z' },
  { id: 'portals', name: '入口卡片', icon: 'M4 5h7v7H4Zm9 0h7v7h-7ZM4 14h7v6H4Zm9 0h7v6h-7Z' },
  { id: 'repos', name: '仓库展示', icon: 'M6 4h10l3 3v13H6Zm4 6h6m-6 4h6m-6 4h3' },
  { id: 'posts', name: '文章管理', icon: 'M5 19h4L19 9l-4-4L5 15Zm8-12 4 4' },
  { id: 'notes', name: '笔记管理', icon: 'M6 4h12v16H6Zm3 4h6m-6 4h6m-6 4h4' },
  { id: 'storage', name: '云盘与图床', icon: 'M4 7h16v11H4Zm0 0 2-3h12l2 3M8 12h8' },
  { id: 'accounts', name: '用户与邮件', icon: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6 9a6 6 0 0 1 12 0m1-9 5-3m-5 6 5 3' },
  { id: 'inbox', name: '收件箱', icon: 'M4 6h16v12H4Zm0 0 8 7 8-7' },
]
const socialOptions = computed(() => socialPlatforms.map(([value, label]) => ({ value, label })))
const canPasskey = computed(() => passkeyAvailable())
async function keyLogin() { await action(async () => {
  const options = await api<{options:Record<string,any>;challenge_id:string}>('/api/auth/passkey/options','POST')
  const credential = await usePasskey(options.options)
  const result = await api<{csrf:string}>('/api/auth/passkey/verify','POST',{challenge_id:options.challenge_id,credential}).catch(async err => {
    if (err instanceof Error && err.message === UNKNOWN_PASSKEY) await forgetPasskey(options.options.rpId, credential.id)
    throw err
  })
  csrf.value=result.csrf; password.value=''
  await loadAll()
}) }
const settings = ref<SiteContent>(), siteRevision = ref(0)
const articles = ref<ArticleItem[]>([]), article = ref<Article>(), draft = ref<Draft>(emptyDraft())
const preview = ref(''), syncState = ref<SyncState>(), lastDraft = ref('')
const lastSite = ref(''), rolesText = ref(''), hiddenText = ref('')
const dirty = computed(() => JSON.stringify(draft.value) !== lastDraft.value)
const siteDirty = computed(() => !!settings.value && JSON.stringify(currentSite()) !== lastSite.value)
const policeCode = computed(() => settings.value?.police.text.replace(/\D/g, '') ?? '')
function currentSite() { return settings.value ? {...settings.value, roles:lines(rolesText.value), hiddenRepos:lines(hiddenText.value)} : undefined }
function lines(value: string) { return value.split('\n').map(v => v.trim()).filter(Boolean) }
type NoteItem = {id:string; slug:string; title:string; summary:string; category:string; updated_at:string; source:'github'|'manual'; path:string|null; visible:boolean; revision:number; markdown?:string}
type NotesConfig = {repo:string; branch:string; autoPublish:boolean; exclude:string[]; last_commit?:string; last_success?:string|null; last_error?:string}
const noteItems = ref<NoteItem[]>([]), notesConfig = ref<NotesConfig>(), excludeText = ref('')
const noteFilter = ref<'all'|'github'|'manual'|'hidden'>('all'), noteQuery = ref('')
const noteEdit = ref<NoteItem & {markdown:string}>(), notePreview = ref('')
const socialPlatforms = [['github','GitHub'],['linkedin','LinkedIn'],['instagram','Instagram'],['x','X'],['bilibili','哔哩哔哩'],['zhihu','知乎'],['xiaohongshu','小红书'],['youtube','YouTube'],['weibo','微博'],['email','Email']]
const shownNotes = computed(() => {
  const words = noteQuery.value.trim().toLowerCase()
  return noteItems.value.filter(n => (noteFilter.value === 'all' || (noteFilter.value === 'hidden' ? !n.visible : n.source === noteFilter.value))
    && `${n.title} ${n.path ?? ''} ${n.category}`.toLowerCase().includes(words))
})
async function loadNotes() {
  const data = await api<{items: NoteItem[]; config: NotesConfig}>('/api/admin/notes')
  noteItems.value = data.items; notesConfig.value = data.config; excludeText.value = data.config.exclude.join('\n')
}
async function saveNotesConfig() { await action(async () => {
  const c = notesConfig.value!
  notesConfig.value = await api<NotesConfig>('/api/admin/notes/config', 'PUT', {repo:c.repo.trim(), branch:c.branch.trim(), autoPublish:c.autoPublish, exclude:lines(excludeText.value)})
  message.value = '笔记来源已保存，下次同步将按新设置读取。'
}) }
async function syncNotes() { await action(async () => {
  const result = await api<{ok: boolean; error: string; changed: number}>('/api/admin/notes/sync', 'POST')
  await loadNotes()
  if (!result.ok) throw new Error(result.error)
  message.value = result.changed ? `同步完成，${result.changed} 篇笔记有变化。` : '同步完成，仓库没有新变化。'
}) }
async function toggleNote(note: NoteItem) { await action(async () => {
  Object.assign(note, await api<NoteItem>(`/api/admin/notes/${note.id}/visibility`, 'POST', {revision:note.revision, visible:!note.visible}))
}) }
function newNote() {
  noteEdit.value = {id:'', slug:'', title:'', summary:'', category:'', updated_at:'', source:'manual', path:null, visible:true, revision:0, markdown:''}
  notePreview.value = ''
}
async function editNote(note: NoteItem) { await action(async () => {
  noteEdit.value = await api<NoteItem & {markdown:string}>(`/api/admin/notes/${note.id}`); notePreview.value = ''
}) }
async function saveNote() { await action(async () => {
  const e = noteEdit.value!
  const body = {revision:e.revision, title:e.title, slug:e.slug, category:e.category, summary:e.summary, markdown:e.markdown, visible:e.visible}
  noteEdit.value = await api<NoteItem & {markdown:string}>(e.id ? `/api/admin/notes/${e.id}` : '/api/admin/notes', e.id ? 'PUT' : 'POST', body)
  await loadNotes(); message.value = '笔记已保存。'
}) }
async function deleteNote() { await action(async () => {
  const e = noteEdit.value!
  if (!confirm('删除后这篇笔记无法恢复，继续吗？')) return
  await api(`/api/admin/notes/${e.id}/remove`, 'POST', {revision:e.revision})
  noteEdit.value = undefined; await loadNotes(); message.value = '笔记已删除。'
}) }
async function previewNote() { await action(async () => {
  notePreview.value = (await api<{html: string}>('/api/admin/preview', 'POST', {markdown: noteEdit.value!.markdown})).html
}) }
type AccountsConfig = {registrationOpen:boolean; allowedDomains:string[]; dailyLimit:number; smtp:{host:string; port:number; security:'ssl'|'starttls'; username:string; fromName:string; fromAddress:string}; hasSmtpPassword:boolean}
type SiteUser = {id:string; email:string; name:string; avatar:string; created_at:string; disabled:boolean; last_login:string|null; admin:boolean; totp:boolean; passkeys:number}
const accountsConfig = ref<AccountsConfig>(), domainsText = ref(''), smtpSecret = ref(''), testTo = ref(''), siteUsers = ref<SiteUser[]>([])
const MiB = 1024 * 1024
const mib = (bytes: number) => bytes >= MiB ? `${(bytes / MiB).toFixed(1)} MiB` : `${Math.max(1, Math.round(bytes / 1024))} KiB`
type ImagesState = {items: HostedImage[]; total: number; page: number; page_size: number; usage: {owner:string; label:string; count:number; size:number}[]; tokens: ImageToken[]; upload_url: string}
const imagesState = ref<ImagesState>(), imageOwner = ref(''), adminTokenName = ref('PicList'), adminFreshToken = ref('')
const imagePages = computed(() => Math.max(1, Math.ceil((imagesState.value?.total ?? 0) / (imagesState.value?.page_size ?? 40))))
async function loadImages(page = imagesState.value?.page ?? 1) {
  imagesState.value = await api<ImagesState>(`/api/admin/images?page=${page}&owner=${encodeURIComponent(imageOwner.value)}`)
}
watch(tab, next => { if (next === 'storage') void loadImages(1).catch(err => { error.value = err instanceof Error ? err.message : '图床加载失败' }) })
watch(imageOwner, () => { void action(() => loadImages(1)) })
async function removeImage(item: HostedImage) { await action(async () => {
  if (!confirm('删除后这张图片的链接将失效，引用它的文章会显示破图。确定删除吗？')) return
  await api(`/api/admin/images/${item.id}/remove`, 'POST'); await loadImages(); message.value = '图片已删除。'
}) }
async function createAdminToken() { await action(async () => {
  adminFreshToken.value = (await api<{token:string}>('/api/admin/images/tokens', 'POST', {name: adminTokenName.value})).token
  await loadImages(); message.value = '令牌已创建，请立即复制，它只会显示这一次。'
}) }
async function revokeAdminToken(token: ImageToken) { await action(async () => {
  if (!confirm(`撤销「${token.name}」后，使用它的客户端将无法继续上传。确定吗？`)) return
  await api(`/api/admin/images/tokens/${token.id}/remove`, 'POST'); await loadImages(); message.value = '令牌已撤销。'
}) }
async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); message.value = '已复制到剪贴板。' } catch { error.value = '复制失败，请手动复制' }
}
async function uploadToHost(event: Event) {
  await upload(event, md => { void copyText(md.trim()) })
  await loadImages(1).catch(() => {})
}
async function loadAccounts() {
  const data = await api<{config: AccountsConfig; users: SiteUser[]}>('/api/admin/accounts')
  accountsConfig.value = data.config; domainsText.value = data.config.allowedDomains.join('\n'); siteUsers.value = data.users
}
async function saveAccounts(clearSecret = false) { await action(async () => {
  const {hasSmtpPassword: _, ...config} = accountsConfig.value!
  const body = {...config, allowedDomains: lines(domainsText.value), ...(clearSecret ? {smtpPassword: ''} : smtpSecret.value ? {smtpPassword: smtpSecret.value} : {})}
  accountsConfig.value = await api<AccountsConfig>('/api/admin/accounts/config', 'PUT', body)
  domainsText.value = accountsConfig.value.allowedDomains.join('\n'); smtpSecret.value = ''
  message.value = clearSecret ? 'SMTP 授权码已清除。' : '注册与邮件设置已保存。'
}) }
async function testMail() { await action(async () => {
  await api('/api/admin/accounts/test-email', 'POST', {to: testTo.value})
  message.value = `测试邮件已发送到 ${testTo.value}，请查收。`
}) }
async function setUserState(user: SiteUser, disabled: boolean) { await action(async () => {
  await api(`/api/admin/accounts/users/${user.id}/state`, 'POST', {disabled}); user.disabled = disabled
  message.value = disabled ? `已停用 ${user.email}，其登录已失效。` : `已恢复 ${user.email}。`
}) }
async function resetUserSecurity(user: SiteUser) { await action(async () => {
  if (!confirm(`清除 ${user.email} 的两步验证与全部 Passkey，并退出其所有登录？仅在确认是本人丢失设备时操作。`)) return
  await api(`/api/admin/accounts/users/${user.id}/reset-security`, 'POST')
  user.totp = false; user.passkeys = 0; message.value = `已重置 ${user.email} 的登录安全设置。`
}) }
async function removeUser(user: SiteUser) { await action(async () => {
  if (!confirm(`永久删除 ${user.email} 及其收藏、浏览记录？`)) return
  await api(`/api/admin/accounts/users/${user.id}/remove`, 'POST')
  siteUsers.value = siteUsers.value.filter(item => item !== user); message.value = '用户已删除。'
}) }
function emptyDraft(): Draft { return { title: '', slug: '', summary: '', markdown: '', cover: '' } }
// 固定链接默认随标题生成；手动修改后不再覆盖，清空后恢复自动生成。
let autoPostSlug = '', autoNoteSlug = '', slugTimer: ReturnType<typeof setTimeout> | undefined
const followsTitle = (slug: string, auto: string) => !slug || slug === auto
watch(() => draft.value.title, title => {
  if (article.value?.slug_locked || !followsTitle(draft.value.slug, autoPostSlug)) return
  clearTimeout(slugTimer)
  slugTimer = setTimeout(async () => {
    const slug = await postSlug(title)
    if (draft.value.title !== title || article.value?.slug_locked || !followsTitle(draft.value.slug, autoPostSlug)) return
    autoPostSlug = slug; draft.value.slug = slug
  }, 250)
})
watch(() => noteEdit.value?.title, title => {
  const note = noteEdit.value
  if (!note || note.source !== 'manual' || title === undefined || !followsTitle(note.slug, autoNoteSlug)) return
  autoNoteSlug = noteSlug(title); note.slug = autoNoteSlug
})

async function api<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  try {
    return await fetchJson<T>(path, { method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.value },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    })
  } catch (err) {
    if ((err as {status?: number}).status === 401) csrf.value = ''
    throw err
  }
}
async function action(work: () => Promise<void>) {
  if (busy.value) return
  busy.value = true; error.value = ''; message.value = ''
  try { await work() } catch(err) {
    if((err as {status?: number}).status===401) csrf.value=''
    error.value = err instanceof Error ? err.message : '操作失败'
  }
  finally { busy.value = false }
}
async function loadSettings() {
  const data = await api<{site: SiteContent; revision: number}>('/api/admin/site')
  settings.value = data.site; siteRevision.value = data.revision
  rolesText.value = data.site.roles.join('\n'); hiddenText.value = data.site.hiddenRepos.join('\n')
  lastSite.value = JSON.stringify(currentSite())
  syncState.value = await api<SyncState>('/api/admin/repos')
}
async function listArticles() { articles.value = await api<ArticleItem[]>('/api/admin/posts') }
async function login() { await action(async () => {
  let data: {csrf: string}
  try { data = await api<{csrf: string}>('/api/auth/login', 'POST', {email: email.value, password: password.value, otp: otpFor.value ? otpCode.value : ''}) }
  catch (err) { if (needsOtp(err)) { askOtp('login'); return } throw err }
  csrf.value = data.csrf; password.value = ''; otpFor.value = null; otpCode.value = ''
  await loadAll()
}) }
async function loadAll() {
  await loadSettings(); await listArticles(); await loadNotes(); await loadAccounts()
  unread.value = (await api<{unread: number}>('/api/admin/inbox?page=1')).unread
}
async function logout() { await action(async () => {
  if(((dirty.value && draft.value.title) || siteDirty.value) && !confirm('有未保存修改，仍要退出吗？')) return
  await api('/api/auth/logout', 'POST'); csrf.value = ''; settings.value = undefined
  article.value = undefined; draft.value = emptyDraft(); lastDraft.value = JSON.stringify(draft.value)
  preview.value = ''; articles.value = []; syncState.value = undefined
  noteItems.value = []; notesConfig.value = undefined; noteEdit.value = undefined
}) }
async function saveSettings() { await action(async () => {
  const result = await api<{revision: number}>('/api/admin/site', 'PUT', {revision: siteRevision.value, site: currentSite()})
  lastSite.value = JSON.stringify(currentSite())
  siteRevision.value = result.revision; message.value = '设置已保存，主页将在下次刷新或自动检查时更新。'
}) }
async function reloadSettings() { await action(async () => {
  if(!confirm('重新加载会丢弃尚未保存的设置，继续吗？')) return
  await loadSettings(); message.value = '已读取最新设置。'
}) }
async function syncRepos() { await action(async () => {
  const data = await api<{ok: boolean; error: string}>('/api/admin/repos/sync', 'POST')
  syncState.value = await api<SyncState>('/api/admin/repos')
  if(!data.ok) throw new Error(data.error)
  message.value = '仓库同步完成。'
}) }
function move<T>(items: T[], index: number, direction: number) {
  const target = index + direction
  if(target < 0 || target >= items.length) return
  const item = items.splice(index, 1)[0]!
  items.splice(target, 0, item)
}
async function selectArticle(id?: string) {
  if (dirty.value && draft.value.title && !confirm('文章有未保存修改，仍要切换吗？')) return
  await action(async () => {
    article.value = id ? await api<Article>(`/api/admin/posts/${id}`) : undefined
    draft.value = article.value ? {...article.value.draft} : emptyDraft()
    lastDraft.value = JSON.stringify(draft.value); preview.value = ''
  })
}
async function persistDraft() {
  if (!article.value) article.value = await api<Article>('/api/admin/posts', 'POST', draft.value)
  else {
    const result = await api<{revision: number}>(`/api/admin/posts/${article.value.id}`, 'PUT', {revision: article.value.revision, draft: draft.value})
    article.value.revision = result.revision; article.value.draft = {...draft.value}
  }
  lastDraft.value = JSON.stringify(draft.value)
}
async function saveDraft() { await action(async () => {
  await persistDraft(); await listArticles(); message.value = '草稿已保存，公开版本未改变。'
}) }
async function publish() { await action(async () => {
  await persistDraft()
  const current = article.value!
  await api(`/api/admin/posts/${current.id}/publish`, 'POST', {revision: current.revision})
  article.value = await api<Article>(`/api/admin/posts/${current.id}`)
  await listArticles(); message.value = '文章已发布。'
}) }
async function unpublish() { await action(async () => {
  const current = article.value!
  if(!confirm('撤下后访客将无法读取这篇文章，继续吗？')) return
  const result = await api<{revision: number}>(`/api/admin/posts/${current.id}/unpublish`, 'POST', {revision: current.revision})
  current.revision = result.revision; current.published = null
  await listArticles(); message.value = '文章已撤下，编辑内容仍保留。'
}) }
async function deleteArticle() { await action(async () => {
  const current = article.value!
  if(!confirm(`删除「${current.draft.title}」？草稿与固定链接将一并释放，无法恢复。`)) return
  await api(`/api/admin/posts/${current.id}/delete`, 'POST', {revision: current.revision})
  article.value = undefined; draft.value = emptyDraft(); lastDraft.value = JSON.stringify(draft.value); preview.value = ''
  await listArticles(); message.value = '文章已删除。'
}) }
async function renderPreview() { await action(async () => {
  preview.value = (await api<{html: string}>('/api/admin/preview', 'POST', {markdown: draft.value.markdown})).html
}) }
async function upload(event: Event, insert = (markdown: string) => { draft.value.markdown += markdown }) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]
  if(!file) return
  await action(async () => {
    if(file.size > 20 * 1024 * 1024) throw new Error('图片不能超过 20 MiB')
    const result = await fetchJson<{url: string}>('/api/admin/media', {method:'POST', body:file,
      headers:{'Content-Type':file.type || 'application/octet-stream','X-CSRF-Token':csrf.value},
      credentials:'same-origin', signal:AbortSignal.timeout(60000)})
    insert(`\n\n![图片说明](${result.url})\n`)
    message.value = `图片已上传到图床：${result.url}`
  })
  input.value = ''
}
// 从本地 Markdown 文件导入：首个一级标题作为标题，文件名作为地址，其余为正文。
async function importMarkdown(event: Event, target: 'post' | 'note') {
  const input = event.target as HTMLInputElement, file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (file.size > 500_000) { error.value = 'Markdown 文件不能超过 500 KB'; return }
  let text = (await file.text()).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(text)
  const title = (heading?.[1] ?? file.name.replace(/\.(md|markdown|txt)$/i, '')).trim().slice(0, 200)
  if (heading && text.trimStart().startsWith(heading[0])) text = text.trimStart().slice(heading[0].length).trimStart()
  const base = file.name.replace(/\.(md|markdown|txt)$/i, '').toLowerCase()
  const slug = noteSlug(base)
  if (target === 'post') {
    if (dirty.value && draft.value.title && !confirm('当前文章有未保存修改，导入会替换编辑区，继续吗？')) return
    article.value = undefined
    // 文章地址由标题自动生成（中文转拼音）
    draft.value = { ...emptyDraft(), title, markdown: text }
    lastDraft.value = ''; preview.value = ''
  } else {
    newNote()
    Object.assign(noteEdit.value!, { title, slug, markdown: text })
  }
  const relative = [...text.matchAll(/!\[[^\]]*\]\((?!https?:|\/)[^)]+\)|<img[^>]+src=["'](?!https?:|\/)/g)].length
  message.value = `已导入「${file.name}」，检查后保存即可。` + (relative ? `文件中有 ${relative} 处本地相对路径图片，请上传图片后替换链接。` : '')
}
function preventLeave(event: BeforeUnloadEvent) {
  if ((dirty.value && draft.value.title) || siteDirty.value) { event.preventDefault(); event.returnValue = '' }
}
onMounted(async () => {
  lastDraft.value = JSON.stringify(draft.value)
  window.addEventListener('beforeunload', preventLeave)
  try {
    // 已在前台登录时预填邮箱；进入后台仍需再次验证。
    email.value = await fetchJson<{user: {email: string}}>('/api/account/me', {credentials: 'same-origin'}).then(data => data.user.email, () => '')
    csrf.value = (await api<{csrf: string}>('/api/auth/me')).csrf
    await loadAll()
  } catch(err) { if((err as {status?: number}).status !== 401) error.value = err instanceof Error ? err.message : '后台加载失败' }
  finally { loading.value = false }
})
onBeforeUnmount(() => { window.removeEventListener('beforeunload', preventLeave) })
</script>

<template>
  <div class="admin-shell">
    <header class="admin-top"><a href="/" class="admin-brand"><LogoMark class="admin-logo" />Copy Lee<span>内容管理</span></a>
      <div class="top-actions"><a href="/" target="_blank">查看网站 ↗</a><button class="icon-button" @click="toggle" :aria-label="theme === 'dark' ? '切换浅色主题' : '切换深色主题'"><AppIcon :name="theme === 'dark' ? 'sun' : 'moon'" /></button><button v-if="csrf" @click="logout" :disabled="busy">退出</button></div>
    </header>
    <Transition name="toast"><p v-if="error" class="feedback error" role="alert">{{ error }}<button class="toast-close" aria-label="关闭提示" @click="error = ''">×</button></p></Transition>
    <Transition name="toast"><p v-if="message && !error" class="feedback success" role="status">{{ message }}<button class="toast-close" aria-label="关闭提示" @click="message = ''">×</button></p></Transition>
    <main v-if="loading" class="login-panel"><p>正在加载后台…</p></main>
    <main v-else-if="!csrf" class="login-panel">
      <p class="eyebrow">Your personal space</p><h1>欢迎回来。</h1><p class="subtle">使用你的站点账户登录后台；即使已在前台登录，这里也需要再次验证。</p>
      <form @submit.prevent="login"><fieldset :disabled="busy"><label>邮箱<input v-model="email" type="email" autocomplete="username" required maxlength="254"></label>
        <label>密码<input v-model="password" type="password" autocomplete="current-password" required maxlength="200"></label>
        <button class="primary" type="submit">{{ busy ? '正在登录…' : '登录后台' }}</button></fieldset></form>
      <button @click="keyLogin" :disabled="busy || !canPasskey" class="passkey-login">使用 Passkey 登录</button>
      <p class="field-hint">可使用在账户页绑定的 Passkey；密码、两步验证与 Passkey 都在<a href="/account?tab=settings">账户设置</a>中管理。</p>
      <details class="login-hint"><summary>忘记密码或无法登录？</summary><p>忘记密码可在<a href="/account">账户页</a>用邮箱验证码找回。把站点账户设为管理员，或设备丢失需要清除两步验证时，SSH 登录服务器后执行：</p><pre>cd /opt/copylee-backend/current
set -a; . /etc/copylee/backend.env; set +a
runuser -u copylee -- .venv/bin/python -m app.cli set-admin --email you@example.com
runuser -u copylee -- .venv/bin/python -m app.cli reset-security --email you@example.com</pre></details>
    </main>
    <div v-else class="admin-layout">
      <aside class="admin-nav"><p class="eyebrow">Workspace</p><button v-for="item in navItems" :key="item.id" :class="{selected:tab===item.id}" :aria-current="tab===item.id ? 'page' : undefined" @click="tab=item.id"><svg viewBox="0 0 24 24" aria-hidden="true"><path :d="item.icon" /></svg>{{ item.name }}<span v-if="item.id==='inbox' && unread" class="nav-badge">{{ unread > 99 ? '99+' : unread }}</span></button><p class="nav-note">内容保存后即可更新。<br>页面样式仍由代码管理。</p></aside>
      <main class="admin-main"><fieldset :disabled="busy">
        <AdminInbox v-if="tab==='inbox'" :api="api" @unread="value => unread = value" @notify="text => message = text" @fail="text => error = text" />
        <template v-if="['profile', 'portals', 'repos'].includes(tab) && settings">
          <div class="section-head"><div><p class="eyebrow">Site content</p><h1>{{ tab==='profile' ? '主页设置' : tab==='portals' ? '入口卡片' : '仓库展示' }}</h1></div>
            <div class="buttons"><button @click="reloadSettings">重新加载</button><button class="primary" @click="saveSettings">{{busy ? '处理中…' : '保存设置'}}</button></div></div>
          <template v-if="tab==='profile'">
            <section class="edit-card"><h2>基本信息</h2><p class="subtle">显示在主页首屏。</p>
            <div class="form-grid">
              <label>显示名称<input v-model="settings.name" maxlength="80"></label><label>问候语<input v-model="settings.greeting" maxlength="100"></label>
              <label class="wide">个人简介<textarea v-model="settings.intro" rows="3" maxlength="2000"></textarea></label>
              <label class="wide"><span class="label-line">身份标签<span class="field-hint">每行一个</span></span><textarea v-model="rolesText" rows="3"></textarea></label>
            </div></section>
            <section class="edit-card"><h2>链接</h2><p class="subtle">导航栏与页脚中的 GitHub、Cloud 入口。</p>
            <div class="form-grid">
              <label>GitHub 用户名<input v-model="settings.github" maxlength="39"></label>
              <label>Cloud 地址<input v-model="settings.cloud" type="url" placeholder="https://…"></label>
            </div></section>
            <section class="edit-card"><h2>备案信息</h2><p class="subtle">显示在全站页脚右下角，留空则不显示。</p>
            <div class="form-grid">
              <label>ICP 备案号<input v-model="settings.icp" maxlength="100" placeholder="粤ICP备XXXXXXXXXX号-1"><span class="field-hint">链接到工信部备案查询 beian.miit.gov.cn</span></label>
              <label>公安备案号<input v-model="settings.police.text" maxlength="100" placeholder="粤公网安备XXXXXXXXXXXXXX号"><span class="field-hint">填写完整备案号，查询链接编号自动识别：{{ policeCode || '—' }}</span></label>
              <div v-if="settings.icp || settings.police.text" class="wide beian-preview">
                <span class="field-hint">页脚预览</span>
                <p><span v-if="settings.icp">{{ settings.icp }}</span><span v-if="settings.police.text"><img src="/beian-police.png" alt="" width="14" height="16">{{ settings.police.text }}</span></p>
              </div>
            </div></section>
            <section class="edit-card"><h2>社交主页</h2><p class="subtle">图标显示在页脚。关闭“公开显示”或留空地址的条目不会出现在网站上。</p>
            <div v-for="(social,index) in settings.socials" :key="index" class="social-row">
              <AnimatedSelect v-model="social.platform" label="平台" :options="socialOptions" />
              <label class="social-url">{{ social.platform==='email' ? '邮箱地址' : '主页地址' }}<input v-model="social.url" :type="social.platform==='email' ? 'email' : 'url'" :placeholder="social.platform==='email' ? 'me@example.com' : 'https://…'"></label>
              <label class="checkbox"><input type="checkbox" v-model="social.visible">公开显示</label>
              <div class="buttons"><button @click="move(settings.socials,index,-1)" :disabled="index===0">上移</button><button class="danger" @click="settings.socials.splice(index,1)">移除</button></div>
            </div>
            <button @click="settings.socials.push({platform:'instagram',url:'',visible:true})">＋ 添加社交主页</button></section>
          </template>
          <template v-if="tab==='portals'">
            <p class="subtle">卡片按列表顺序展示。隐藏卡片仍可在这里继续编辑。</p>
            <section v-for="(portal,index) in settings.portals" :key="index" class="edit-card">
              <div class="card-head"><span class="eyebrow">入口 {{ String(index+1).padStart(2,'0') }}</span><div class="buttons"><button @click="move(settings.portals,index,-1)" :disabled="index===0">上移</button><button @click="move(settings.portals,index,1)" :disabled="index===settings.portals.length-1">下移</button><button class="danger" @click="settings.portals.splice(index,1)">移除</button></div></div>
              <div class="form-grid"><label>名称<input v-model="portal.title" maxlength="80"></label><AnimatedSelect v-model="portal.icon" label="图标" :options="[{value:'cloud',label:'Cloud'},{value:'note',label:'Notes'},{value:'github',label:'GitHub'}]" />
                <label class="wide">描述<input v-model="portal.description" maxlength="500"></label><label>链接<input v-model="portal.href" placeholder="https://… 或 /notes"></label><label>地址提示<input v-model="portal.hint" maxlength="100"></label></div>
              <label class="checkbox"><input type="checkbox" v-model="portal.visible">公开显示</label>
            </section>
            <button @click="settings.portals.push({title:'新入口',description:'',href:'https://',icon:'note',hint:'',visible:true})">＋ 添加入口</button>
          </template>
          <template v-if="tab==='repos'">
            <div class="sync-panel"><div><h2>GitHub 数据同步</h2><p class="subtle">每 15 分钟自动同步；展示规则与仓库数据分别保存。</p><p class="field-hint">最近成功：{{ syncState?.last_success ?? '尚未同步' }}</p><p v-if="syncState?.last_error" class="sync-error">{{ syncState.last_error }}</p></div><button @click="syncRepos">立即同步</button></div>
            <label class="hidden-repos">隐藏仓库<span class="field-hint">每行一个仓库名</span><textarea v-model="hiddenText" rows="4"></textarea></label>
            <h2 class="group-title">分组规则</h2><p class="subtle">按顺序展示，未匹配的仓库显示在 Others 中。</p>
            <section v-for="(group,index) in settings.repoGroups" :key="index" class="edit-card">
              <div class="card-head"><span class="eyebrow">分组 {{ index+1 }}</span><div class="buttons"><button @click="move(settings.repoGroups,index,-1)" :disabled="index===0">上移</button><button @click="move(settings.repoGroups,index,1)" :disabled="index===settings.repoGroups.length-1">下移</button><button class="danger" @click="settings.repoGroups.splice(index,1)">移除</button></div></div>
              <div class="form-grid"><label>分组名称<input v-model="group.title"></label><label>仓库名前缀<input v-model="group.prefix" placeholder="dsh-"></label><label class="wide">描述<input v-model="group.description"></label></div>
            </section><button @click="settings.repoGroups.push({title:'新分组',description:'',prefix:''})">＋ 添加分组</button>
          </template>
        </template>
        <template v-if="tab==='accounts' && accountsConfig">
          <div class="section-head"><div><p class="eyebrow">Members</p><h1>用户与邮件</h1></div><button class="primary" @click="saveAccounts()">保存设置</button></div>
          <section class="edit-card"><h2>注册</h2><p class="subtle">访客用邮箱注册后可以收藏笔记与文章、查看浏览记录。邮箱需通过验证码验证。</p>
            <div class="form-grid">
              <label class="checkbox"><input type="checkbox" v-model="accountsConfig.registrationOpen">开放注册<span class="field-hint">关闭后已注册用户仍可登录</span></label>
              <label>每日验证码上限<span class="field-hint">全站合计，保护你的个人邮箱</span><input v-model.number="accountsConfig.dailyLimit" type="number" min="1" max="2000"></label>
              <label class="wide">允许注册的邮箱域名<span class="field-hint">每行一个；找回密码不受此限制</span><textarea v-model="domainsText" rows="5"></textarea></label>
            </div>
          </section>
          <section class="edit-card"><h2>验证码邮件（SMTP）</h2><p class="subtle">使用你的个人邮箱发送验证码。QQ 邮箱：设置 → 账号与安全 → 开启 SMTP 服务，获取“授权码”填入下方（不是 QQ 密码）。</p>
            <div class="form-grid">
              <label>SMTP 服务器<input v-model="accountsConfig.smtp.host" placeholder="smtp.qq.com"></label>
              <div class="form-grid tight"><label>端口<input v-model.number="accountsConfig.smtp.port" type="number" min="1" max="65535"></label><AnimatedSelect v-model="accountsConfig.smtp.security" label="加密" :options="[{value:'ssl',label:'SSL（465）'},{value:'starttls',label:'STARTTLS（587）'}]" /></div>
              <label>邮箱账号<input v-model="accountsConfig.smtp.username" type="email" placeholder="you@qq.com" autocomplete="off"></label>
              <label>授权码<span class="field-hint">{{ accountsConfig.hasSmtpPassword ? '已保存，加密存储；留空表示不修改' : '尚未设置' }}</span><input v-model="smtpSecret" type="password" autocomplete="new-password" :placeholder="accountsConfig.hasSmtpPassword ? '••••••••' : 'SMTP 授权码'"></label>
              <label>发件人名称<input v-model="accountsConfig.smtp.fromName" placeholder="Copy Lee"></label>
              <label>发件地址<span class="field-hint">留空则使用邮箱账号</span><input v-model="accountsConfig.smtp.fromAddress" type="email"></label>
            </div>
            <div class="test-mail"><input v-model="testTo" type="email" placeholder="接收测试邮件的地址" aria-label="测试收件地址"><button :disabled="!testTo" @click="testMail">发送测试邮件</button><button v-if="accountsConfig.hasSmtpPassword" class="danger" @click="saveAccounts(true)">清除授权码</button></div>
            <p class="field-hint">先保存设置，再发送测试邮件。阿里云服务器限制 25 端口，请使用 465 或 587。</p>
          </section>
          <section class="edit-card"><h2>注册用户<span class="security-status">{{ siteUsers.length }} 人</span></h2>
            <p v-if="!siteUsers.length" class="subtle">还没有注册用户。</p>
            <ul class="note-list user-list">
              <li v-for="user in siteUsers" :key="user.id" :class="{ muted: user.disabled }">
                <div class="user-info"><span class="user-face"><img v-if="user.avatar" :src="user.avatar" alt=""><template v-else>{{ user.name.slice(0,1).toUpperCase() }}</template></span>
                  <div class="note-info"><strong>{{ user.name }}<span v-if="user.admin" class="security-status">管理员</span><span v-if="user.totp" class="security-status">2FA</span><span v-if="user.passkeys" class="security-status">Passkey × {{ user.passkeys }}</span></strong><span>{{ user.email }} · 注册于 {{ user.created_at.slice(0,10) }}{{ user.last_login ? ` · 最近登录 ${user.last_login.slice(0,10)}` : '' }}</span></div></div>
                <div class="buttons"><label v-if="!user.admin" class="switch"><input type="checkbox" :checked="!user.disabled" @change="setUserState(user, !user.disabled)"><span>{{ user.disabled ? '已停用' : '正常' }}</span></label><button v-if="user.totp || user.passkeys" @click="resetUserSecurity(user)">重置安全</button><button v-if="!user.admin" class="danger" @click="removeUser(user)">删除</button></div>
              </li>
            </ul>
          </section>
        </template>
        <template v-if="tab==='storage'">
          <AdminStorage :api="api" @notify="text => message = text" @fail="text => error = text" />
          <div class="section-head images-head"><div><p class="eyebrow">Image hosting</p><h2 class="images-title">图床图片</h2></div><div class="buttons"><button @click="action(() => loadImages())">刷新</button><label class="upload-button primary">上传图片<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" @change="uploadToHost"></label></div></div>
          <p class="subtle">文章与笔记编辑器上传的图片存入系统图床：不计配额、不能单独删除，内容不再引用 24 小时后自动清理。管理员用 PicList 等上传的图片计入自己的存储方案。用户的图床与云盘在上方的存储方案中开通。</p>
          <section v-if="imagesState" class="edit-card"><h2>用量</h2>
            <ul class="note-list"><li v-for="row in imagesState.usage" :key="row.owner"><div class="note-info"><strong>{{ row.label }}</strong><span>{{ row.count }} 张 · {{ mib(row.size) }}</span></div><button @click="imageOwner = row.owner">只看此用户</button></li></ul>
            <p v-if="!imagesState.usage.length" class="subtle">还没有图片。</p>
          </section>
          <section v-if="imagesState" class="edit-card"><h2>管理员上传令牌</h2><p class="subtle">用于 PicList / Typora。上传地址 <code>{{ imagesState.upload_url }}</code>，文件字段 <code>file</code>，请求头 <code>Authorization: Bearer 令牌</code>，返回 URL 路径 <code>url</code>。</p>
            <div class="test-mail"><input v-model="adminTokenName" maxlength="40" aria-label="令牌名称" placeholder="令牌名称"><button @click="createAdminToken">创建令牌</button></div>
            <div v-if="adminFreshToken" class="key-row"><code class="fresh-token">{{ adminFreshToken }}</code><div class="buttons"><button @click="copyText(adminFreshToken)">复制</button><button @click="adminFreshToken=''">我已保存</button></div></div>
            <div v-for="token in imagesState.tokens" :key="token.id" class="key-row"><div><strong>{{ token.name }}</strong><p class="field-hint">创建于 {{ token.created_at.slice(0,10) }} · {{ token.last_used ? `最近使用 ${token.last_used.slice(0,10)}` : '尚未使用' }}</p></div><button class="danger" @click="revokeAdminToken(token)">撤销</button></div>
          </section>
          <section v-if="imagesState" class="edit-card"><h2>全部图片<span class="security-status">{{ imagesState.total }} 张</span></h2>
            <div class="buttons"><AnimatedSelect v-model="imageOwner" label="上传者" :options="[{value:'',label:'全部'}, ...imagesState.usage.map(row => ({value:row.owner,label:row.label}))]" /></div>
            <ul class="image-grid"><li v-for="item in imagesState.items" :key="item.id"><a :href="item.url" target="_blank" rel="noopener"><img :src="item.url" :alt="`图片 ${item.id}`" loading="lazy"></a>
              <p class="field-hint">{{ item.width }}×{{ item.height }} · {{ mib(item.size) }} · {{ item.owner === 'system' ? '系统（文章与笔记）' : item.owner === 'admin' ? '旧管理员' : siteUsers.find(u => u.id === item.owner)?.email ?? item.owner }}</p>
              <div class="buttons"><button @click="copyText(`![](${item.url})`)">Markdown</button><button @click="copyText(item.url)">URL</button><button v-if="item.owner !== 'system'" class="danger" @click="removeImage(item)">删除</button><span v-else class="field-hint" title="不再被文章或笔记引用 24 小时后自动删除">随内容自动清理</span></div></li></ul>
            <div v-if="imagePages > 1" class="buttons pager"><button :disabled="imagesState.page <= 1" @click="action(() => loadImages(imagesState!.page - 1))">上一页</button><span class="field-hint">{{ imagesState.page }} / {{ imagePages }}</span><button :disabled="imagesState.page >= imagePages" @click="action(() => loadImages(imagesState!.page + 1))">下一页</button></div>
          </section>
        </template>
        <template v-if="tab==='notes'">
          <div class="section-head"><div><p class="eyebrow">Knowledge base</p><h1>笔记管理</h1></div><div class="buttons"><button @click="syncNotes">立即同步</button><label class="upload-button">导入 .md<input type="file" accept=".md,.markdown,.txt,text/markdown" @change="importMarkdown($event, 'note')"></label><button class="primary" @click="newNote">＋ 新建笔记</button></div></div>
          <div v-if="notesConfig" class="sync-panel notes-source">
            <div class="form-grid">
              <label>GitHub 仓库<span class="field-hint">owner/name，公开仓库无需令牌</span><input v-model="notesConfig.repo" placeholder="copylee711/notes"></label>
              <label>分支<input v-model="notesConfig.branch" placeholder="main"></label>
              <label>排除规则<span class="field-hint">每行一个，匹配路径中的任一层，如 .* / docs / README.md</span><textarea v-model="excludeText" rows="3"></textarea></label>
              <div class="source-status"><label class="checkbox"><input type="checkbox" v-model="notesConfig.autoPublish">新笔记自动公开<span class="field-hint">文件名以 draft 开头的笔记始终默认隐藏</span></label>
                <p class="field-hint">每 30 分钟检查一次仓库。最近成功：{{ notesConfig.last_success ? new Date(notesConfig.last_success).toLocaleString() : '尚未同步' }}<template v-if="notesConfig.last_commit"> · 提交 {{ notesConfig.last_commit.slice(0,7) }}</template></p>
                <p v-if="notesConfig.last_error" class="sync-error">{{ notesConfig.last_error }}</p>
                <button @click="saveNotesConfig">保存来源设置</button></div>
            </div>
          </div>
          <section v-if="noteEdit" class="note-editor">
            <div class="card-head"><h2>{{ noteEdit.id ? '编辑笔记' : '新建笔记' }}</h2><button @click="noteEdit=undefined">关闭</button></div>
            <template v-if="noteEdit.source==='manual'">
              <div class="form-grid"><label>标题<input v-model="noteEdit.title" maxlength="200"></label><label>地址<input v-model="noteEdit.slug" maxlength="120" placeholder="my-note"><span class="field-hint">小写字母、数字、中文与连字符</span></label>
                <label>分类<input v-model="noteEdit.category" maxlength="80" placeholder="例如：Python"></label><label>摘要<input v-model="noteEdit.summary" maxlength="1000" placeholder="留空则取正文第一段"></label></div>
              <div class="markdown-tools"><span class="eyebrow">Markdown · 支持 $公式$</span><div class="buttons"><label class="upload-button">上传图片<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" @change="upload($event, md => { noteEdit!.markdown += md })"></label><button @click="previewNote">预览</button></div></div>
              <textarea v-model="noteEdit.markdown" class="markdown-input" rows="16" aria-label="笔记正文"></textarea>
              <label class="checkbox"><input type="checkbox" v-model="noteEdit.visible">公开显示</label>
              <section v-if="notePreview" class="preview-panel"><h2>预览</h2><div class="prose" v-html="notePreview"></div></section>
              <div class="editor-actions"><button class="primary" @click="saveNote">保存笔记</button><button v-if="noteEdit.id" class="danger" @click="deleteNote">删除</button><a v-if="noteEdit.id && noteEdit.visible" :href="`/notes/${noteEdit.slug}`" target="_blank">查看公开页面 ↗</a></div>
            </template>
            <p v-else class="subtle">这篇笔记来自 GitHub（{{ noteEdit.path }}），内容以仓库为准，请在仓库修改后同步。这里可以切换是否公开。</p>
          </section>
          <div class="note-toolbar"><div class="buttons"><button v-for="[value,name] in [['all','全部'],['github','GitHub'],['manual','手写'],['hidden','已隐藏']]" :key="value" :class="{selected:noteFilter===value}" @click="noteFilter=value as typeof noteFilter">{{ name }}</button></div><input v-model="noteQuery" type="search" placeholder="搜索标题或路径…" aria-label="搜索笔记"></div>
          <p v-if="!shownNotes.length" class="subtle">{{ noteItems.length ? '没有符合条件的笔记。' : '还没有笔记：点击“立即同步”读取仓库，或新建一篇。' }}</p>
          <ul class="note-list">
            <li v-for="note in shownNotes" :key="note.id" :class="{ muted: !note.visible }">
              <div class="note-info"><strong>{{ note.title }}</strong><span>{{ note.source==='github' ? note.path : '手写' }}{{ note.category ? ` · ${note.category}` : '' }} · {{ note.updated_at.slice(0,10) }}</span></div>
              <div class="buttons"><label class="switch"><input type="checkbox" :checked="note.visible" @change="toggleNote(note)"><span>{{ note.visible ? '公开' : '隐藏' }}</span></label>
                <button @click="editNote(note)">{{ note.source==='manual' ? '编辑' : '详情' }}</button><a v-if="note.visible" :href="`/notes/${note.slug}`" target="_blank">查看 ↗</a></div>
            </li>
          </ul>
        </template>
        <template v-if="tab==='posts'">
          <div class="section-head"><div><p class="eyebrow">Writing desk</p><h1>文章管理</h1></div><div class="buttons"><label class="upload-button">导入 .md<input type="file" accept=".md,.markdown,.txt,text/markdown" @change="importMarkdown($event, 'post')"></label><button @click="selectArticle()">＋ 新建文章</button></div></div>
          <div class="writing-layout"><aside class="article-sidebar"><p v-if="!articles.length" class="subtle">还没有文章，从右侧开始写作。</p><button v-for="item in articles" :key="item.id" :class="{selected:article?.id===item.id}" @click="selectArticle(item.id)"><strong>{{ item.title }}</strong><span>{{ item.published ? '已发布' : '草稿' }} · {{ item.updated_at.slice(0,10) }}</span></button></aside>
            <div class="editor"><div class="editor-status"><span>{{ article?.published ? '已有公开版本' : '尚未发布' }}</span><span v-if="dirty">有未保存修改</span></div>
              <label>标题<input v-model="draft.title" maxlength="200" placeholder="写下标题"></label>
              <label>固定链接<span class="slug-field"><span class="slug-prefix">/posts/</span><input v-model="draft.slug" :readonly="article?.slug_locked" placeholder="根据标题自动生成" maxlength="120"></span><span class="field-hint">{{ article?.slug_locked ? (article.published ? '已发布，固定链接已锁定。' : '曾经发布过，固定链接已锁定；删除文章可释放该链接。') : '根据标题自动生成，中文转为拼音；可手动修改，清空后恢复自动生成。首次发布后锁定。' }}</span></label>
              <label>摘要<textarea v-model="draft.summary" rows="2" maxlength="1000"></textarea></label>
              <label>封面地址<input v-model="draft.cover" placeholder="https://… 或 /media/…"></label>
              <div class="markdown-tools"><span class="eyebrow">Markdown</span><div class="buttons"><label class="upload-button">上传图片<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" @change="upload"></label><button @click="renderPreview">预览</button></div></div>
              <textarea v-model="draft.markdown" class="markdown-input" rows="18" aria-label="Markdown 正文" placeholder="从这里开始…"></textarea>
              <p class="field-hint">图片上传后可公开访问，单张上限 10 MiB；上传会将图片链接插入正文。</p>
              <section v-if="preview" class="preview-panel"><h2>预览</h2><div class="prose" v-html="preview"></div></section>
              <div class="editor-actions"><button @click="saveDraft">保存草稿</button><button class="primary" @click="publish">{{article?.published ? '发布更新' : '发布文章'}}</button><button v-if="article?.published" class="danger" @click="unpublish">撤下</button><button v-else-if="article" class="danger" @click="deleteArticle">删除</button><a v-if="article?.published" :href="`/posts/${article.draft.slug}`" target="_blank">查看公开版本 ↗</a></div>
              <p class="field-hint">保存草稿不会修改公开内容。发布会先保存当前编辑内容，再更新公开版本。撤下后可删除文章并释放固定链接。</p>
            </div></div>
        </template>
      </fieldset></main>
    </div>
    <Transition name="step">
      <div v-if="otpFor" class="step-backdrop otp-backdrop" @click.self="otpFor = null">
        <form class="step-dialog" role="dialog" aria-modal="true" aria-labelledby="otp-title" @submit.prevent="submitOtp">
          <p class="eyebrow">Two-step verification</p><h2 id="otp-title">输入验证码</h2>
          <p class="subtle">打开验证器 App，输入当前的 6 位验证码；也可以使用一次性恢复码。</p>
          <p v-if="error" class="dialog-error" role="alert">{{ error }}</p>
          <fieldset :disabled="busy">
            <label>验证码 / 恢复码<input ref="otpInput" v-model="otpCode" class="otp-input" autocomplete="one-time-code" inputmode="text" maxlength="80" required></label>
            <button class="primary" type="submit">{{ busy ? '正在验证…' : '验证' }}</button>
            <button type="button" class="link-button" @click="otpFor = null">返回</button>
          </fieldset>
        </form>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.admin-shell { --field-line:color-mix(in srgb,var(--line-strong) 55%,transparent); min-height:100vh; background:radial-gradient(1200px 500px at 85% -10%,var(--bg-tint),transparent 70%),var(--bg); }
.passkey-login { margin-top:16px; width:100%; }
.nav-badge { margin-left:auto; min-width:20px; padding:1px 6px; border-radius:999px; background:var(--accent); color:#fff; font:600 11px/18px var(--font-mono); text-align:center; }
.images-head { margin-top:40px; }
.images-title { font-size:24px; margin-top:8px; }
.login-panel .field-hint a,.login-hint a { color:var(--accent); }
.step-backdrop { position:fixed; inset:0; z-index:50; display:grid; place-items:center; padding:20px; background:rgba(12,13,16,.45); backdrop-filter:blur(6px); }
.step-dialog { width:min(420px,100%); padding:32px; border:1px solid var(--line); border-radius:16px; background:var(--bg); box-shadow:0 30px 60px -20px rgba(0,0,0,.35); }
.step-dialog h2 { font-size:26px; margin:6px 0 0; }
.otp-backdrop { z-index:60; }
.otp-input { font:500 22px var(--font-mono); letter-spacing:.3em; text-align:center; }
.dialog-error { margin:12px 0 0; padding:10px 14px; border-radius:8px; color:#d15c5c; background:rgba(209,92,92,.08); font-size:13px; }
.step-dialog label { margin-top:18px; }
.step-dialog .primary { width:100%; margin-top:24px; padding:12px; }
.link-button { display:block; margin:14px auto 0; border:0; background:none; color:var(--muted); }
.step-enter-active,.step-leave-active { transition:opacity .25s ease; }
.step-enter-active .step-dialog,.step-leave-active .step-dialog { transition:transform .35s var(--ease); }
.step-enter-from,.step-leave-to { opacity:0; }
.step-enter-from .step-dialog,.step-leave-to .step-dialog { transform:translateY(16px) scale(.98); }
.login-hint summary { cursor:pointer; color:var(--muted); }
.login-hint pre { margin:10px 0; padding:12px; overflow:auto; border-radius:8px; background:var(--surface); border:1px solid var(--line); color:var(--text-2); font:12px/1.7 var(--font-mono); white-space:pre; }
.security-status { margin-left:12px; font-size:12px; color:var(--muted); font-weight:400; }
.key-row { display:flex; align-items:center; justify-content:space-between; gap:16px; border-top:1px solid var(--line); margin-top:20px; padding-top:16px; }
.admin-top { position:sticky; top:0; z-index:20; display:flex; justify-content:space-between; align-items:center; height:64px; padding:0 32px; border-bottom:1px solid var(--line); background:var(--header-bg); -webkit-backdrop-filter:blur(16px); backdrop-filter:blur(16px); }
.admin-brand { font-size:18px; font-weight:700; display:flex; gap:12px; align-items:center; letter-spacing:-.01em; }
.admin-logo { width:30px; height:auto; }
.admin-brand span { margin-left:6px; font-size:12px; font-weight:400; color:var(--muted); padding-left:16px; border-left:1px solid var(--line-strong); }
.top-actions,.buttons { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.top-actions { font-size:13px; }
.top-actions>a { color:var(--muted); transition:color .2s; }.top-actions>a:hover { color:var(--text); }
.icon-button { display:grid; place-items:center; width:38px; height:38px; padding:0; }
.icon-button svg { width:18px; height:18px; }
button,.upload-button { font:inherit; font-size:13px; font-weight:500; padding:9px 16px; border:1px solid var(--field-line); border-radius:10px; background:var(--surface); color:var(--text); cursor:pointer; transition:border-color .2s,background .2s,color .2s,transform .2s var(--ease),box-shadow .2s; }
button:hover:not(:disabled),.upload-button:hover { border-color:var(--accent); color:var(--accent); }
button:active:not(:disabled) { transform:translateY(1px); }
button:disabled { opacity:.45; cursor:wait; }
.primary { background:var(--btn-bg); color:var(--btn-fg); border-color:var(--btn-bg); }
.primary:hover:not(:disabled) { color:var(--btn-fg); border-color:var(--btn-bg); box-shadow:0 8px 20px -10px color-mix(in srgb,var(--btn-bg) 70%,transparent); transform:translateY(-1px); }
.danger { color:#d15c5c; }
button.danger:hover:not(:disabled) { color:#d15c5c; border-color:#d15c5c; background:rgba(209,92,92,.06); }
.admin-layout { display:grid; grid-template-columns:232px 1fr; max-width:1440px; margin:auto; }
.admin-nav { position:sticky; top:64px; align-self:start; height:calc(100vh - 64px); overflow:auto; padding:36px 16px; border-right:1px solid var(--line); }
.admin-nav>.eyebrow { padding:0 12px; margin:0 0 12px; }
.eyebrow { font-size:11px; color:var(--faint); letter-spacing:.14em; text-transform:uppercase; }
.admin-nav>button { position:relative; display:flex; align-items:center; gap:12px; width:100%; border:0; background:none; margin:2px 0; padding:11px 12px; text-align:left; font-size:14px; font-weight:400; color:var(--text-2); }
.admin-nav>button svg { width:18px; height:18px; flex:none; fill:none; stroke:currentColor; stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round; opacity:.75; }
.admin-nav>button:hover:not(:disabled) { background:color-mix(in srgb,var(--text) 4%,transparent); color:var(--text); }
.admin-nav>button.selected { background:var(--accent-soft); color:var(--accent); font-weight:500; }
.admin-nav>button.selected svg { opacity:1; }
.admin-nav>button.selected::before { content:''; position:absolute; left:-16px; top:10px; bottom:10px; width:3px; border-radius:0 3px 3px 0; background:var(--accent); }
.nav-note { margin:32px 12px 0; font-size:12px; color:var(--faint); line-height:1.9; }
.admin-main { padding:40px clamp(24px,4vw,56px) 80px; min-width:0; max-width:1120px; }
fieldset { border:0; padding:0; margin:0; min-width:0; }
.section-head { display:flex; align-items:flex-end; justify-content:space-between; margin-bottom:28px; gap:20px; }
.section-head .eyebrow { margin:0; }
h1 { font-size:32px; margin:8px 0 0; letter-spacing:-.025em; }
h2 { font-size:17px; margin:0; letter-spacing:-.01em; }
.subtle { color:var(--muted); font-size:14px; margin:8px 0 20px; }
.form-grid { display:grid; grid-template-columns:1fr 1fr; gap:24px; }
label { display:flex; flex-direction:column; gap:8px; font-size:13px; font-weight:500; color:var(--text-2); }
.admin-main :deep(.select-field label) { font-size:13px; font-weight:500; color:var(--text-2); }
.admin-main :deep(.select-trigger) { min-height:44px; padding:10px 13px; border-color:var(--field-line); border-radius:10px; background:var(--bg); font-size:15px; }
.wide { grid-column:1 / -1; }
input,textarea,select { width:100%; font:inherit; font-size:15px; font-weight:400; border:1px solid var(--field-line); border-radius:10px; padding:10px 13px; background:var(--bg); color:var(--text); transition:border-color .2s,box-shadow .2s; }
input:hover,textarea:hover,select:hover { border-color:var(--line-strong); }
input:focus,textarea:focus,select:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 4px var(--accent-soft); }
input::placeholder,textarea::placeholder { color:var(--faint); }
textarea { resize:vertical; }
input:read-only { color:var(--muted); }
.field-hint { color:var(--muted); font-size:12px; font-weight:400; line-height:1.7; }
.edit-card { margin-bottom:20px; padding:24px 28px 28px; border:1px solid var(--line); border-radius:var(--radius); background:var(--surface); box-shadow:0 1px 2px rgba(17,24,39,.03),0 12px 32px -24px rgba(17,24,39,.12); }
.edit-card>h2+.subtle { margin-top:6px; }
.card-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; gap:16px; }
.checkbox { flex-direction:row; align-items:center; margin-top:18px; }
.checkbox input { width:16px; height:16px; accent-color:var(--accent); }
.sync-panel { display:flex; justify-content:space-between; align-items:center; gap:20px; border:1px solid var(--line); padding:24px 28px; border-radius:var(--radius); background:var(--surface); margin-bottom:20px; }
.sync-panel p { margin:8px 0; }.sync-error { color:#d15c5c; font-size:13px; }
.social-row { display:grid; grid-template-columns:170px 1fr auto auto; gap:16px; align-items:end; padding:16px 0; border-top:1px solid var(--line); }
.subtle+.social-row { border-top:0; padding-top:4px; }
.social-row .checkbox { margin:0 0 12px; white-space:nowrap; }
.social-row+button { margin-top:12px; }
.notes-source { display:block; }
.source-status { display:flex; flex-direction:column; gap:10px; align-items:flex-start; }
.source-status .checkbox { margin:24px 0 0; flex-wrap:wrap; }
.note-editor { margin-bottom:24px; padding:24px 28px; border:1px solid color-mix(in srgb,var(--accent) 45%,transparent); border-radius:var(--radius); background:var(--surface); box-shadow:0 0 0 4px var(--accent-soft); }
.note-editor .form-grid { margin-bottom:8px; }
.note-editor .checkbox { margin:16px 0 0; }
.note-toolbar { display:flex; justify-content:space-between; align-items:center; gap:16px; flex-wrap:wrap; margin-bottom:16px; }
.note-toolbar input { max-width:280px; }
.note-toolbar button.selected { border-color:var(--accent); color:var(--accent); background:var(--accent-soft); }
.note-list { list-style:none; margin:0; padding:0; border-top:1px solid var(--line); }
.note-list li { display:flex; justify-content:space-between; align-items:center; gap:16px; padding:14px 4px; border-bottom:1px solid var(--line); transition:opacity .3s; }
.note-list li.muted .note-info { opacity:.5; }
.note-info { min-width:0; }
.note-info strong { display:block; font-weight:500; overflow-wrap:anywhere; }
.note-info span { display:block; margin-top:4px; color:var(--muted); font-size:12px; overflow-wrap:anywhere; }
.note-list .buttons>a { font-size:13px; color:var(--accent); }
.switch { flex-direction:row; align-items:center; gap:8px; cursor:pointer; }
.switch input { appearance:none; width:34px; height:20px; padding:0; border-radius:999px; background:var(--line-strong); position:relative; cursor:pointer; transition:background .25s; }
.switch input::after { content:''; position:absolute; top:3px; left:3px; width:14px; height:14px; border-radius:50%; background:#fff; transition:transform .25s var(--ease); }
.switch input:checked { background:var(--accent); }
.switch input:checked::after { transform:translateX(14px); }
.switch span { min-width:28px; font-size:12px; }
.form-grid.tight { gap:12px; }
.test-mail { display:flex; gap:10px; flex-wrap:wrap; margin:20px 0 8px; }
.test-mail input { max-width:300px; }
.user-info { display:flex; align-items:center; gap:12px; min-width:0; }
.user-face { flex:none; display:grid; place-items:center; width:36px; height:36px; border-radius:50%; overflow:hidden; background:linear-gradient(135deg,var(--accent),#7ea2ff); color:#fff; font-weight:700; }
.user-face img { width:100%; height:100%; object-fit:cover; }
.user-list li { flex-wrap:wrap; }
.image-grid { list-style:none; margin:16px 0 0; padding:0; display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:14px; }
.image-grid li { padding:8px; border:1px solid var(--field-line); border-radius:12px; }
.image-grid img { display:block; width:100%; aspect-ratio:4/3; object-fit:contain; border-radius:8px; background:var(--bg-tint); }
.image-grid .buttons { gap:4px; } .image-grid button { padding:5px 8px; font-size:12px; }
.fresh-token { overflow-wrap:anywhere; font-size:13px; }
.pager { justify-content:center; margin-top:16px; }
.hidden-repos { max-width:500px; }.group-title { margin-top:36px; }
.group-title.first { margin-top:0; }
.label-line { display:flex; justify-content:space-between; align-items:baseline; gap:12px; }
.beian-preview { display:flex; flex-direction:column; gap:10px; padding:16px 18px; border:1px dashed var(--line-strong); border-radius:8px; }
.beian-preview p { display:flex; flex-wrap:wrap; gap:8px 20px; margin:0; color:var(--faint); font-size:13px; }
.beian-preview p span { display:inline-flex; align-items:center; gap:6px; }
.feedback { position:fixed; z-index:40; left:50%; top:76px; transform:translateX(-50%); width:max-content; max-width:min(640px,calc(100vw - 32px)); margin:0; padding:12px 20px; border-radius:12px; font-size:14px; box-shadow:0 16px 40px -16px rgba(0,0,0,.25); -webkit-backdrop-filter:blur(12px); backdrop-filter:blur(12px); animation:toast-in .4s var(--ease); }
@keyframes toast-in { from { opacity:0; transform:translate(-50%,-8px); } }
.feedback { display:flex; align-items:center; gap:12px; }
.toast-close { flex:none; display:grid; place-items:center; width:24px; height:24px; margin-right:-6px; padding:0; border:0; border-radius:6px; background:none; color:inherit; font-size:18px; line-height:1; opacity:.6; }
.toast-close:hover:not(:disabled) { opacity:1; color:inherit; background:color-mix(in srgb,currentColor 10%,transparent); }
.toast-leave-active { transition:opacity .25s ease,transform .25s ease; }
.toast-leave-to { opacity:0; transform:translate(-50%,-6px); }
.error { color:#d15c5c; background:color-mix(in srgb,var(--surface) 90%,#d15c5c); border:1px solid rgba(209,92,92,.25); }.success { color:var(--accent); background:color-mix(in srgb,var(--surface) 90%,var(--accent)); border:1px solid color-mix(in srgb,var(--accent) 25%,transparent); }
.login-panel { max-width:440px; margin:10vh auto; padding:40px 36px; border:1px solid var(--line); border-radius:20px; background:var(--surface); box-shadow:0 30px 60px -36px rgba(17,24,39,.25); }
.login-panel h1 { font-size:40px; }.login-panel label { margin-top:24px; }.login-panel .primary { width:100%; margin-top:28px; padding:13px; }
.login-hint { color:var(--faint); font-size:12px; margin-top:24px; }
.writing-layout { display:grid; grid-template-columns:210px 1fr; gap:36px; }
.article-sidebar { border-right:1px solid var(--line); padding-right:20px; }
.article-sidebar button { width:100%; border:0; border-radius:10px; text-align:left; padding:12px; margin-bottom:4px; background:none; color:var(--text); }
.article-sidebar button:hover:not(:disabled) { color:var(--text); background:color-mix(in srgb,var(--text) 4%,transparent); }
.article-sidebar button.selected { background:var(--accent-soft); }.article-sidebar strong { display:block; overflow-wrap:anywhere; font-size:14px; font-weight:500; }.article-sidebar span { display:block; color:var(--muted); font-size:11px; margin-top:6px; }
.editor { min-width:0; }.editor>label { margin-bottom:20px; }.editor-status { display:flex; gap:10px; color:var(--muted); font-size:12px; margin-bottom:24px; }
.editor-status span { padding:4px 10px; border-radius:999px; background:color-mix(in srgb,var(--text) 5%,transparent); }
.editor-status span+span { color:#b7791f; background:rgba(214,158,46,.12); }
.slug-field { display:flex; align-items:stretch; }
.slug-prefix { display:flex; align-items:center; padding:0 12px; border:1px solid var(--field-line); border-right:0; border-radius:10px 0 0 10px; background:color-mix(in srgb,var(--text) 3%,transparent); color:var(--muted); font:13px var(--font-mono); }
.slug-field input { border-radius:0 10px 10px 0; font-family:var(--font-mono); font-size:14px; }
.markdown-tools { display:flex; align-items:center; justify-content:space-between; margin:28px 0 12px; }
.upload-button { position:relative; overflow:hidden; display:block; }.upload-button input { position:absolute; inset:0; opacity:0; cursor:pointer; }
.markdown-input { font-family:var(--font-mono); font-size:14px; line-height:1.8; }
.editor-actions { display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin:28px 0 14px; }.editor-actions>a { font-size:13px; color:var(--accent); }
.preview-panel { margin-top:28px; padding:28px; border:1px solid var(--line); border-radius:var(--radius); background:var(--surface); }.preview-panel h2 { margin-bottom:24px; }
@media(max-width:1050px) { .writing-layout { grid-template-columns:1fr; }.article-sidebar { border-right:0; border-bottom:1px solid var(--line); max-height:220px; overflow:auto; }.admin-layout { grid-template-columns:180px 1fr; } }
@media(max-width:700px) { .admin-top { padding:0 16px; }.admin-brand span { display:none; }.admin-layout { grid-template-columns:1fr; }.admin-nav { padding:16px 20px; border-right:0; display:flex; gap:6px; overflow:auto; }.admin-nav>.eyebrow,.nav-note { display:none; }.admin-nav { position:static; height:auto; }.admin-nav>button { white-space:nowrap; margin:0; width:auto; padding:9px 12px; }.admin-nav>button.selected::before { display:none; }.edit-card,.sync-panel,.note-editor { padding:20px; }.login-panel { margin:6vh 16px; padding:32px 24px; }.admin-main { padding:24px 20px; }.form-grid { grid-template-columns:1fr; }.section-head,.sync-panel { align-items:flex-start; flex-direction:column; }.social-row { grid-template-columns:1fr; }.note-list li { flex-direction:column; align-items:flex-start; }.card-head { flex-wrap:wrap; } }
</style>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { fetchJson } from '../content'
import type { SiteContent } from '../types'
import { useTheme } from '../composables/useTheme'
import { passkeyAvailable, usePasskey } from '../passkeys'

type Draft = { title: string; slug: string; summary: string; markdown: string; cover: string }
type Article = { id: string; revision: number; draft: Draft; published: object | null; slug_locked: boolean }
type ArticleItem = { id: string; title: string; slug: string; published: boolean; updated_at: string }
type SyncState = { last_success: string | null; last_error: string; items: unknown[] }
const { theme, toggle } = useTheme()
const csrf = ref(''), loading = ref(true), busy = ref(false), error = ref(''), message = ref('')
const username = ref('admin'), password = ref(''), otp = ref('')
const tab = ref<'profile' | 'portals' | 'repos' | 'posts' | 'notes' | 'security'>('profile')
type SecurityState = {totp_enabled:boolean; recovery_remaining:number; passkeys:{id:string; name:string; created_at:number; last_used:number|null}[]}
const security = ref<SecurityState>(), securityPassword = ref(''), securityOtp = ref(''), keyName = ref('我的设备')
const enrollment = ref<{secret:string; qr:string}>(), recoveryCodes = ref<string[]>([])
const canPasskey = computed(() => passkeyAvailable())
async function loadSecurity() { security.value = await api<SecurityState>('/api/admin/security') }
const securityPasswordInput = ref<HTMLInputElement>()
// 绑定、撤销与两步验证都需再次确认密码；空值先在前端提示，避免显示接口的英文校验信息。
function proof() {
  if (!securityPassword.value) { securityPasswordInput.value?.focus(); throw new Error('请先在上方「确认当前密码」中输入登录密码。') }
  return {password:securityPassword.value, otp:securityOtp.value}
}
async function factorOperation(operation:string) { await action(async () => {
  const result = await api<{secret?:string; qr?:string; recovery_codes?:string[]}>(`/api/admin/security/2fa/${operation}`, 'POST', proof())
  if(operation==='setup') enrollment.value={secret:result.secret!,qr:result.qr!}
  else { enrollment.value=undefined; securityPassword.value=''; securityOtp.value=''; recoveryCodes.value=result.recovery_codes ?? [] }
  await loadSecurity(); message.value=operation==='setup' ? '请扫描二维码，然后输入验证码确认绑定。' : '安全设置已更新，其他会话已撤销。'
}) }
async function keyLogin() { await action(async () => {
  const options = await api<{options:Record<string,any>;challenge_id:string}>('/api/auth/passkey/options','POST')
  const credential = await usePasskey(options.options)
  const result = await api<{csrf:string}>('/api/auth/passkey/verify','POST',{challenge_id:options.challenge_id,credential})
  csrf.value=result.csrf; password.value=''; otp.value=''
  await loadSettings(); await listArticles(); await loadSecurity(); await loadNotes()
}) }
async function addPasskey() { await action(async () => {
  const options = await api<{options:Record<string,any>;challenge_id:string}>('/api/admin/security/passkeys/options','POST',{...proof(),name:keyName.value})
  const credential = await usePasskey(options.options,true)
  await api('/api/admin/security/passkeys/verify','POST',{challenge_id:options.challenge_id,credential,name:keyName.value})
  securityPassword.value=''; securityOtp.value=''; await loadSecurity(); message.value='Passkey 已绑定，下次可以直接使用设备验证登录。'
}) }
async function removePasskey(id:string) { await action(async () => {
  const body = proof()
  if(!confirm('撤销后这个 Passkey 将不能再登录，继续吗？')) return
  await api(`/api/admin/security/passkeys/${encodeURIComponent(id)}/remove`,'POST',body)
  securityPassword.value=''; securityOtp.value=''; await loadSecurity(); message.value='Passkey 已撤销，其他会话已退出。'
}) }
const settings = ref<SiteContent>(), siteRevision = ref(0)
const articles = ref<ArticleItem[]>([]), article = ref<Article>(), draft = ref<Draft>(emptyDraft())
const preview = ref(''), syncState = ref<SyncState>(), lastDraft = ref('')
const lastSite = ref(''), rolesText = ref(''), hiddenText = ref('')
const dirty = computed(() => JSON.stringify(draft.value) !== lastDraft.value)
const siteDirty = computed(() => !!settings.value && JSON.stringify(currentSite()) !== lastSite.value)
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
function emptyDraft(): Draft { return { title: '', slug: '', summary: '', markdown: '', cover: '' } }

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
  const data = await api<{csrf: string}>('/api/auth/login', 'POST', {username: username.value, password: password.value,otp:otp.value})
  csrf.value = data.csrf; password.value = ''; otp.value=''
  await loadSettings(); await listArticles(); await loadSecurity(); await loadNotes()
}) }
async function logout() { await action(async () => {
  if(((dirty.value && draft.value.title) || siteDirty.value) && !confirm('有未保存修改，仍要退出吗？')) return
  await api('/api/auth/logout', 'POST'); csrf.value = ''; settings.value = undefined
  article.value = undefined; draft.value = emptyDraft(); lastDraft.value = JSON.stringify(draft.value)
  preview.value = ''; articles.value = []; syncState.value = undefined
  noteItems.value = []; notesConfig.value = undefined; noteEdit.value = undefined
  security.value=undefined; securityPassword.value=''; securityOtp.value=''; enrollment.value=undefined; recoveryCodes.value=[]
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
async function renderPreview() { await action(async () => {
  preview.value = (await api<{html: string}>('/api/admin/preview', 'POST', {markdown: draft.value.markdown})).html
}) }
async function upload(event: Event, insert = (markdown: string) => { draft.value.markdown += markdown }) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]
  if(!file) return
  await action(async () => {
    if(file.size > 10 * 1024 * 1024) throw new Error('图片不能超过 10 MiB')
    const result = await fetchJson<{url: string}>('/api/admin/media', {method:'POST', body:file,
      headers:{'Content-Type':file.type || 'application/octet-stream','X-CSRF-Token':csrf.value},
      credentials:'same-origin', signal:AbortSignal.timeout(60000)})
    insert(`\n\n![图片说明](${result.url})\n`)
    message.value = `图片已插入正文：${result.url}`
  })
  input.value = ''
}
// 从本地 Markdown 文件导入：首个一级标题作为标题，文件名作为地址，其余为正文。
async function importMarkdown(event: Event, target: 'post' | 'note') {
  const input = event.target as HTMLInputElement, file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (file.size > 500_000) { error.value = 'Markdown 文件不能超过 500 KB'; return }
  let text = (await file.text()).replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(text)
  const title = (heading?.[1] ?? file.name.replace(/\.(md|markdown|txt)$/i, '')).trim().slice(0, 200)
  if (heading && text.trimStart().startsWith(heading[0])) text = text.trimStart().slice(heading[0].length).trimStart()
  const base = file.name.replace(/\.(md|markdown|txt)$/i, '').toLowerCase()
  const slug = (target === 'post' ? base.replace(/[^a-z0-9]+/g, '-') : base.replace(/[^a-z0-9一-鿿]+/g, '-')).replace(/^-+|-+$/g, '').slice(0, 120)
  if (target === 'post') {
    if (dirty.value && draft.value.title && !confirm('当前文章有未保存修改，导入会替换编辑区，继续吗？')) return
    article.value = undefined
    draft.value = { ...emptyDraft(), title, slug, markdown: text }
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
    csrf.value = (await api<{csrf: string}>('/api/auth/me')).csrf
    await loadSettings(); await listArticles(); await loadSecurity(); await loadNotes()
  } catch(err) { if((err as {status?: number}).status !== 401) error.value = err instanceof Error ? err.message : '后台加载失败' }
  finally { loading.value = false }
})
onBeforeUnmount(() => window.removeEventListener('beforeunload', preventLeave))
</script>

<template>
  <div class="admin-shell">
    <header class="admin-top"><a href="/" class="admin-brand">Copy Lee<span>内容管理</span></a>
      <div class="top-actions"><a href="/" target="_blank">查看网站 ↗</a><button @click="toggle" :aria-label="theme === 'dark' ? '切换浅色主题' : '切换深色主题'">◐</button><button v-if="csrf" @click="logout" :disabled="busy">退出</button></div>
    </header>
    <p v-if="error" class="feedback error" role="alert">{{ error }}</p>
    <p v-if="message" class="feedback success" role="status">{{ message }}</p>
    <main v-if="loading" class="login-panel"><p>正在加载后台…</p></main>
    <main v-else-if="!csrf" class="login-panel">
      <p class="eyebrow">Your personal space</p><h1>欢迎回来。</h1><p class="subtle">登录后编辑主页，或写下新的一篇。</p>
      <form @submit.prevent="login"><fieldset :disabled="busy"><label>管理员账号<input v-model="username" autocomplete="username" required maxlength="80"></label>
        <label>密码<input v-model="password" type="password" autocomplete="current-password" required maxlength="200"></label>
        <label>两步验证码 / 恢复码<span class="field-hint">开启 TOTP 后填写；未开启时留空</span><input v-model="otp" autocomplete="one-time-code" maxlength="80"></label>
        <button class="primary" type="submit">{{ busy ? '正在登录…' : '登录后台' }}</button></fieldset></form>
      <button @click="keyLogin" :disabled="busy || !canPasskey" class="passkey-login">使用 Passkey 登录</button>
      <p class="field-hint">已绑定的设备可使用指纹、面容或 PIN，无需输入密码。</p>
      <p class="login-hint">HTTP 阶段请通过 SSH 隧道访问。忘记密码时在服务器重置账号。</p>
    </main>
    <div v-else class="admin-layout">
      <aside class="admin-nav"><p class="eyebrow">Workspace</p><button v-for="item in [{id:'profile',name:'主页设置'},{id:'portals',name:'入口卡片'},{id:'repos',name:'仓库展示'},{id:'posts',name:'文章管理'},{id:'notes',name:'笔记管理'},{id:'security',name:'登录安全'}]" :key="item.id" :class="{selected:tab===item.id}" @click="tab=item.id as typeof tab">{{ item.name }}<span>↗</span></button><p class="nav-note">内容保存后即可更新。<br>页面样式仍由代码管理。</p></aside>
      <main class="admin-main"><fieldset :disabled="busy">
        <template v-if="tab==='security'">
          <div class="section-head"><div><p class="eyebrow">Account access</p><h1>登录安全</h1></div></div>
          <p class="subtle">选择适合你的登录方式。Passkey 使用设备验证；开启 TOTP 后，密码登录还需要验证码。</p>
          <div class="form-grid security-proof"><label>确认当前密码<span class="field-hint">绑定或撤销前再次确认</span><input ref="securityPasswordInput" v-model="securityPassword" type="password" autocomplete="current-password" maxlength="200"></label><label>验证码 / 恢复码<span class="field-hint">已开启 TOTP 时填写；绑定时填写新验证码</span><input v-model="securityOtp" autocomplete="one-time-code" maxlength="80"></label></div>
          <section class="edit-card security-card"><h2>Passkey</h2><p class="subtle">绑定后可用指纹、面容、设备 PIN 或安全密钥登录。可绑定多个设备，最多 10 个。</p>
            <div class="form-grid"><label>设备名称<input v-model="keyName" maxlength="80" placeholder="例如：我的手机"></label></div>
            <button @click="addPasskey" :disabled="!canPasskey">绑定 Passkey</button>
            <p class="field-hint">正式站点使用 HTTPS 后，请在正式域名重新绑定。本地 Passkey 仅适用于 localhost。</p>
            <div v-for="key in security?.passkeys" :key="key.id" class="key-row"><div><strong>{{key.name}}</strong><p class="field-hint">{{key.last_used ? `最近使用：${new Date(key.last_used*1000).toLocaleString()}` : '尚未用于登录'}}</p></div><button class="danger" @click="removePasskey(key.id)">撤销</button></div>
            <p v-if="!security?.passkeys.length" class="field-hint">还没有绑定设备。</p>
          </section>
          <section class="edit-card security-card"><h2>两步验证（TOTP）<span class="security-status">{{security?.totp_enabled ? '已开启' : '未开启'}}</span></h2>
            <p class="subtle">使用验证器 App 生成 6 位验证码。默认关闭，可随时开启；恢复码每个只能使用一次。</p>
            <template v-if="enrollment"><img class="totp-qr" :src="enrollment.qr" alt="验证器绑定二维码"><label>手动绑定密钥<input :value="enrollment.secret" readonly autocomplete="off"></label><p class="field-hint">二维码和密钥请勿分享。绑定在 10 分钟后失效；在上方输入验证码确认。</p><button class="primary" @click="factorOperation('enable')">确认开启</button></template>
            <button v-else-if="!security?.totp_enabled" @click="factorOperation('setup')">开始绑定验证器</button>
            <div v-else class="buttons"><button @click="factorOperation('recovery')">重新生成恢复码</button><button class="danger" @click="factorOperation('disable')">关闭两步验证</button><span class="field-hint">剩余恢复码：{{security.recovery_remaining}}</span></div>
          </section>
          <section v-if="recoveryCodes.length" class="edit-card"><h2>保存恢复码</h2><p class="subtle">这些恢复码仅显示一次。请保存到安全位置；重新生成后旧恢复码失效。</p><pre class="recovery-codes">{{recoveryCodes.join('\n')}}</pre><button @click="recoveryCodes=[]">我已保存恢复码</button></section>
          <p class="field-hint">设备丢失时，可在服务器使用 reset-security 重置登录因素。重置密码保留已绑定因素；安全设置修改会撤销其他会话。</p>
        </template>
        <template v-if="tab !== 'posts' && tab !== 'notes' && tab !== 'security' && settings">
          <div class="section-head"><div><p class="eyebrow">Site content</p><h1>{{ tab==='profile' ? '主页设置' : tab==='portals' ? '入口卡片' : '仓库展示' }}</h1></div>
            <div class="buttons"><button @click="reloadSettings">重新加载</button><button class="primary" @click="saveSettings">{{busy ? '处理中…' : '保存设置'}}</button></div></div>
          <div v-if="tab==='profile'" class="form-grid">
            <label>显示名称<input v-model="settings.name" maxlength="80"></label><label>问候语<input v-model="settings.greeting" maxlength="100"></label>
            <label class="wide">个人简介<textarea v-model="settings.intro" rows="3" maxlength="2000"></textarea></label>
            <label>身份标签<span class="field-hint">每行一个</span><textarea v-model="rolesText" rows="4"></textarea></label>
            <label>GitHub 用户名<input v-model="settings.github" maxlength="39"></label>
            <label>Cloud 地址<input v-model="settings.cloud" type="url"></label>
            <label>ICP备案号<input v-model="settings.icp" maxlength="100"></label><label>公安备案文字<input v-model="settings.police.text" maxlength="100"></label>
            <label>公安备案编号<input v-model="settings.police.code" inputmode="numeric"></label>
          </div>
          <template v-if="tab==='profile'">
            <h2 class="group-title">社交主页</h2><p class="subtle">图标显示在页脚。关闭“公开显示”或留空地址的条目不会出现在网站上。</p>
            <div v-for="(social,index) in settings.socials" :key="index" class="social-row">
              <label>平台<select v-model="social.platform"><option v-for="[value,name] in socialPlatforms" :key="value" :value="value">{{ name }}</option></select></label>
              <label class="social-url">{{ social.platform==='email' ? '邮箱地址' : '主页地址' }}<input v-model="social.url" :type="social.platform==='email' ? 'email' : 'url'" :placeholder="social.platform==='email' ? 'me@example.com' : 'https://…'"></label>
              <label class="checkbox"><input type="checkbox" v-model="social.visible">公开显示</label>
              <div class="buttons"><button @click="move(settings.socials,index,-1)" :disabled="index===0">上移</button><button class="danger" @click="settings.socials.splice(index,1)">移除</button></div>
            </div>
            <button @click="settings.socials.push({platform:'instagram',url:'',visible:true})">＋ 添加社交主页</button>
          </template>
          <template v-if="tab==='portals'">
            <p class="subtle">卡片按列表顺序展示。隐藏卡片仍可在这里继续编辑。</p>
            <section v-for="(portal,index) in settings.portals" :key="index" class="edit-card">
              <div class="card-head"><span class="eyebrow">入口 {{ String(index+1).padStart(2,'0') }}</span><div class="buttons"><button @click="move(settings.portals,index,-1)" :disabled="index===0">上移</button><button @click="move(settings.portals,index,1)" :disabled="index===settings.portals.length-1">下移</button><button class="danger" @click="settings.portals.splice(index,1)">移除</button></div></div>
              <div class="form-grid"><label>名称<input v-model="portal.title" maxlength="80"></label><label>图标<select v-model="portal.icon"><option value="cloud">Cloud</option><option value="note">Notes</option><option value="github">GitHub</option></select></label>
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
              <label>固定链接<input v-model="draft.slug" :readonly="article?.slug_locked" placeholder="my-first-post" maxlength="120"><span class="field-hint">小写字母、数字和连字符；首次发布后锁定。</span></label>
              <label>摘要<textarea v-model="draft.summary" rows="2" maxlength="1000"></textarea></label>
              <label>封面地址<input v-model="draft.cover" placeholder="https://… 或 /media/…"></label>
              <div class="markdown-tools"><span class="eyebrow">Markdown</span><div class="buttons"><label class="upload-button">上传图片<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" @change="upload"></label><button @click="renderPreview">预览</button></div></div>
              <textarea v-model="draft.markdown" class="markdown-input" rows="18" aria-label="Markdown 正文" placeholder="从这里开始…"></textarea>
              <p class="field-hint">图片上传后可公开访问，单张上限 10 MiB；上传会将图片链接插入正文。</p>
              <section v-if="preview" class="preview-panel"><h2>预览</h2><div class="prose" v-html="preview"></div></section>
              <div class="editor-actions"><button @click="saveDraft">保存草稿</button><button class="primary" @click="publish">{{article?.published ? '发布更新' : '发布文章'}}</button><button v-if="article?.published" class="danger" @click="unpublish">撤下</button><a v-if="article?.published" :href="`/posts/${article.draft.slug}`" target="_blank">查看公开版本 ↗</a></div>
              <p class="field-hint">保存草稿不会修改公开内容。发布会先保存当前编辑内容，再更新公开版本。</p>
            </div></div>
        </template>
      </fieldset></main>
    </div>
  </div>
</template>

<style scoped>
.admin-shell { min-height:100vh; }
.passkey-login { margin-top:16px; width:100%; }
.security-proof { margin:24px 0; }
.security-card>button,.security-card>.buttons { margin-top:20px; }
.security-card>.form-grid+button { margin-top:16px; }
.security-card>.field-hint { margin-top:12px; }
.security-card>label,.security-card>.totp-qr { display:block; margin-top:16px; }
.security-status { margin-left:12px; font-size:12px; color:var(--muted); font-weight:400; }
.totp-qr { width:200px; height:200px; display:block; margin:20px 0; }
.key-row { display:flex; align-items:center; justify-content:space-between; gap:16px; border-top:1px solid var(--line); margin-top:20px; padding-top:16px; }
.recovery-codes { white-space:pre-wrap; overflow-wrap:anywhere; font-size:13px; padding:16px; background:var(--surface); }
.admin-top { display:flex; justify-content:space-between; align-items:center; padding:20px 40px; border-bottom:1px solid var(--line); }
.admin-brand { font-size:20px; font-weight:700; display:flex; gap:20px; align-items:center; }
.admin-brand span { font-size:12px; font-weight:400; color:var(--muted); padding-left:20px; border-left:1px solid var(--line-strong); }
.top-actions,.buttons { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.top-actions { font-size:13px; }
button,.upload-button { font:inherit; font-size:13px; padding:9px 16px; border:1px solid var(--line-strong); border-radius:8px; background:var(--surface); color:var(--text); cursor:pointer; }
button:hover { border-color:var(--accent); }
button:disabled { opacity:.45; cursor:wait; }
.primary { background:var(--btn-bg); color:var(--btn-fg); border-color:var(--btn-bg); }
.danger { color:#d15c5c; }
.admin-layout { display:grid; grid-template-columns:220px 1fr; max-width:1500px; margin:auto; }
.admin-nav { padding:48px 24px; border-right:1px solid var(--line); }
.eyebrow { font-size:11px; color:var(--faint); letter-spacing:.14em; text-transform:uppercase; }
.admin-nav>button { display:flex; justify-content:space-between; width:100%; border:0; background:none; margin:10px 0; padding:14px; text-align:left; }
.admin-nav>button span { opacity:0; }
.admin-nav>button.selected { background:var(--accent-soft); color:var(--accent); }
.admin-nav>button.selected span { opacity:1; }
.nav-note { margin-top:40px; font-size:12px; color:var(--faint); line-height:1.9; }
.admin-main { padding:48px clamp(24px,4vw,64px); min-width:0; }
fieldset { border:0; padding:0; margin:0; min-width:0; }
.section-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:36px; gap:20px; }
h1 { font-size:32px; margin:8px 0 0; letter-spacing:-.025em; }
h2 { font-size:18px; }
.subtle { color:var(--muted); font-size:14px; margin:8px 0 20px; }
.form-grid { display:grid; grid-template-columns:1fr 1fr; gap:24px; }
label { display:flex; flex-direction:column; gap:8px; font-size:13px; color:var(--text-2); }
.wide { grid-column:1 / -1; }
input,textarea,select { width:100%; font:inherit; font-size:15px; border:1px solid var(--line-strong); border-radius:8px; padding:11px 13px; background:var(--bg); color:var(--text); }
textarea { resize:vertical; }
input:read-only { color:var(--muted); }
.field-hint { color:var(--muted); font-size:12px; line-height:1.7; }
.edit-card { border-top:1px solid var(--line); padding:24px 0 32px; }
.card-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; gap:16px; }
.checkbox { flex-direction:row; align-items:center; margin-top:18px; }
.checkbox input { width:16px; height:16px; accent-color:var(--accent); }
.sync-panel { display:flex; justify-content:space-between; align-items:center; gap:20px; border:1px solid var(--line); padding:24px; border-radius:12px; margin-bottom:32px; }
.sync-panel p { margin:8px 0; }.sync-error { color:#d15c5c; font-size:13px; }
.social-row { display:grid; grid-template-columns:150px 1fr auto auto; gap:16px; align-items:end; padding:16px 0; border-top:1px solid var(--line); }
.social-row .checkbox { margin:0 0 12px; white-space:nowrap; }
.social-row+button { margin-top:12px; }
.notes-source { display:block; }
.source-status { display:flex; flex-direction:column; gap:10px; align-items:flex-start; }
.source-status .checkbox { margin:24px 0 0; flex-wrap:wrap; }
.note-editor { margin-bottom:32px; padding:24px; border:1px solid var(--accent); border-radius:12px; }
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
.hidden-repos { max-width:500px; }.group-title { margin-top:36px; }
.feedback { padding:14px 24px; margin:16px 40px 0; border-radius:8px; font-size:14px; }
.error { color:#d15c5c; background:rgba(209,92,92,.08); }.success { color:var(--accent); background:var(--accent-soft); }
.login-panel { max-width:440px; margin:12vh auto; padding:0 24px; }
.login-panel h1 { font-size:40px; }.login-panel label { margin-top:24px; }.login-panel .primary { width:100%; margin-top:28px; padding:13px; }
.login-hint { color:var(--faint); font-size:12px; margin-top:24px; }
.writing-layout { display:grid; grid-template-columns:210px 1fr; gap:36px; }
.article-sidebar { border-right:1px solid var(--line); padding-right:20px; }
.article-sidebar button { width:100%; border:0; border-radius:0; text-align:left; padding:14px 10px; margin-bottom:8px; background:none; }
.article-sidebar button.selected { background:var(--accent-soft); }.article-sidebar strong { display:block; overflow-wrap:anywhere; font-size:14px; font-weight:500; }.article-sidebar span { display:block; color:var(--muted); font-size:11px; margin-top:6px; }
.editor { min-width:0; }.editor>label { margin-bottom:20px; }.editor-status { display:flex; gap:20px; color:var(--muted); font-size:12px; margin-bottom:24px; }
.markdown-tools { display:flex; align-items:center; justify-content:space-between; margin:28px 0 12px; }
.upload-button { position:relative; overflow:hidden; display:block; }.upload-button input { position:absolute; inset:0; opacity:0; cursor:pointer; }
.markdown-input { font-family:var(--font-mono); font-size:14px; line-height:1.8; }
.editor-actions { display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin:28px 0 14px; }.editor-actions>a { font-size:13px; color:var(--accent); }
.preview-panel { margin-top:28px; padding:24px; border:1px solid var(--line); border-radius:12px; }.preview-panel h2 { margin-bottom:24px; }
@media(max-width:1050px) { .writing-layout { grid-template-columns:1fr; }.article-sidebar { border-right:0; border-bottom:1px solid var(--line); max-height:220px; overflow:auto; }.admin-layout { grid-template-columns:180px 1fr; } }
@media(max-width:700px) { .admin-top { padding:16px 20px; }.admin-brand span { display:none; }.admin-layout { grid-template-columns:1fr; }.admin-nav { padding:16px 20px; border-right:0; display:flex; gap:6px; overflow:auto; }.admin-nav>.eyebrow,.nav-note { display:none; }.admin-nav>button { white-space:nowrap; margin:0; width:auto; padding:10px 12px; }.admin-nav>button span { display:none; }.admin-main { padding:24px 20px; }.form-grid { grid-template-columns:1fr; }.section-head,.sync-panel { align-items:flex-start; flex-direction:column; }.social-row { grid-template-columns:1fr; }.note-list li { flex-direction:column; align-items:flex-start; }.feedback { margin:16px 20px 0; }.card-head { flex-wrap:wrap; } }
</style>

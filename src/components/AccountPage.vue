<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { account, accountApi, accountChecked, loadAccount, signedIn, signOut } from '../account'
import type { AccountEntry, AccountUser } from '../account'
import { fetchJson } from '../content'
import { vReveal } from '../composables/useReveal'
import PageHeading from './PageHeading.vue'
import { games, loadMine } from '../games/api'
import type { GameBest, GameId } from '../games/api'

type Mode = 'login' | 'register' | 'reset'
const mode = ref<Mode>('login')
const tab = ref<'favorites' | 'history' | 'settings'>('favorites')
const busy = ref(false), error = ref(''), message = ref('')
const email = ref(''), password = ref(''), code = ref(''), name = ref(''), agree = ref(false)
const cooldown = ref(0)
const config = ref<{ registrationOpen: boolean; allowedDomains: string[] }>()
const favorites = ref<AccountEntry[]>([]), history = ref<AccountEntry[]>([])
const gameBests = ref<Partial<Record<GameId, GameBest | null>>>({})
const editName = ref(''), currentPassword = ref(''), newPassword = ref(''), deletePassword = ref('')
let timer: ReturnType<typeof setInterval> | undefined

const domainHint = computed(() => (config.value?.allowedDomains ?? []).slice(0, 8).join('、'))
// 登录后回到原页面：只接受本站相对路径。
const next = (() => { const value = new URLSearchParams(location.search).get('next') ?? ''; return /^\/(?!\/)/.test(value) ? value : '' })()

async function run(work: () => Promise<void>) {
  if (busy.value) return
  busy.value = true; error.value = ''; message.value = ''
  try { await work() } catch (err) { error.value = err instanceof Error ? err.message : '操作失败' }
  finally { busy.value = false }
}
function switchMode(value: Mode) { mode.value = value; error.value = ''; message.value = ''; code.value = ''; password.value = '' }

function startCooldown(seconds: number) {
  cooldown.value = seconds
  clearInterval(timer)
  timer = setInterval(() => { cooldown.value -= 1; if (cooldown.value <= 0) clearInterval(timer) }, 1000)
}
const sendCode = () => run(async () => {
  const result = await accountApi<{ resend_after: number }>('/code', 'POST', { email: email.value, purpose: mode.value === 'register' ? 'register' : 'reset' })
  startCooldown(result.resend_after)
  message.value = mode.value === 'register' ? '验证码已发送，请查收邮件（可能在垃圾箱）。' : '如果该邮箱已注册，验证码已发送。'
})
async function afterSignIn(result: { user: AccountUser; csrf: string }) {
  signedIn(result); password.value = ''; code.value = ''
  if (next) { location.href = next; return }
  await loadLists()
}
const submit = () => run(async () => {
  if (mode.value === 'login') await afterSignIn(await accountApi('/login', 'POST', { email: email.value, password: password.value }))
  else if (mode.value === 'register') {
    if (!agree.value) throw new Error('请先阅读并同意账户说明')
    await afterSignIn(await accountApi('/register', 'POST', { email: email.value, code: code.value, name: name.value, password: password.value }))
    message.value = '注册成功，欢迎你！'
  } else {
    await afterSignIn(await accountApi('/reset', 'POST', { email: email.value, code: code.value, password: password.value }))
    message.value = '密码已重置，已为你登录。'
  }
})

async function loadLists() {
  const [fav, hist] = await Promise.all([accountApi<{ items: AccountEntry[] }>('/favorites'), accountApi<{ items: AccountEntry[] }>('/history')])
  favorites.value = fav.items; history.value = hist.items
  gameBests.value = await loadMine().catch(() => ({}))
}
const removeFavorite = (item: AccountEntry) => run(async () => {
  await accountApi('/favorites/remove', 'POST', { kind: item.kind, slug: item.slug })
  favorites.value = favorites.value.filter(entry => entry !== item)
})
const clearHistory = () => run(async () => {
  if (!confirm('清空全部浏览记录？')) return
  await accountApi('/history/clear', 'POST'); history.value = []
})
const saveName = () => run(async () => {
  account.value = await accountApi<AccountUser>('/profile', 'PUT', { name: editName.value })
  message.value = '昵称已更新。'
})
async function uploadAvatar(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]
  input.value = ''
  if (!file) return
  await run(async () => {
    if (file.size > 2 * 1024 * 1024) throw new Error('头像不能超过 2 MiB')
    account.value = await accountApi<AccountUser>('/avatar', 'POST', undefined, file)
    message.value = '头像已更新。'
  })
}
const changePassword = () => run(async () => {
  await accountApi('/password', 'POST', { current: currentPassword.value, password: newPassword.value })
  currentPassword.value = ''; newPassword.value = ''
  message.value = '密码已修改，其他设备上的登录已退出。'
})
const deleteAccount = () => run(async () => {
  if (!confirm('删除后账户、收藏与浏览记录都无法恢复，确定删除吗？')) return
  await accountApi('/delete', 'POST', { password: deletePassword.value })
  account.value = null; deletePassword.value = ''
  message.value = '账户已删除。'
})
const logout = () => run(async () => { await signOut(); favorites.value = []; history.value = [] })

const perks = [
  { title: '收藏', text: '在任意笔记或文章页点一下星标，稍后在这里集中查看。', icon: 'm12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9l-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z' },
  { title: '浏览记录', text: '读过的内容自动记下，随时继续，也可以一键清空。', icon: 'M12 7v5l3 2M21 12a9 9 0 1 1-9-9 9 9 0 0 1 9 9Z' },
  { title: '个人资料', text: '自定义昵称与头像；只保存必要信息，可随时删除账户。', icon: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0' },
]
const kindLabel = (kind: string) => (kind === 'note' ? 'Note' : 'Article')
const date = (value: string) => value?.slice(0, 10) ?? ''
watch(account, value => { editName.value = value?.name ?? '' }, { immediate: true })

onMounted(async () => {
  document.title = 'Account · Copy Lee'
  config.value = await fetchJson<{ registrationOpen: boolean; allowedDomains: string[] }>('/api/account/config').catch(() => undefined)
  if (new URLSearchParams(location.search).get('mode') === 'register') mode.value = 'register'
  await loadAccount()
  if (account.value) await loadLists().catch(() => {})
})
onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
  <section class="account-page">
    <PageHeading :title="account ? 'Hello' : 'Account'" label="Your space">
      {{ account ? `欢迎回来，${account.name}。` : '收藏喜欢的笔记与文章，随时找回读过的内容。' }}
      <span>{{ account ? '收藏与浏览记录只对你自己可见。' : '使用常见邮箱注册，验证码会发送到你的邮箱。' }}</span>
    </PageHeading>
    <div class="container">
      <p v-if="error" class="feedback error" role="alert">{{ error }}</p>
      <p v-if="message" class="feedback ok" role="status">{{ message }}</p>
      <p v-if="!accountChecked" class="loading">正在读取账户…</p>

      <!-- 未登录：登录 / 注册 / 找回密码 -->
      <div v-else-if="!account" class="auth-layout">
      <div v-reveal class="auth-card">
        <div class="switch" role="tablist">
          <button v-for="[value, label] in [['login', '登录'], ['register', '注册'], ['reset', '找回密码']]" :key="value" role="tab" :aria-selected="mode === value" :class="{ active: mode === value }" type="button" @click="switchMode(value as Mode)">{{ label }}</button>
        </div>
        <p v-if="mode === 'register' && config && !config.registrationOpen" class="closed">暂未开放注册，敬请期待。</p>
        <form v-else class="auth-form" @submit.prevent="submit">
          <fieldset :disabled="busy">
            <label>邮箱<input v-model="email" type="email" autocomplete="email" required maxlength="254" placeholder="you@qq.com"></label>
            <p v-if="mode === 'register' && domainHint" class="hint">支持 {{ domainHint }} 等常见邮箱</p>
            <div v-if="mode !== 'login'" class="code-row">
              <label>邮箱验证码<input v-model="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required placeholder="6 位数字"></label>
              <button type="button" class="ghost" :disabled="!email || cooldown > 0" @click="sendCode">{{ cooldown > 0 ? `${cooldown} 秒后重发` : '发送验证码' }}</button>
            </div>
            <label v-if="mode === 'register'">昵称<span class="optional">可选</span><input v-model="name" maxlength="40" autocomplete="nickname"></label>
            <label>{{ mode === 'reset' ? '新密码' : '密码' }}<input v-model="password" type="password" :autocomplete="mode === 'login' ? 'current-password' : 'new-password'" :minlength="mode === 'login' ? 1 : 8" maxlength="128" required></label>
            <label v-if="mode === 'register'" class="agree"><input v-model="agree" type="checkbox">我已了解：本站只保存邮箱、昵称、头像、收藏与浏览记录，用于账户功能；可随时在账户设置中删除。</label>
            <button class="primary" type="submit">{{ busy ? '请稍候…' : mode === 'login' ? '登录' : mode === 'register' ? '注册并登录' : '重置密码' }}</button>
          </fieldset>
        </form>
      </div>
      <ul class="perks" aria-label="账户功能">
        <li v-for="(perk, i) in perks" :key="perk.title" v-reveal="120 + i * 90"><span class="perk-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path :d="perk.icon" /></svg></span><div><strong>{{ perk.title }}</strong><p>{{ perk.text }}</p></div></li>
      </ul>
      </div>

      <!-- 已登录 -->
      <div v-else class="dashboard">
        <aside v-reveal class="profile">
          <label class="avatar" :title="'更换头像（不超过 2 MiB）'">
            <img v-if="account.avatar" :src="account.avatar" alt="头像">
            <span v-else aria-hidden="true">{{ account.name.slice(0, 1).toUpperCase() }}</span>
            <i aria-hidden="true">更换</i>
            <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" @change="uploadAvatar">
          </label>
          <form class="name-form" @submit.prevent="saveName"><input v-model="editName" maxlength="40" aria-label="昵称"><button v-if="editName && editName !== account.name" class="ghost" type="submit">保存</button></form>
          <p class="email">{{ account.email }}</p>
          <p class="joined">加入于 {{ date(account.created_at) }}</p>
          <div class="stats"><div><strong>{{ favorites.length }}</strong><span>收藏</span></div><div><strong>{{ history.length }}</strong><span>浏览</span></div></div>
          <ul class="game-bests" aria-label="游戏最佳成绩">
            <li v-for="g in games" :key="g.id"><a :href="`/games/${g.id}`">{{ g.name }}</a><span>{{ gameBests[g.id] ? `${gameBests[g.id]!.best} ${g.unit} · ${gameBests[g.id]!.plays} 局` : '未玩过' }}</span></li>
          </ul>
          <button class="ghost wide" type="button" @click="logout">退出登录</button>
        </aside>
        <div v-reveal="120" class="panel">
          <div class="tabs" role="tablist">
            <button v-for="[value, label] in [['favorites', '收藏'], ['history', '浏览记录'], ['settings', '账户设置']]" :key="value" role="tab" :aria-selected="tab === value" :class="{ active: tab === value }" type="button" @click="tab = value as typeof tab">{{ label }}</button>
          </div>
          <template v-if="tab !== 'settings'">
            <div v-if="tab === 'history' && history.length" class="panel-actions"><button class="ghost" type="button" @click="clearHistory">清空记录</button></div>
            <ul class="entries">
              <li v-for="item in (tab === 'favorites' ? favorites : history)" :key="item.kind + item.slug" :class="{ gone: !item.available }">
                <span class="kind">{{ kindLabel(item.kind) }}</span>
                <a v-if="item.available" :href="item.url">{{ item.title }}<span aria-hidden="true">↗</span></a>
                <span v-else class="title">{{ item.title }}<small>已撤下</small></span>
                <time>{{ date(item.at) }}</time>
                <button v-if="tab === 'favorites'" class="remove" type="button" :aria-label="`取消收藏 ${item.title}`" @click="removeFavorite(item)">×</button>
              </li>
            </ul>
            <p v-if="!(tab === 'favorites' ? favorites : history).length" class="empty">
              {{ tab === 'favorites' ? '还没有收藏。在笔记或文章页点击“收藏”即可保存到这里。' : '还没有浏览记录。登录后阅读的笔记与文章会自动记录在这里。' }}
              <a href="/notes">去看看笔记 ↗</a>
            </p>
          </template>
          <div v-else class="settings">
            <form @submit.prevent="changePassword"><h3>修改密码</h3>
              <fieldset :disabled="busy"><label>当前密码<input v-model="currentPassword" type="password" autocomplete="current-password" required></label>
                <label>新密码<input v-model="newPassword" type="password" autocomplete="new-password" minlength="8" maxlength="128" required></label>
                <button class="primary" type="submit">修改密码</button></fieldset>
            </form>
            <form class="danger-zone" @submit.prevent="deleteAccount"><h3>删除账户</h3><p>账户、头像、收藏与浏览记录将被永久删除。</p>
              <fieldset :disabled="busy"><label>输入密码确认<input v-model="deletePassword" type="password" autocomplete="current-password" required></label>
                <button class="danger" type="submit">永久删除账户</button></fieldset>
            </form>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.account-page { min-height:80vh; padding-bottom:72px; }
fieldset { border:0; margin:0; padding:0; min-width:0; }
.feedback { padding:12px 16px; margin:0 0 20px; border-radius:var(--radius-sm); font-size:14px; }
.feedback.error { color:#d15c5c; background:rgba(209,92,92,.08); }
.feedback.ok { color:var(--accent); background:var(--accent-soft); }
.loading { color:var(--muted); }
label { display:flex; flex-direction:column; gap:8px; margin-top:18px; font-size:13px; color:var(--text-2); }
input:not([type=checkbox]):not([type=file]) { width:100%; min-height:46px; padding:11px 14px; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--surface); color:var(--text); font:15px var(--font); transition:border-color .3s,box-shadow .3s; }
input:focus { outline:0; border-color:var(--accent); box-shadow:0 0 0 4px var(--accent-soft); }
button { font:inherit; cursor:pointer; }
button:disabled { opacity:.5; cursor:default; }
.primary { width:100%; margin-top:26px; padding:13px; border:0; border-radius:10px; background:var(--btn-bg); color:var(--btn-fg); font-weight:500; box-shadow:0 8px 22px -12px rgba(17,24,39,.45); transition:transform .3s var(--ease),box-shadow .3s; }
.primary:hover:not(:disabled) { transform:translateY(-2px); box-shadow:0 14px 26px -14px rgba(17,24,39,.5); }
.ghost { padding:10px 16px; border:1px solid var(--line-strong); border-radius:10px; background:var(--surface); color:var(--text); font-size:13px; white-space:nowrap; transition:border-color .25s,color .25s; }
.ghost:hover:not(:disabled) { border-color:var(--accent); color:var(--accent); }
.wide { width:100%; margin-top:20px; }
.danger { margin-top:20px; padding:11px 18px; border:1px solid rgba(209,92,92,.5); border-radius:10px; background:none; color:#d15c5c; }
.hint,.optional { color:var(--faint); font-size:12px; }
.hint { margin:8px 0 0; }
.optional { margin-left:6px; }
.auth-layout { display:grid; grid-template-columns:minmax(0,460px) minmax(0,1fr); gap:clamp(32px,6vw,80px); align-items:start; }
.perks { list-style:none; margin:24px 0 0; padding:0; display:grid; gap:28px; }
.perks li { display:flex; gap:16px; }
.perk-icon { flex:none; display:grid; place-items:center; width:44px; height:44px; border:1px solid var(--line); border-radius:12px; background:var(--surface); color:var(--accent); box-shadow:0 0 0 5px var(--accent-soft); }
.perk-icon svg { width:20px; height:20px; fill:none; stroke:currentColor; stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round; }
.perks strong { font-size:16px; }
.perks p { margin-top:4px; color:var(--muted); font-size:14px; line-height:1.7; }
.auth-card { max-width:460px; padding:32px; border:1px solid var(--line); border-radius:var(--radius); background:var(--surface); box-shadow:0 30px 60px -40px rgba(17,24,39,.35); }
.switch,.tabs { display:flex; gap:4px; padding:4px; border-radius:12px; background:var(--bg-tint); }
.switch button,.tabs button { flex:1; padding:9px 12px; border:0; border-radius:9px; background:none; color:var(--muted); font-size:14px; transition:background .25s,color .25s,box-shadow .25s; }
.switch button.active,.tabs button.active { background:var(--surface); color:var(--text); box-shadow:0 2px 8px -4px rgba(17,24,39,.25); }
.closed { margin:28px 0 8px; color:var(--muted); }
.code-row { display:flex; align-items:flex-end; gap:10px; }
.code-row label { flex:1; }
.code-row .ghost { min-height:46px; }
.agree { flex-direction:row; align-items:flex-start; gap:10px; color:var(--muted); font-size:12px; line-height:1.7; }
.agree input { margin-top:3px; accent-color:var(--accent); }
.dashboard { display:grid; grid-template-columns:280px 1fr; gap:32px; align-items:start; }
.profile { position:sticky; top:calc(var(--header-h) + 24px); padding:28px; border:1px solid var(--line); border-radius:var(--radius); background:var(--surface); text-align:center; }
.avatar { position:relative; display:grid; place-items:center; width:104px; height:104px; margin:0 auto; border-radius:50%; overflow:hidden; cursor:pointer; background:linear-gradient(135deg,var(--accent),#7ea2ff); color:#fff; font-size:40px; font-weight:700; box-shadow:0 0 0 6px var(--accent-soft); }
.avatar img { width:100%; height:100%; object-fit:cover; }
.avatar i { position:absolute; inset:auto 0 0; padding:6px 0; background:rgba(0,0,0,.45); color:#fff; font:500 12px var(--font); font-style:normal; transform:translateY(100%); transition:transform .3s var(--ease); }
.avatar:hover i { transform:none; }
.avatar input { position:absolute; inset:0; opacity:0; cursor:pointer; }
.name-form { display:flex; gap:8px; margin-top:18px; }
.name-form input { min-height:40px !important; text-align:center; font-weight:600 !important; font-size:17px !important; border-color:transparent !important; background:none !important; }
.name-form input:hover { border-color:var(--line) !important; }
.email { color:var(--muted); font-size:13px; overflow-wrap:anywhere; }
.joined { margin-top:4px; color:var(--faint); font:12px var(--font-mono); }
.stats { display:grid; grid-template-columns:1fr 1fr; margin-top:20px; border-top:1px solid var(--line); border-bottom:1px solid var(--line); }
.stats div { padding:14px 0; }
.stats div+div { border-left:1px solid var(--line); }
.stats strong { display:block; font-size:22px; }
.stats span { color:var(--muted); font-size:12px; }
.game-bests { list-style:none; margin:16px 0 0; padding:0; text-align:left; font-size:13px; }
.game-bests li { display:flex; justify-content:space-between; gap:8px; padding:6px 0; }
.game-bests a { color:var(--text-2); }
.game-bests a:hover { color:var(--accent); }
.game-bests span { color:var(--muted); font-family:var(--font-mono); font-size:12px; }
.panel { min-width:0; }
.tabs { max-width:420px; }
.panel-actions { display:flex; justify-content:flex-end; margin-top:16px; }
.entries { list-style:none; margin:16px 0 0; padding:0; border-top:1px solid var(--line); }
.entries li { display:grid; grid-template-columns:72px 1fr auto auto; align-items:center; gap:16px; padding:16px 4px; border-bottom:1px solid var(--line); }
.kind { color:var(--accent); font:12px var(--font-mono); }
.entries a,.entries .title { min-width:0; overflow-wrap:anywhere; font-size:15px; }
.entries a span { margin-left:6px; color:var(--faint); transition:color .3s; }
.entries a:hover { color:var(--accent); }
.entries a:hover span { color:var(--accent); }
.entries .gone .title { color:var(--muted); }
.entries small { margin-left:8px; color:var(--faint); font-size:12px; }
.entries time { color:var(--faint); font:12px var(--font-mono); }
.remove { width:32px; height:32px; border:0; border-radius:8px; background:none; color:var(--faint); font-size:20px; transition:background .2s,color .2s; }
.remove:hover { background:rgba(209,92,92,.1); color:#d15c5c; }
.empty { padding:40px 0; color:var(--muted); }
.empty a { margin-left:8px; color:var(--accent); }
.settings { display:grid; gap:24px; margin-top:24px; max-width:460px; }
.settings form { padding:24px; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--surface); }
.settings h3 { font-size:16px; }
.settings p { margin-top:6px; color:var(--muted); font-size:13px; }
.settings .primary { width:auto; padding:11px 22px; }
.danger-zone { border-color:rgba(209,92,92,.25) !important; }
@media (max-width: 860px) { .dashboard,.auth-layout { grid-template-columns:1fr; } .perks { margin-top:8px; } .profile { position:static; } }
@media (max-width: 520px) { .auth-card { padding:24px 20px; } .entries li { grid-template-columns:1fr auto; gap:6px 12px; } .entries time { grid-column:1; } .kind { grid-column:1 / -1; } }
</style>

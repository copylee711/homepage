<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { driveApi, formatTime } from '../../drive'
import type { DriveAccount, DriveCredential } from '../../drive'

const props = defineProps<{ account: DriveAccount }>()
const emit = defineEmits<{ changed: [] }>()
const login = ref(props.account.login)
const keyName = ref(''), keyText = ref(''), appName = ref('Zotero')
const freshPassword = ref<{ name: string; password: string }>()
const busy = ref(false), error = ref(''), notice = ref('')
const guide = ref<'rclone' | 'windows' | 'zotero' | 'android'>('zotero')
watch(() => props.account.login, value => { login.value = value })

const keys = computed(() => props.account.credentials.filter(item => item.kind === 'ssh_key'))
const appPasswords = computed(() => props.account.credentials.filter(item => item.kind === 'app_password'))
const user = computed(() => props.account.login || props.account.email)
const time = (seconds: number | null) => seconds ? formatTime(seconds) : '尚未使用'

async function work(task: () => Promise<void>, success: string) {
  if (busy.value) return
  busy.value = true; error.value = ''; notice.value = ''
  try { await task(); notice.value = success; emit('changed') }
  catch (err) { error.value = err instanceof Error ? err.message : '操作失败' }
  finally { busy.value = false }
}
const saveLogin = () => work(async () => { await driveApi('/login', 'PUT', { login: login.value }) }, '登录名已保存。')
const addKey = () => work(async () => {
  await driveApi('/keys', 'POST', { name: keyName.value, key: keyText.value })
  keyName.value = ''; keyText.value = ''
}, 'SSH 公钥已添加。')
const addAppPassword = () => work(async () => {
  const result = await driveApi<DriveCredential & { password: string }>('/app-passwords', 'POST', { name: appName.value })
  freshPassword.value = { name: result.name, password: result.password }
}, '应用密码已生成，请立即复制，它只会显示这一次。')
const remove = (item: DriveCredential) => {
  if (!confirm(`删除「${item.name}」？使用它的客户端将无法再登录。`)) return
  return work(async () => { await driveApi(`/credentials/${item.id}/remove`, 'POST') }, '已删除。')
}
const removeLegacy = () => {
  if (!confirm('停用旧云盘迁移过来的密码？仍在使用旧密码的客户端需要改用应用密码。')) return
  return work(async () => { await driveApi('/legacy-password/remove', 'POST') }, '旧密码已停用。')
}
async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); notice.value = '已复制到剪贴板。' } catch { error.value = '复制失败，请手动复制' }
}
</script>

<template>
  <section class="settings">
    <header><h2>连接与凭据</h2><p class="d-muted">SFTP 与 WebDAV 使用 SSH 公钥或应用密码登录，不使用网站密码；凭据可以随时删除。</p></header>
    <p v-if="error" class="d-note error" role="alert">{{ error }}</p>
    <p v-if="notice" class="d-note ok" role="status">{{ notice }}</p>

    <div class="cards">
      <article class="card">
        <h3>连接信息</h3>
        <dl>
          <dt>SFTP</dt><dd><span class="d-code">{{ account.sftp_host }}</span> 端口 <span class="d-code">{{ account.sftp_port }}</span></dd>
          <dt>WebDAV</dt><dd><span class="d-code">{{ account.dav_url }}</span></dd>
          <dt>用户名</dt><dd><span class="d-code">{{ user }}</span><span v-if="account.login" class="d-muted">（也可以用邮箱 {{ account.email }}）</span></dd>
        </dl>
        <form class="inline" @submit.prevent="saveLogin">
          <label class="d-field">登录名<span class="hint">2–32 位字母、数字、点、下划线或连字符</span><input v-model="login" class="d-input" maxlength="32" placeholder="例如 copy"></label>
          <button class="d-btn" type="submit" :disabled="busy || !login || login === account.login">保存</button>
        </form>
        <div v-if="account.legacy_password" class="legacy">
          <p>旧云盘的登录密码仍然有效，已迁移的客户端可以继续使用。建议改用应用密码后停用它。</p>
          <button class="d-btn danger" type="button" :disabled="busy" @click="removeLegacy">停用旧密码</button>
        </div>
      </article>

      <article class="card">
        <h3>应用密码</h3>
        <p class="d-muted">每个客户端单独生成一个，例如 Zotero、rclone、手机文件管理器。</p>
        <div v-if="freshPassword" class="fresh">
          <p>「{{ freshPassword.name }}」的应用密码（只显示这一次）：</p>
          <div class="fresh-row"><span class="d-code big">{{ freshPassword.password }}</span><button class="d-btn" type="button" @click="copy(freshPassword.password)">复制</button><button class="d-btn quiet" type="button" @click="freshPassword = undefined">我已保存</button></div>
        </div>
        <form class="inline" @submit.prevent="addAppPassword">
          <label class="d-field">用途<input v-model="appName" class="d-input" maxlength="80" placeholder="例如 Zotero"></label>
          <button class="d-btn primary" type="submit" :disabled="busy">生成</button>
        </form>
        <ul class="creds">
          <li v-for="item in appPasswords" :key="item.id"><div><strong>{{ item.name }}</strong><small>创建于 {{ time(item.created_at) }} · 最近使用 {{ time(item.last_used) }}</small></div><button class="d-btn danger" type="button" @click="remove(item)">删除</button></li>
        </ul>
      </article>

      <article class="card">
        <h3>SSH 公钥</h3>
        <p class="d-muted">用于 SFTP 免密登录。粘贴 <span class="d-code">~/.ssh/id_ed25519.pub</span> 的内容。</p>
        <form @submit.prevent="addKey">
          <label class="d-field">名称<input v-model="keyName" class="d-input" maxlength="80" placeholder="留空则使用公钥备注"></label>
          <label class="d-field">公钥<textarea v-model="keyText" class="d-input" rows="3" required placeholder="ssh-ed25519 AAAA… user@host"></textarea></label>
          <div class="d-actions"><button class="d-btn primary" type="submit" :disabled="busy || !keyText">添加公钥</button></div>
        </form>
        <ul class="creds">
          <li v-for="item in keys" :key="item.id"><div><strong>{{ item.name }}</strong><small>{{ item.fingerprint }} · 最近使用 {{ time(item.last_used) }}</small></div><button class="d-btn danger" type="button" @click="remove(item)">删除</button></li>
        </ul>
      </article>
    </div>

    <article class="card guide">
      <h3>客户端配置</h3>
      <div class="tabs" role="tablist"><button v-for="[value, label] in [['zotero', 'Zotero'], ['rclone', 'rclone'], ['windows', 'Windows 挂载'], ['android', '手机']]" :key="value" type="button" role="tab" :aria-selected="guide === value" :class="{ active: guide === value }" @click="guide = value as typeof guide">{{ label }}</button></div>
      <div v-if="guide === 'zotero'" class="steps">
        <p>Zotero → 设置 → 同步 → 文件同步，选择 WebDAV：</p>
        <ol><li>URL 填 <span class="d-code">{{ account.dav_url.replace(/^https?:\/\//, '') }}</span>，协议选 https。Zotero 会自动在后面加 <span class="d-code">/zotero/</span>。</li><li>用户名 <span class="d-code">{{ user }}</span>，密码填一个为 Zotero 生成的应用密码。</li><li>点击“验证服务器”。首次使用时 Zotero 会询问是否创建 zotero 目录，选择创建。</li></ol>
      </div>
      <div v-else-if="guide === 'rclone'" class="steps">
        <p>SFTP（推荐，使用公钥）：</p>
        <pre>rclone config create copylee sftp host {{ account.sftp_host }} port {{ account.sftp_port }} user {{ user }} key_file ~/.ssh/id_ed25519
rclone ls copylee:</pre>
        <p>WebDAV（使用应用密码）：</p>
        <pre>rclone config create copylee-dav webdav url {{ account.dav_url }} vendor other user {{ user }} pass "$(rclone obscure 应用密码)"</pre>
      </div>
      <div v-else-if="guide === 'windows'" class="steps">
        <ol><li>安装 <a href="https://winfsp.dev/rel/" target="_blank" rel="noopener">WinFsp</a> 与 <a href="https://github.com/winfsp/sshfs-win/releases" target="_blank" rel="noopener">SSHFS-Win</a>。</li><li>资源管理器 → 此电脑 → 映射网络驱动器，文件夹填 <span class="d-code">\\sshfs.k\{{ user }}@{{ account.sftp_host }}!{{ account.sftp_port }}</span>（使用 <span class="d-code">~/.ssh/id_rsa</span> 等密钥）或 <span class="d-code">\\sshfs\{{ user }}@{{ account.sftp_host }}!{{ account.sftp_port }}</span>（输入应用密码）。</li><li>也可以用 rclone mount 挂载 WebDAV：<span class="d-code">rclone mount copylee-dav: X: --vfs-cache-mode writes</span>。</li></ol>
      </div>
      <div v-else class="steps">
        <ol><li>MT 管理器、Solid Explorer、ES 等文件管理器：新建 SFTP 连接，主机 <span class="d-code">{{ account.sftp_host }}</span>，端口 <span class="d-code">{{ account.sftp_port }}</span>，用户名 <span class="d-code">{{ user }}</span>，密码为应用密码。</li><li>iOS“文件”App 不支持 SFTP，可用支持 WebDAV 的 App（如 Documents）连接 <span class="d-code">{{ account.dav_url }}</span>。</li></ol>
      </div>
    </article>
  </section>
</template>

<style scoped>
header h2 { font-size:20px; }
header p { margin-top:4px; }
.cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:16px; margin-top:18px; }
.card { padding:22px 24px; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--surface); }
.card h3 { font-size:16px; }
.card > .d-muted { margin-top:6px; }
dl { display:grid; grid-template-columns:auto 1fr; gap:10px 14px; margin:16px 0 0; font-size:13px; }
dt { color:var(--muted); }
dd { margin:0; min-width:0; overflow-wrap:anywhere; }
.inline { display:flex; align-items:flex-end; gap:10px; }
.inline .d-field { flex:1; }
.legacy { margin-top:18px; padding:14px; border-radius:10px; background:rgba(214,158,46,.1); font-size:13px; line-height:1.6; color:var(--text-2); }
.legacy .d-btn { margin-top:10px; }
.fresh { margin-top:14px; padding:14px; border:1px dashed var(--accent); border-radius:10px; background:var(--accent-soft); font-size:13px; }
.fresh-row { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-top:8px; }
.big { padding:6px 10px; font-size:15px; letter-spacing:.04em; }
.creds { list-style:none; margin:16px 0 0; padding:0; }
.creds li { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 0; border-top:1px solid var(--line); }
.creds div { display:flex; flex-direction:column; min-width:0; }
.creds strong { font-weight:500; font-size:14px; }
.creds small { color:var(--faint); font:11px var(--font-mono); overflow-wrap:anywhere; }
.guide { margin-top:16px; }
.tabs { display:inline-flex; flex-wrap:wrap; gap:4px; margin-top:14px; padding:4px; border-radius:10px; background:var(--bg-tint); }
.tabs button { padding:7px 14px; border:0; border-radius:8px; background:none; color:var(--muted); font:13px var(--font); cursor:pointer; }
.tabs button.active { background:var(--surface); color:var(--text); box-shadow:0 2px 8px -4px rgba(17,24,39,.25); }
.steps { margin-top:14px; font-size:14px; line-height:1.8; color:var(--text-2); }
.steps ol { margin:8px 0 0; padding-left:20px; }
.steps a { color:var(--accent); }
.steps pre { margin:8px 0 14px; padding:12px 14px; overflow:auto; border:1px solid var(--line); border-radius:10px; background:var(--bg); font:12px/1.7 var(--font-mono); }
</style>

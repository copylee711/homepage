<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { accountApi } from '../account'
import { passkeyAvailable, usePasskey } from '../passkeys'

type SecurityState = { totp_enabled: boolean; recovery_remaining: number; passkeys: { id: string; name: string; created_at: number; last_used: number | null }[] }
const OTP_REQUIRED = '请输入两步验证码或恢复码'
const security = ref<SecurityState>()
const password = ref(''), otp = ref(''), keyName = ref('我的设备'), needOtp = ref(false)
const enrollment = ref<{ secret: string; qr: string }>(), recoveryCodes = ref<string[]>([])
const busy = ref(false), error = ref(''), message = ref('')
const canPasskey = computed(() => passkeyAvailable())
// 开启两步验证后，除绑定步骤外的修改都需要验证码。
const askOtp = computed(() => needOtp.value || !!enrollment.value || !!security.value?.totp_enabled)

async function load() { security.value = await accountApi<SecurityState>('/security') }
async function run(work: () => Promise<void>) {
  if (busy.value) return
  busy.value = true; error.value = ''; message.value = ''
  try { await work() } catch (err) {
    const text = err instanceof Error ? err.message : '操作失败'
    if (text === OTP_REQUIRED) { needOtp.value = true; error.value = '请填写两步验证码或恢复码后重试' }
    else error.value = text
  } finally { busy.value = false }
}
function requirePassword() { if (!password.value) throw new Error('请先输入当前密码确认身份') }
function proof() { return { password: password.value, otp: otp.value } }
function done(text: string) { otp.value = ''; message.value = text }

const factor = (operation: 'setup' | 'enable' | 'disable' | 'recovery') => run(async () => {
  requirePassword()
  if (operation === 'disable' && !confirm('关闭后登录只需要密码，确定关闭两步验证吗？')) return
  const result = await accountApi<{ secret?: string; qr?: string; recovery_codes?: string[] }>(`/security/2fa/${operation}`, 'POST', proof())
  if (operation === 'setup') { enrollment.value = { secret: result.secret!, qr: result.qr! }; done('请用验证器 App 扫描二维码，然后输入 6 位验证码确认。'); return }
  enrollment.value = undefined; recoveryCodes.value = result.recovery_codes ?? []
  await load()
  done(operation === 'enable' ? '两步验证已开启，其他设备上的登录已退出。' : operation === 'disable' ? '两步验证已关闭。' : '恢复码已重新生成，旧恢复码失效。')
})
const addPasskey = () => run(async () => {
  requirePassword()
  const options = await accountApi<{ options: Record<string, any>; challenge_id: string }>('/security/passkeys/options', 'POST', { ...proof(), name: keyName.value })
  const credential = await usePasskey(options.options, true)
  security.value = await accountApi<SecurityState>('/security/passkeys/verify', 'POST', { challenge_id: options.challenge_id, credential, name: keyName.value })
  done('Passkey 已绑定，下次可以直接用设备验证登录。')
})
const removePasskey = (id: string, name: string) => run(async () => {
  requirePassword()
  if (!confirm(`撤销「${name}」后它将不能再登录，确定吗？`)) return
  security.value = await accountApi<SecurityState>(`/security/passkeys/${encodeURIComponent(id)}/remove`, 'POST', proof())
  done('Passkey 已撤销，其他设备上的登录已退出。')
})
const when = (seconds: number) => new Date(seconds * 1000).toLocaleDateString()

onMounted(() => { void load().catch(() => {}) })
</script>

<template>
  <section class="security">
    <h3>登录安全</h3>
    <p>两步验证与 Passkey 都是可选的，但推荐至少开启一项。修改前需要输入当前密码{{ askOtp ? '和两步验证码' : '' }}。</p>
    <p v-if="error" class="note error" role="alert">{{ error }}</p>
    <p v-if="message" class="note ok" role="status">{{ message }}</p>
    <fieldset :disabled="busy">
      <div class="confirm">
        <label>当前密码<input v-model="password" type="password" autocomplete="current-password" maxlength="128"></label>
        <label v-if="askOtp">{{ enrollment ? '验证器中的 6 位验证码' : '两步验证码或恢复码' }}<input v-model="otp" autocomplete="one-time-code" maxlength="80" inputmode="numeric"></label>
      </div>

      <div class="block">
        <div class="row"><strong>两步验证（TOTP）</strong><span class="badge" :class="{ on: security?.totp_enabled }">{{ security?.totp_enabled ? '已开启' : '未开启' }}</span></div>
        <p>登录时除密码外，还需输入验证器 App（如 Google Authenticator、Microsoft Authenticator）生成的 6 位验证码。用邮箱找回密码时同样需要。</p>
        <template v-if="enrollment">
          <img class="qr" :src="enrollment.qr" alt="验证器绑定二维码">
          <p>无法扫码时手动输入密钥：<code>{{ enrollment.secret }}</code>（10 分钟内有效）</p>
          <div class="buttons"><button class="primary" type="button" @click="factor('enable')">确认开启</button><button type="button" @click="enrollment = undefined">取消</button></div>
        </template>
        <button v-else-if="!security?.totp_enabled" type="button" @click="factor('setup')">开始绑定验证器</button>
        <div v-else class="buttons"><button type="button" @click="factor('recovery')">重新生成恢复码</button><button class="danger" type="button" @click="factor('disable')">关闭两步验证</button><span class="hint">剩余恢复码 {{ security.recovery_remaining }} 个</span></div>
        <div v-if="recoveryCodes.length" class="codes">
          <p>请把这些恢复码保存到安全的地方。它们只显示这一次，每个只能用一次；手机丢失时可以用来登录。</p>
          <pre>{{ recoveryCodes.join('\n') }}</pre>
          <button type="button" @click="recoveryCodes = []">我已保存</button>
        </div>
      </div>

      <div class="block">
        <div class="row"><strong>Passkey</strong><span class="badge" :class="{ on: security?.passkeys.length }">{{ security?.passkeys.length ?? 0 }} 个</span></div>
        <p>用指纹、面容、设备 PIN 或安全密钥登录，无需输入邮箱和密码。最多绑定 10 个。</p>
        <div class="add"><input v-model="keyName" maxlength="80" aria-label="设备名称" placeholder="设备名称，例如：我的手机"><button type="button" :disabled="!canPasskey" @click="addPasskey">绑定 Passkey</button></div>
        <p v-if="!canPasskey" class="hint">当前浏览器或地址不支持 Passkey（需要 HTTPS）。</p>
        <ul class="keys">
          <li v-for="key in security?.passkeys" :key="key.id"><div><strong>{{ key.name }}</strong><span>绑定于 {{ when(key.created_at) }} · {{ key.last_used ? `最近使用 ${when(key.last_used)}` : '尚未用于登录' }}</span></div><button class="danger" type="button" @click="removePasskey(key.id, key.name)">撤销</button></li>
        </ul>
      </div>
    </fieldset>
  </section>
</template>

<style scoped>
.security { padding:24px; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--surface); }
h3 { font-size:16px; }
p { margin-top:6px; color:var(--muted); font-size:13px; line-height:1.7; }
fieldset { border:0; margin:0; padding:0; min-width:0; }
.note { padding:10px 14px; border-radius:var(--radius-sm); }
.note.error { color:#d15c5c; background:rgba(209,92,92,.08); }
.note.ok { color:var(--accent); background:var(--accent-soft); }
.confirm { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; }
label { display:flex; flex-direction:column; gap:8px; margin-top:16px; font-size:13px; color:var(--text-2); }
input { width:100%; min-height:42px; padding:9px 12px; border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--surface); color:var(--text); font:14px var(--font); }
input:focus { outline:0; border-color:var(--accent); box-shadow:0 0 0 4px var(--accent-soft); }
.block { margin-top:22px; padding-top:18px; border-top:1px solid var(--line); }
.row { display:flex; align-items:center; gap:10px; }
.badge { padding:2px 8px; border-radius:99px; background:var(--bg-tint); color:var(--muted); font-size:12px; }
.badge.on { background:var(--accent-soft); color:var(--accent); }
button { margin-top:12px; padding:9px 16px; border:1px solid var(--line-strong); border-radius:10px; background:var(--surface); color:var(--text); font:inherit; font-size:13px; cursor:pointer; transition:border-color .25s,color .25s; }
button:hover:not(:disabled) { border-color:var(--accent); color:var(--accent); }
button:disabled { opacity:.5; cursor:default; }
.primary { border:0; background:var(--btn-bg); color:var(--btn-fg); }
.primary:hover:not(:disabled) { color:var(--btn-fg); }
.danger { border-color:rgba(209,92,92,.5); color:#d15c5c; }
.buttons { display:flex; flex-wrap:wrap; align-items:center; gap:10px; }
.hint { margin-top:12px; color:var(--faint); font-size:12px; }
.qr { display:block; width:180px; height:180px; margin-top:12px; border-radius:12px; background:#fff; image-rendering:pixelated; }
code { overflow-wrap:anywhere; font:12px var(--font-mono); color:var(--text); }
.codes pre { margin:10px 0 0; padding:14px; border-radius:var(--radius-sm); background:var(--bg-tint); font:13px/1.8 var(--font-mono); white-space:pre-wrap; }
.add { display:flex; gap:10px; align-items:flex-end; }
.add input { flex:1; min-width:0; }
.add button { flex:none; }
.keys { list-style:none; margin:8px 0 0; padding:0; }
.keys li { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:10px 0; border-bottom:1px solid var(--line); }
.keys span { display:block; margin-top:2px; color:var(--muted); font-size:12px; }
.keys button { margin:0; }
@media (max-width: 520px) { .security { padding:18px; } .add { flex-direction:column; align-items:stretch; } }
</style>

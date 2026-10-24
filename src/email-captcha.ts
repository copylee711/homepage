/** ESA 验签票据只用于下一次发送请求，不缓存、不写入 URL 或日志。 */
export interface EmailCaptchaConfig { enabled: boolean; prefix: string; sceneId: string }
interface CaptchaInstance { refresh(): void }
interface CaptchaOptions {
  SceneId: string; mode: string; element: string; button: string; server: string[]
  getInstance(instance: CaptchaInstance): void
  success(token: string): void
  fail(): void
  onError(): void
  onClose(): void
}
declare global {
  interface Window {
    AliyunCaptchaConfig?: { region: string; prefix: string }
    initAliyunCaptcha?: (options: CaptchaOptions) => void
  }
}

let ready: Promise<void> | undefined
let instance: CaptchaInstance | undefined
let trigger: HTMLButtonElement
let pending: { resolve(token: string): void; reject(error: Error): void } | undefined
let expires: ReturnType<typeof setTimeout> | undefined

function fail(message: string) {
  const current = pending
  pending = undefined
  clearTimeout(expires)
  current?.reject(new Error(message))
}

export function prepareEmailCaptcha(config: EmailCaptchaConfig): Promise<void> {
  if (!config.enabled) return Promise.resolve()
  if (ready) return ready
  ready = new Promise<void>((resolve, reject) => {
    // 持久挂载，SPA 离开并返回账户页时不重复初始化 SDK。
    const element = document.createElement('div')
    element.id = 'email-captcha-element'
    trigger = document.createElement('button')
    trigger.id = 'email-captcha-trigger'
    trigger.type = 'button'
    trigger.hidden = true
    document.body.append(element, trigger)
    window.AliyunCaptchaConfig = { region: 'cn', prefix: config.prefix }
    const script = document.createElement('script')
    script.src = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js'
    script.async = true
    const timeout = setTimeout(() => reject(new Error('安全验证加载超时，请刷新页面重试')), 20000)
    script.onerror = () => {
      clearTimeout(timeout)
      reject(new Error('安全验证加载失败，请检查网络并刷新页面'))
    }
    script.onload = () => {
      if (!window.initAliyunCaptcha) {
        clearTimeout(timeout)
        reject(new Error('安全验证加载失败，请刷新页面重试'))
        return
      }
      window.initAliyunCaptcha({
        SceneId: config.sceneId, mode: 'popup', element: '#email-captcha-element',
        button: '#email-captcha-trigger',
        server: ['captcha-esa-open.aliyuncs.com', 'captcha-esa-open-b.aliyuncs.com'],
        getInstance(value) {
          instance = value
          // 官方要求初始化与验证请求间隔大于 2 秒。
          setTimeout(() => { clearTimeout(timeout); resolve() }, 2100)
        },
        success(token) {
          const current = pending
          pending = undefined
          clearTimeout(expires)
          current?.resolve(token)
        },
        fail: () => fail('安全验证未通过，请重试'),
        onError() {
          clearTimeout(timeout)
          reject(new Error('安全验证暂不可用，请刷新页面重试'))
          fail('安全验证暂不可用，请刷新页面重试')
        },
        onClose: () => fail('安全验证已取消，请重试'),
      })
    }
    document.head.append(script)
  })
  return ready
}

export async function verifyEmailCaptcha(config: EmailCaptchaConfig, signal?: AbortSignal): Promise<string> {
  if (!config.enabled) return ''
  await prepareEmailCaptcha(config)
  signal?.throwIfAborted()
  if (pending) throw new Error('安全验证正在进行，请稍候')
  return new Promise<string>((resolve, reject) => {
    const abort = () => fail('安全验证已取消')
    const cleanup = () => signal?.removeEventListener('abort', abort)
    pending = { resolve(token) { cleanup(); resolve(token) }, reject(error) { cleanup(); reject(error) } }
    signal?.addEventListener('abort', abort, { once: true })
    expires = setTimeout(() => fail('安全验证超时，请重试'), 90000)
    trigger.click()
  })
}

export function cancelEmailCaptcha() { fail('安全验证已取消') }
export function refreshEmailCaptcha() { instance?.refresh() }

export async function sendEmailCode(email: string, purpose: 'register' | 'reset', token: string) {
  const response = await fetch('/api/account/code', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', ...(token ? { 'captcha-verify-param': token } : {}) },
    body: JSON.stringify({ email, purpose }),
  })
  const verdict = response.headers.get('x-captcha-verify-code')
  if (verdict && !['T001', 'T005', 'T006'].includes(verdict)) {
    throw new Error('安全验证未通过，请重新获取验证码')
  }
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : '验证码发送失败，请稍后重试')
  if (data.ok !== true || typeof data.resend_after !== 'number') throw new Error('验证码发送结果异常，请稍后重试')
  return data as { ok: true; resend_after: number }
}

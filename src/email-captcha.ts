/** ESA 验签票据只用于下一次请求，不缓存、不写入 URL 或日志。
 *
 * 不同接口可以用不同的验证场景（邮箱验证码为无痕验证，反馈为滑块验证），每个场景各自初始化一个实例。
 */
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

interface Scene {
  ready: Promise<void>
  instance?: CaptchaInstance
  trigger: HTMLButtonElement
  pending?: { resolve(token: string): void; reject(error: Error): void }
  expires?: ReturnType<typeof setTimeout>
}

let script: Promise<void> | undefined
const scenes = new Map<string, Scene>()

function loadScript(prefix: string): Promise<void> {
  if (script) return script
  script = new Promise<void>((resolve, reject) => {
    window.AliyunCaptchaConfig = { region: 'cn', prefix }
    const tag = document.createElement('script')
    tag.src = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js'
    tag.async = true
    tag.onerror = () => { script = undefined; reject(new Error('安全验证加载失败，请检查网络并刷新页面')) }
    tag.onload = () => window.initAliyunCaptcha ? resolve() : reject(new Error('安全验证加载失败，请刷新页面重试'))
    document.head.append(tag)
  })
  return script
}

function fail(scene: Scene | undefined, message: string) {
  const current = scene?.pending
  if (!scene || !current) return
  scene.pending = undefined
  clearTimeout(scene.expires)
  current.reject(new Error(message))
}

export function prepareEmailCaptcha(config: EmailCaptchaConfig): Promise<void> {
  if (!config.enabled) return Promise.resolve()
  const existing = scenes.get(config.sceneId)
  if (existing) return existing.ready
  // 持久挂载，SPA 离开并返回页面时不重复初始化 SDK。
  const key = config.sceneId.replace(/[^A-Za-z0-9_-]/g, '')
  const element = document.createElement('div')
  element.id = `captcha-element-${key}`
  const trigger = document.createElement('button')
  trigger.id = `captcha-trigger-${key}`
  trigger.type = 'button'
  trigger.hidden = true
  document.body.append(element, trigger)
  const scene: Scene = { trigger, ready: Promise.resolve() }
  scene.ready = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('安全验证加载超时，请刷新页面重试')), 20000)
    loadScript(config.prefix).then(() => {
      window.initAliyunCaptcha!({
        SceneId: config.sceneId, mode: 'popup', element: `#${element.id}`, button: `#${trigger.id}`,
        server: ['captcha-esa-open.aliyuncs.com', 'captcha-esa-open-b.aliyuncs.com'],
        getInstance(value) {
          scene.instance = value
          // 官方要求初始化与验证请求间隔大于 2 秒。
          setTimeout(() => { clearTimeout(timeout); resolve() }, 2100)
        },
        success(token) {
          const current = scene.pending
          scene.pending = undefined
          clearTimeout(scene.expires)
          current?.resolve(token)
        },
        fail: () => fail(scene, '安全验证未通过，请重试'),
        onError() {
          clearTimeout(timeout)
          reject(new Error('安全验证暂不可用，请刷新页面重试'))
          fail(scene, '安全验证暂不可用，请刷新页面重试')
        },
        onClose: () => fail(scene, '安全验证已取消，请重试'),
      })
    }, error => { clearTimeout(timeout); reject(error) })
  })
  scene.ready.catch(() => scenes.delete(config.sceneId))
  scenes.set(config.sceneId, scene)
  return scene.ready
}

export async function verifyEmailCaptcha(config: EmailCaptchaConfig, signal?: AbortSignal): Promise<string> {
  if (!config.enabled) return ''
  await prepareEmailCaptcha(config)
  signal?.throwIfAborted()
  const scene = scenes.get(config.sceneId)!
  if (scene.pending) throw new Error('安全验证正在进行，请稍候')
  return new Promise<string>((resolve, reject) => {
    const abort = () => fail(scene, '安全验证已取消')
    const cleanup = () => signal?.removeEventListener('abort', abort)
    scene.pending = { resolve(token) { cleanup(); resolve(token) }, reject(error) { cleanup(); reject(error) } }
    signal?.addEventListener('abort', abort, { once: true })
    scene.expires = setTimeout(() => fail(scene, '安全验证超时，请重试'), 90000)
    scene.trigger.click()
  })
}

export function cancelEmailCaptcha() { for (const scene of scenes.values()) fail(scene, '安全验证已取消') }
export function refreshEmailCaptcha() { for (const scene of scenes.values()) scene.instance?.refresh() }

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

/** 受 ESA 验证码保护的其他写操作（如意见反馈）：票据放入请求头，边缘判定失败时提示重试。 */
export async function postWithCaptcha<T>(path: string, body: unknown, token: string, csrf: string): Promise<T> {
  const response = await fetch(path, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...(token ? { 'captcha-verify-param': token } : {}) },
    body: JSON.stringify(body),
  })
  const verdict = response.headers.get('x-captcha-verify-code')
  if (verdict && !['T001', 'T005', 'T006'].includes(verdict)) throw new Error('安全验证未通过，请重试')
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `提交失败 (${response.status})`)
  return data as T
}

import { ref } from 'vue'
import { fetchJson } from './content'

export interface AccountUser { id: string; email: string; name: string; avatar: string; created_at: string }
export interface ImageLimits { enabled: boolean; quota: number | null; max_file: number; used: number }
export interface ImageToken { id: string; name: string; created_at: string; last_used: string | null }
export interface HostedImage { id: string; url: string; size: number; width: number; height: number; created_at: string; owner?: string }
/** 管理员授予的功能；新注册用户默认都没有，前端据此隐藏对应入口。 */
export interface AccountFeatures { drive: boolean; images: boolean; admin: boolean }
export interface FeedbackItem { id: string; category: 'suggestion' | 'bug' | 'other'; content: string; page: string; status: 'new' | 'read' | 'done'; reply: string; created_at: number; replied_at: number | null }
export interface AccountEntry { kind: 'note' | 'post'; slug: string; title: string; available: boolean; url: string; at: string }

export const account = ref<AccountUser | null>(null)
export const accountChecked = ref(false)
export const features = ref<AccountFeatures>({ drive: false, images: false, admin: false })
let csrf = ''

/** 访客账户接口；写操作自动附带 CSRF 令牌。 */
export async function accountApi<T>(path: string, method = 'GET', data?: unknown, raw?: Blob, extra: Record<string, string> = {}): Promise<T> {
  try {
    return await fetchJson<T>(`/api/account${path}`, {
      method, credentials: 'same-origin',
      headers: { 'X-CSRF-Token': csrf, ...(raw ? { 'Content-Type': raw.type || 'application/octet-stream' } : { 'Content-Type': 'application/json' }), ...extra },
      ...(raw ? { body: raw, signal: AbortSignal.timeout(60000) } : data === undefined ? {} : { body: JSON.stringify(data) }),
    })
  } catch (err) {
    if ((err as { status?: number }).status === 401) signedOut()
    throw err
  }
}

/** 写操作请求的 CSRF 令牌；网盘等其他接口共用同一个登录会话。 */
export const csrfToken = () => csrf

function signedOut() {
  account.value = null; csrf = ''
  features.value = { drive: false, images: false, admin: false }
}

export function signedIn(result: { user: AccountUser; csrf: string; features?: AccountFeatures }) {
  account.value = result.user
  csrf = result.csrf
  if (result.features) features.value = result.features
}

let loading: Promise<void> | undefined
/** 读取登录状态与功能开关；多个组件同时调用时只请求一次。 */
export function loadAccount(force = false) {
  if (loading && !force) return loading
  loading = (async () => {
    try { signedIn(await accountApi<{ user: AccountUser; csrf: string; features: AccountFeatures }>('/me')) }
    catch { signedOut() }
    finally { accountChecked.value = true }
  })()
  return loading
}

export async function signOut() {
  await accountApi('/logout', 'POST').catch(() => {})
  signedOut()
}

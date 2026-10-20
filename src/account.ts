import { ref } from 'vue'
import { fetchJson } from './content'

export interface AccountUser { id: string; email: string; name: string; avatar: string; created_at: string }
export interface AccountEntry { kind: 'note' | 'post'; slug: string; title: string; available: boolean; url: string; at: string }

export const account = ref<AccountUser | null>(null)
export const accountChecked = ref(false)
let csrf = ''

/** 访客账户接口；写操作自动附带 CSRF 令牌。 */
export async function accountApi<T>(path: string, method = 'GET', data?: unknown, raw?: Blob): Promise<T> {
  try {
    return await fetchJson<T>(`/api/account${path}`, {
      method, credentials: 'same-origin',
      headers: { 'X-CSRF-Token': csrf, ...(raw ? { 'Content-Type': raw.type || 'application/octet-stream' } : { 'Content-Type': 'application/json' }) },
      ...(raw ? { body: raw, signal: AbortSignal.timeout(60000) } : data === undefined ? {} : { body: JSON.stringify(data) }),
    })
  } catch (err) {
    if ((err as { status?: number }).status === 401) { account.value = null; csrf = '' }
    throw err
  }
}

export function signedIn(result: { user: AccountUser; csrf: string }) {
  account.value = result.user
  csrf = result.csrf
}

export async function loadAccount() {
  try { signedIn(await accountApi<{ user: AccountUser; csrf: string }>('/me')) }
  catch { account.value = null }
  finally { accountChecked.value = true }
}

export async function signOut() {
  await accountApi('/logout', 'POST').catch(() => {})
  account.value = null; csrf = ''
}

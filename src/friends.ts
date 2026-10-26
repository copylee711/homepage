import { ref } from 'vue'
import { account, csrfToken } from './account'
import { fetchJson } from './content'
import type { Person } from './docs'

export interface Friend extends Person { email: string; since: number }
export interface FriendRequestItem { id: string; user: Person & { email: string }; message: string; created_at: number }
export interface FriendsOverview { friends: Friend[]; incoming: FriendRequestItem[]; outgoing: FriendRequestItem[] }
export interface FriendInvite { token: string; url: string; created_at: number }
export interface FileCard { name: string; size: number; path?: string }
export interface DocInviteCard { doc_id: string; title: string; role: 'view' | 'edit'; can_share: boolean; status: 'pending' | 'accepted' | 'declined' | 'expired' }
export interface ChatMessage {
  id: string; sender_id: string; mine: boolean; kind: 'text' | 'file' | 'doc_invite'
  body: string; data: (FileCard & Partial<DocInviteCard>) | null
  created_at: number; updated_at: number; revoked: boolean
}
export interface Conversation { user: Person & { email: string }; since: number; last: ChatMessage | null; unread: number; at: number }

/** 好友与私信接口；与账户共用登录会话，写操作附带 CSRF 令牌。 */
export async function socialApi<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  try {
    return await fetchJson<T>(`/api${path}`, {
      method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    })
  } catch (err) {
    if ((err as { status?: number }).status === 401 && method !== 'GET') account.value = null
    throw err
  }
}

/** 好友列表，供私信页与文档分享等处选人使用。 */
export const loadFriends = () => socialApi<FriendsOverview>('/friends')

export const messageFileUrl = (id: string, inline = false) => `/api/messages/${id}/file${inline ? '?inline=1' : ''}`

// —— 导航栏红点：未读私信与待处理的好友申请 ——

export const unread = ref({ unread: 0, requests: 0 })
const POLL_MS = 60_000
let timer: ReturnType<typeof setInterval> | undefined

export async function refreshUnread() {
  if (!account.value) { unread.value = { unread: 0, requests: 0 }; return }
  try { unread.value = await socialApi<{ unread: number; requests: number }>('/messages/summary') }
  catch { /* 网络波动时保留上一次的数字 */ }
}

/** 每分钟查一次未读数；页面隐藏时暂停，回到前台立即刷新。返回停止函数。 */
export function watchUnread() {
  const onVisible = () => { if (document.visibilityState === 'visible') refreshUnread() }
  refreshUnread()
  timer = setInterval(() => { if (document.visibilityState === 'visible') refreshUnread() }, POLL_MS)
  document.addEventListener('visibilitychange', onVisible)
  return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
}

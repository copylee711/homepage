import { account, csrfToken } from './account'
import { fetchJson, site } from './content'

export interface Person { id: string; name: string; avatar: string }
export type DocRole = 'owner' | 'edit' | 'view'
export interface DocLink { role: 'none' | 'view' | 'edit'; token: string; url: string; has_password: boolean; expires_at: number }
export interface DocItem {
  id: string; title: string; size: number; created_at: number; updated_at: number
  owner: Person | null; updated_by: Person | null
  role: DocRole; can_share: boolean; can_copy: boolean; allow_copy: boolean; link?: DocLink
  /** 所属团队与团队文件树里的文件夹 */
  team: { id: string; name: string } | null; folder: string
}
export interface DocMember extends Person { email: string; role: 'view' | 'edit'; can_share: boolean; created_at: number }
export interface DocVersion { id: string; label: string; auto: boolean; size: number; created_at: number; created_by: Person | null }
export interface DocLinkInfo { id: string; title: string; role: 'view' | 'edit'; signed_in: boolean; needs_password: boolean; unlocked: boolean }

/** 文档接口与账户共用登录会话；写操作附带 CSRF 令牌。 */
export async function docsApi<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  try {
    return await fetchJson<T>(`/api/docs${path}`, {
      method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    })
  } catch (err) {
    if ((err as { status?: number }).status === 401 && method !== 'GET') account.value = null
    throw err
  }
}

// 实时编辑依赖 WebSocket，而主站经过的 ESA 免费版不支持，所以编辑页放在直连源站的云盘子域名上。
// 本地开发时没有子域名，直接用当前地址。
const local = /^(localhost|127\.|\[::1\])/.test(location.hostname)
export const editorOrigin = () => local || location.hostname.startsWith('cloud.') ? '' : (site.value?.cloud ?? '')
export const docUrl = (id: string) => `${editorOrigin()}/doc/${id}`
export const withLink = (path: string, link: string) => link ? `${path}${path.includes('?') ? '&' : '?'}link=${encodeURIComponent(link)}` : path

// 服务器关闭连接时给出的原因，见 backend/app/docs.py。
export const CLOSE_LOGIN = 4401
export const CLOSE_FORBIDDEN = 4403
export const CLOSE_GONE = 4404
export const CLOSE_RECONNECT = 4409

const COLORS = ['#3b6ef5', '#e0607e', '#2f9e6e', '#d9822b', '#a65ad9', '#1f9bb8', '#c2588f', '#6b8e23']
export function colorOf(seed: string) {
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return COLORS[hash % COLORS.length]
}

export function timeAgo(seconds: number) {
  const diff = Date.now() / 1000 - seconds
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`
  return new Date(seconds * 1000).toLocaleDateString('zh-CN')
}

export const roleName: Record<string, string> = { owner: '所有者', edit: '可编辑', view: '可查看', none: '关闭' }

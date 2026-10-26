import { account, csrfToken } from './account'
import { fetchJson, site } from './content'
import type { Person } from './docs'

export type TeamRole = 'owner' | 'edit' | 'view'
export interface Team {
  id: string; name: string; description: string; role: TeamRole; owner: Person | null
  quota: number; used: number; files: number; members: number; docs: number
  created_at: number; updated_at: number; dav_url: string
  /** 只有所有者能看到：调整额度时的上限（null 表示不限） */
  max_quota?: number | null
}
export interface TeamMember extends Person { email: string; role: TeamRole; created_at: number }
export interface TreeItem { path: string; name: string; dir: boolean; size: number; mtime: number; doc: string }
export interface AppPassword { id: string; name: string; created_at: number; last_used: number | null }
export interface TeamAccess { login: string; email: string; dav_url: string; passwords: AppPassword[] }

/** 团队接口与账户共用登录会话；写操作附带 CSRF 令牌。 */
export async function teamsApi<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  try {
    return await fetchJson<T>(`/api/teams${path}`, {
      method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    })
  } catch (err) {
    if ((err as { status?: number }).status === 401 && method !== 'GET') account.value = null
    throw err
  }
}

// 工作区在云盘子域名上：大文件上传不经过 CDN，团队文档的实时连接也能直连。本地开发时用当前地址。
const local = /^(localhost|127\.|\[::1\])/.test(location.hostname)
const cloudOrigin = () => local || location.hostname.startsWith('cloud.') ? '' : (site.value?.cloud ?? '')
export const teamUrl = (id: string, path = '/') => `${cloudOrigin()}/t/${id}${path === '/' ? '' : `?path=${encodeURIComponent(path)}`}`

export const roleLabel: Record<TeamRole, string> = { owner: '所有者', edit: '可编辑', view: '只读' }
export const MIB = 1024 * 1024

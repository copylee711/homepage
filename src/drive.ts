import { account, csrfToken, loadAccount } from './account'
import { fetchJson } from './content'

export interface DriveEntry { name: string; path: string; dir: boolean; size: number; mtime: number }
export interface DriveListing { path: string; read_only: boolean; items: DriveEntry[] }
export interface DriveMount { id: string; path: string; kind: 'local' | 'oss'; location: string; quota: number; read_only: boolean; used: number; files: number }
export interface StorageSummary { drive_enabled: boolean; images_enabled: boolean; quota: number | null; max_image: number; used: number; images_used: number; drive_used: number }
export interface DriveCredential { id: string; kind: 'ssh_key' | 'app_password'; name: string; fingerprint: string; created_at: number; last_used: number | null }
export interface DriveAccount { login: string; email: string; legacy_password: boolean; credentials: DriveCredential[]; sftp_host: string; sftp_port: number; dav_url: string }
export interface DriveOverview { enabled: boolean; storage: StorageSummary; mounts?: DriveMount[]; account?: DriveAccount }
export interface DriveShare { id: string; name: string; paths: string[]; mode: 'read' | 'upload'; has_password: boolean; expires_at: number; max_uses: number; used: number; created_at: number; last_used: number | null; url: string }

/** 网盘接口与账户共用登录会话；写操作附带同一个 CSRF 令牌。 */
export async function driveApi<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  try {
    return await fetchJson<T>(`/api/drive${path}`, {
      method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    })
  } catch (err) {
    if ((err as { status?: number }).status === 401) account.value = null
    throw err
  }
}

export const query = (params: Record<string, string | string[]>) => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) for (const item of [value].flat()) search.append(key, item)
  return search.toString()
}

export const downloadUrl = (path: string, inline = false) => `/api/drive/download?${query({ path, ...(inline ? { inline: '1' } : {}) })}`
export const zipUrl = (paths: string[]) => `/api/drive/zip?${query({ path: paths })}`

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024, unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

export const joinPath = (base: string, name: string) => (base === '/' ? '' : base) + '/' + name
export const parentPath = (path: string) => path.split('/').slice(0, -1).join('/') || '/'
export const baseName = (path: string) => path.split('/').filter(Boolean).pop() ?? ''

export interface UploadTask {
  id: string; name: string; target: string; size: number; sent: number
  state: 'waiting' | 'uploading' | 'done' | 'error' | 'cancelled'; error?: string
  file: File; session?: string; abort?: () => void
}

const RESUME_KEY = 'copylee-drive-uploads'

/** 记住未完成的上传会话：刷新页面后重新选择同一文件即可从断点继续。 */
function remember(task: UploadTask) {
  try {
    const saved = JSON.parse(localStorage.getItem(RESUME_KEY) || '{}')
    const key = `${task.target}|${task.size}|${task.file.lastModified}`
    if (task.session && task.state !== 'done') saved[key] = task.session
    else delete saved[key]
    localStorage.setItem(RESUME_KEY, JSON.stringify(saved))
  } catch { /* 隐私模式等情况下不支持续传记录 */ }
}

function recall(task: UploadTask): string | undefined {
  try { return JSON.parse(localStorage.getItem(RESUME_KEY) || '{}')[`${task.target}|${task.size}|${task.file.lastModified}`] }
  catch { return undefined }
}

function sendChunk(url: string, chunk: Blob, onProgress: (loaded: number) => void, task: UploadTask) {
  return new Promise<number>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.setRequestHeader('X-CSRF-Token', csrfToken())
    xhr.upload.onprogress = event => onProgress(event.loaded)
    xhr.onload = () => {
      const data = (() => { try { return JSON.parse(xhr.responseText) } catch { return {} } })()
      if (xhr.status >= 200 && xhr.status < 300) resolve(data.received)
      else reject(Object.assign(new Error(typeof data.detail === 'string' ? data.detail : `上传失败 (${xhr.status})`), { status: xhr.status }))
    }
    xhr.onerror = () => reject(new Error('网络中断'))
    xhr.onabort = () => reject(Object.assign(new Error('已取消'), { cancelled: true }))
    task.abort = () => xhr.abort()
    xhr.send(chunk)
  })
}

/** 分块上传一个文件；网络中断时自动重试，从服务器记录的偏移继续。 */
export async function upload(task: UploadTask, onChange: () => void) {
  task.state = 'uploading'; task.error = undefined; onChange()
  try {
    let session = task.session ?? recall(task)
    let received = 0, chunk = 8 * 1024 * 1024
    if (session) {
      const state = await driveApi<{ received: number; size: number; path: string }>(`/uploads/${session}`).catch(() => undefined)
      if (state && state.size === task.size && state.path === task.target) received = state.received
      else session = undefined
    }
    if (!session) {
      const created = await driveApi<{ id: string; received: number; chunk: number }>('/uploads', 'POST', { path: task.target, size: task.size })
      session = created.id; chunk = created.chunk || chunk
    }
    task.session = session; task.sent = received; remember(task); onChange()
    let failures = 0
    while (received < task.size) {
      const part = task.file.slice(received, Math.min(received + chunk, task.size))
      try {
        received = await sendChunk(`/api/drive/uploads/${session}?offset=${received}`, part, loaded => { task.sent = received + loaded; onChange() }, task)
        failures = 0
      } catch (err) {
        const status = (err as { status?: number }).status
        if ((err as { cancelled?: boolean }).cancelled || (status && status < 500 && status !== 409) || ++failures > 5) throw err
        // 网络错误或偏移不一致：等一会儿再按服务器记录的进度继续。
        await new Promise(resolve => setTimeout(resolve, 1000 * failures))
        received = (await driveApi<{ received: number }>(`/uploads/${session}`)).received
      }
      task.sent = received; onChange()
    }
    await driveApi(`/uploads/${session}/finish`, 'POST')
    task.state = 'done'; task.sent = task.size; remember(task)
  } catch (err) {
    if ((err as { cancelled?: boolean }).cancelled) {
      task.state = 'cancelled'
      if (task.session) await driveApi(`/uploads/${task.session}/cancel`, 'POST').catch(() => {})
      task.session = undefined; remember(task)
    } else {
      task.state = 'error'; task.error = err instanceof Error ? err.message : '上传失败'
    }
  } finally {
    task.abort = undefined; onChange()
  }
}

export async function ensureSignedIn() {
  await loadAccount()
  return account.value
}

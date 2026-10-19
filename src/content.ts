import { computed, reactive, ref } from 'vue'
import type { SiteContent, PostSummary, Repo } from './types'

export const site = ref<SiteContent>()
export const repos = ref<Repo[]>([])
export const posts = ref<PostSummary[]>([])
export const contentStatus = reactive({ loading: true, error: '', stale: false })
let versions = { site: 0, repos: 0, posts: 0 }
let timer: ReturnType<typeof setTimeout> | undefined
let failures = 0
let active: Promise<void> | undefined

export async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(15000), ...init })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    const detail = data.detail
    const description = Array.isArray(detail) ? detail.map((entry: {loc?: string[]; msg?: string}) => `${entry.loc?.slice(1).join('.') ?? ''}：${entry.msg ?? '内容无效'}`).join('；') : `请求失败 (${response.status})`
    const error = new Error(typeof detail === 'string' ? detail : description)
    Object.assign(error, { status: response.status })
    throw error
  }
  return response.json()
}

async function refresh(force = false) {
  if (active) return active
  active = (async () => {
    try {
      const next = await fetchJson<typeof versions>('/api/version')
      const [siteData, repoData, postData] = await Promise.all([
        force || next.site !== versions.site ? fetchJson<{ site: SiteContent; revision: number }>('/api/site') : null,
        force || next.repos !== versions.repos ? fetchJson<{ items: Repo[]; revision: number }>('/api/repos') : null,
        force || next.posts !== versions.posts ? fetchJson<{ items: PostSummary[]; revision: number }>('/api/posts') : null,
      ])
      if (siteData) { site.value = siteData.site; next.site = siteData.revision }
      if (repoData) { repos.value = repoData.items; next.repos = repoData.revision }
      if (postData) { posts.value = postData.items; next.posts = postData.revision }
      versions = next
      contentStatus.error = ''; contentStatus.stale = false; failures = 0
      if (site.value) document.title = location.pathname.replace(/\/$/, '') === '/scut' ? `SCUT · ${site.value.name}` : site.value.name
    } catch (error) {
      contentStatus.error = error instanceof Error ? error.message : '内容加载失败'
      contentStatus.stale = !!site.value
      failures = Math.min(failures + 1, 4)
    } finally {
      contentStatus.loading = false
      active = undefined
    }
  })()
  return active
}

export async function reloadContent() {
  await refresh(true)
  schedule()
}

function schedule() {
  clearTimeout(timer)
  if (!document.hidden) timer = setTimeout(async () => { await refresh(); schedule() }, 30000 * 2 ** failures)
}

export function startContent() {
  reloadContent()
  const visible = async () => {
    clearTimeout(timer)
    if (!document.hidden) { await refresh(); schedule() }
  }
  document.addEventListener('visibilitychange', visible)
  return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', visible) }
}

export const ready = computed(() => !!site.value)

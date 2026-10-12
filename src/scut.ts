import { computed, reactive, ref } from 'vue'
import { fetchJson } from './content'
import { initialReading, isUnread, parseReading, setRead } from './scut-reading'
import type { Notice, ReadingState } from './scut-reading'

export interface ScutColumn {
  id: string; source: string; name: string; url: string
  last_success: string | null; last_attempt: string | null; last_error: string
  initialized: boolean; scan_started: string | null; pages_scanned: number; total_pages: number | null
}
interface ScutData {
  items: Notice[]; columns: ScutColumn[]
  sources: { id: string; name: string; url: string }[]; revision: number; sync_enabled: boolean
}

const STORAGE = 'copylee.scut.reading.v1'
export const scut = ref<ScutData>()
export const scutStatus = reactive({ loading: true, error: '', storageError: '' })
export const reading = ref<ReadingState>()
export const unread = computed(() => scut.value?.items.filter((item) => reading.value && isUnread(item, reading.value)) ?? [])
let pending: Promise<void> | undefined

function saveReading() {
  try {
    localStorage.setItem(STORAGE, JSON.stringify(reading.value))
    scutStatus.storageError = ''
  } catch { scutStatus.storageError = '浏览器无法保存阅读状态，本次浏览仍可使用，刷新后可能丢失。' }
}

export function markRead(ids: string[], read = true) {
  if (!reading.value) return
  reading.value = setRead(reading.value, ids, read)
  saveReading()
}

export function noticeUnread(item: Notice) {
  return reading.value ? isUnread(item, reading.value) : false
}

export async function reloadScut() {
  if (pending) return pending
  pending = (async () => {
    try {
      const data = await fetchJson<ScutData>('/api/scut')
      // Wait for the first actual indexed records, not the initial empty response.
      if (!reading.value && data.items.length) {
        try { reading.value = parseReading(localStorage.getItem(STORAGE)) }
        catch { scutStatus.storageError = '浏览器无法读取阅读状态，本次阅读状态仅在内存中保存。' }
        reading.value ??= initialReading()
        saveReading()
      }
      scut.value = data
      scutStatus.error = ''
    } catch (error) {
      scutStatus.error = error instanceof Error ? error.message : '通知索引暂时不可用'
    } finally { scutStatus.loading = false; pending = undefined }
  })()
  return pending
}

export function startScut() {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const refresh = async () => {
    clearTimeout(timer)
    if (stopped || document.hidden) return
    await reloadScut()
    if (!stopped && !document.hidden) timer = setTimeout(refresh, 60000)
  }
  const storage = (event: StorageEvent) => {
    if (event.key === STORAGE && event.newValue) reading.value = parseReading(event.newValue) ?? reading.value
  }
  void refresh()
  document.addEventListener('visibilitychange', refresh)
  window.addEventListener('storage', storage)
  return () => {
    stopped = true; clearTimeout(timer)
    document.removeEventListener('visibilitychange', refresh)
    window.removeEventListener('storage', storage)
  }
}

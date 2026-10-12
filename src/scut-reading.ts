export interface Notice {
  id: string
  url: string
  title: string
  published_at: string | null
  first_seen: string
  columns: string[]
}

export interface ReadingState {
  baseline: string
  read: string[]
  unread: string[]
}

export function initialReading(now = new Date().toISOString()): ReadingState {
  return { baseline: now, read: [], unread: [] }
}

export function parseReading(value: string | null): ReadingState | undefined {
  if (!value) return undefined
  try {
    const state = JSON.parse(value)
    if (!state || typeof state.baseline !== 'string' || !Number.isFinite(Date.parse(state.baseline))) return undefined
    if (![state.read, state.unread].every((v) => Array.isArray(v) && v.every((id) => typeof id === 'string'))) return undefined
    return state
  } catch { return undefined }
}

export function isUnread(notice: Notice, state: ReadingState): boolean {
  if (state.unread.includes(notice.id)) return true
  if (state.read.includes(notice.id)) return false
  if (Date.parse(notice.first_seen) > Date.parse(state.baseline)) return true
  // Calendar dates follow the school's timezone, not the device timezone.
  const date = notice.published_at ? Date.parse(`${notice.published_at}T23:59:59+08:00`) : NaN
  return !Number.isFinite(date) || date >= Date.parse(state.baseline) - 7 * 86400000
}

export function setRead(state: ReadingState, ids: string[], read: boolean): ReadingState {
  const changed = new Set(ids)
  return {
    baseline: state.baseline,
    read: [...new Set([...state.read.filter((id) => !changed.has(id)), ...(read ? ids : [])])],
    unread: [...new Set([...state.unread.filter((id) => !changed.has(id)), ...(read ? [] : ids)])],
  }
}

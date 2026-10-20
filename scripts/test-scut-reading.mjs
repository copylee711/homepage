import assert from 'node:assert/strict'
import { test } from 'node:test'
import { initialReading, isUnread, parseReading, setRead } from '../src/scut-reading.ts'

const baseline = '2026-10-12T08:00:00Z'
const notice = (id, date, firstSeen = '2026-10-12T07:00:00Z') => ({ id, published_at: date, first_seen: firstSeen })
test('initial seven days, later discoveries, and explicit read/unread overrides', () => {
  let state = initialReading(baseline)
  const recent = notice('recent', '2026-10-10')
  const old = notice('old', '2025-11-01')
  const backfill = notice('backfill', '2025-11-01', '2026-10-12T09:00:00Z')
  assert.equal(isUnread(recent, state), true)
  assert.equal(isUnread(old, state), false)
  assert.equal(isUnread(backfill, state), true)
  state = setRead(state, ['recent', 'backfill'], true)
  assert.equal(isUnread(recent, state), false)
  assert.equal(isUnread(backfill, state), false)
  state = setRead(state, ['recent', 'old'], false)
  assert.equal(isUnread(recent, state), true)
  assert.equal(isUnread(old, state), true)
  assert.deepEqual(parseReading(JSON.stringify(state)), state)
})
test('corrupted storage and unknown publication dates', () => {
  assert.equal(parseReading('broken'), undefined)
  assert.equal(parseReading('{"baseline":"bad"}'), undefined)
  assert.equal(parseReading('{"baseline":"2026-10-12","read":"x","unread":[]}'), undefined)
  assert.equal(isUnread(notice('unknown', null), initialReading(baseline)), true)
})

test('account state wins, local-only marks are kept', async () => {
  const { mergeReading } = await import('../src/scut-reading.ts')
  const server = { baseline, read: ['a'], unread: ['b'] }
  const local = { baseline: '2026-10-15T00:00:00Z', read: ['b', 'c'], unread: ['a', 'd'] }
  assert.deepEqual(mergeReading(server, local), { baseline, read: ['a', 'c'], unread: ['b', 'd'] })
})

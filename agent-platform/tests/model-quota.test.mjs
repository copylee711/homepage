import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'agent-model-quota-'));
process.env.PROVIDER_DATA_DIR = directory;
const user = createHash('sha256').update('alice').digest('hex');
const { shanghaiDay, assertSharedQuota, recordSharedUsage, saveDefaultModelQuota, saveModelQuota, usageFor } = await import('../model-quota.mjs');
const morning = new Date('2026-11-10T12:00:00Z');
const nextDay = new Date('2026-11-10T16:00:00Z');

test('shared model quota uses shanghai days and treats zero as unlimited', async () => {
  assert.equal(shanghaiDay(new Date('2026-11-10T15:59:00Z')), '2026-11-10');
  assert.equal(shanghaiDay(nextDay), '2026-11-11');
  await saveDefaultModelQuota({ daily_requests: 0, daily_tokens: 0 });
  await recordSharedUsage(user, { input: 1000, output: 1000, cacheRead: 1, cacheWrite: 1 }, morning);
  await assertSharedQuota(user, morning);
  await saveDefaultModelQuota({ daily_requests: 1, daily_tokens: 0 });
  await assert.rejects(assertSharedQuota(user, morning), error => error.status === 429 && /请求次数/.test(error.message));
  await assertSharedQuota(user, nextDay);
  await saveModelQuota(user, { daily_requests: 0, daily_tokens: 5 });
  const within = await recordSharedUsage(user, { input: 4 }, nextDay);
  assert.equal(within.exceeded, null);
  const over = await recordSharedUsage(user, { output: 2 }, nextDay);
  assert.equal(over.exceeded, 'tokens');
  assert.equal(over.used.tokens, 6);
  await assert.rejects(assertSharedQuota(user, nextDay), /token/);
  assert.equal((await usageFor(user, morning)).requests, 1);
  assert.equal((await usageFor(user, morning)).tokens, 2002);
});

after(async () => rm(directory, { recursive: true, force: true }));

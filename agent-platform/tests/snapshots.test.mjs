import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatStore } from '../conversations.mjs';
import { SessionSnapshots } from '../session-snapshot.mjs';

test('history snapshots do not execute Pi; tenant/file version changes invalidate cached history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-snapshots-'));
  const store = new ChatStore({ sessionsRoot: root, metaRoot: root + '/meta' });
  const thread = '11111111-1111-4111-8111-111111111111';
  let projections = 0;
  const snapshots = new SessionSnapshots(store, async text => { projections++; return JSON.parse(text); });
  try {
    for (const user of ['a', 'b']) { await mkdir(root + '/' + user); await writeFile(store.file(user, thread), JSON.stringify([{ content: user }])); }
    assert.deepEqual(await snapshots.read('a', thread), [{ content: 'a' }]);
    await snapshots.read('a', thread); assert.equal(projections, 1);
    assert.deepEqual(await snapshots.read('b', thread), [{ content: 'b' }]);
    await writeFile(store.file('a', thread), JSON.stringify([{ content: 'updated' }]));
    assert.deepEqual(await snapshots.read('a', thread), [{ content: 'updated' }]);
    assert.deepEqual(await snapshots.read('absent', thread), []);
    await assert.rejects(snapshots.read('a', '../bad'), error => error.status === 422);
  } finally { await rm(root, { recursive: true, force: true }); }
});

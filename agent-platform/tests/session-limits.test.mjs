import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionCapacity } from '../session-limits.mjs';
test('conversation count and per-file/total storage are bounded per user', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-capacity-'));
  const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  try {
    await sessionCapacity(directory, a);
    await writeFile(join(directory, a + '.jsonl'), '12345');
    await assert.rejects(sessionCapacity(directory, b, { chats: 1 }), error => error.status === 413);
    await assert.rejects(sessionCapacity(directory, a, { file: 5 }), error => error.status === 413);
    await assert.rejects(sessionCapacity(directory, b, { bytes: 5 }), error => error.status === 413);
    await sessionCapacity(directory, a, { file: 5, bytes: 5, readExisting: true });
    await sessionCapacity(directory, a, { chats: 1, file: 6, bytes: 6 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

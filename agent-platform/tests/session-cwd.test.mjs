import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareSessionCwd } from '../session-cwd.mjs';

test('legacy sessions migrate only cwd metadata and preserve all message bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-cwd-'));
  const file = join(directory, 'existing.jsonl');
  const header = { type: 'session', version: 3, id: 'existing', cwd: '/workspace/old-user', timestamp: '2026-10-31' };
  const messages = Buffer.from('{"type":"message","message":{"role":"user","content":"旧对话"}}\n{"type":"message","message":{"role":"assistant","content":"kept"}}\n');
  try {
    await writeFile(file, Buffer.concat([Buffer.from(JSON.stringify(header) + '\n'), messages]));
    assert.equal(await prepareSessionCwd(file, directory), true);
    const result = await readFile(file), newline = result.indexOf(10);
    assert.deepEqual(JSON.parse(result.subarray(0, newline)), { ...header, cwd: directory });
    assert.deepEqual(result.subarray(newline + 1), messages);
    assert.deepEqual(JSON.parse(await readFile(file + '.cwd-backup', 'utf8')), header);
    assert.equal(await prepareSessionCwd(file, directory), false);
    assert.equal(await prepareSessionCwd(join(directory, 'new.jsonl'), directory), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

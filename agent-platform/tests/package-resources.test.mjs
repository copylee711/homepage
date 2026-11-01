import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packageReader } from '../package-resources.mjs';
test('package text reads are exact capabilities, never a general runner filesystem fallback', async () => {
  let reads = 0;
  const target = '/data/packages/known/0/SKILL.md';
  const io = { lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, size: 50 }), readFile: async () => { reads++; return Buffer.from('public skill'); } };
  const read = packageReader([target], io);
  for (const path of ['/data/agent/models.json', '/proc/self/environ', '/data/packages/known/0/../0/SKILL.md', target + '/extra']) assert.equal(await read(path), null);
  assert.equal(reads, 0);
  assert.equal((await read(target)).toString(), 'public skill');
  io.lstat = async () => ({ isFile: () => true, isSymbolicLink: () => true, size: 50 });
  await assert.rejects(read(target), /unavailable/);
  io.lstat = async () => ({ isFile: () => true, isSymbolicLink: () => false, size: 128 * 1024 + 1 });
  await assert.rejects(read(target), /unavailable/);
  assert.equal(reads, 1);
});

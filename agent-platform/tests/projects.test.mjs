import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatStore, validProjectId, historyPrefix, historyThroughUserTurns } from '../conversations.mjs';

test('first prompt binds project and permissions before JSONL exists; restart preserves them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-project-'));
  try {
    const options = { sessionsRoot: join(root, 'sessions'), metaRoot: join(root, 'meta') };
    const store = new ChatStore(options), user = 'a'.repeat(64), other = 'b'.repeat(64);
    const thread = '11111111-1111-4111-8111-111111111111';
    await store.createProject(user, { id: 'app', name: '应用' });
    await store.initialize(user, thread, 'app', { scope: 'scoped', extraProjects: { default: 'read' } });
    await store.initialize(user, thread, 'default', { scope: 'full' });
    const saved = (await new ChatStore(options).loadMeta(user)).chats[thread];
    assert.equal(saved.projectId, 'app');
    assert.deepEqual(saved.permission, { scope: 'scoped', extraProjects: { default: 'read' }, execution: 'ask' });
    assert.equal((await store.loadMeta(other)).projects.app, undefined);
    await assert.rejects(store.deleteProject(user, 'app'), error => error.status === 409);
    for (const id of ['../x', '__proto__', 'constructor', 'lost+found', '$(touch x)', 'a/b']) assert.equal(validProjectId(id), false);
    await assert.rejects(store.initialize(other, thread, 'app'), error => error.status === 404);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rewind preserves a recovery copy, forks cannot overwrite, complex trees fail without modification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-history-'));
  try {
    const store = new ChatStore({ sessionsRoot: root, metaRoot: join(root, 'meta') });
    const user = 'a'.repeat(64), thread = '11111111-1111-4111-8111-111111111111', target = '22222222-2222-4222-8222-222222222222';
    await mkdir(store.directory(user));
    const rows = [{ type: 'session', id: thread },
      { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'hello' } },
      { type: 'message', id: 'a', parentId: 'u', message: { role: 'assistant', content: [] } },
      { type: 'usage', id: 'usage', parentId: 'a' }];
    const content = rows.map(JSON.stringify).join('\n') + '\n';
    await writeFile(store.file(user, thread), content);
    await store.fork(user, thread, target, '分叉', 1);
    assert.equal((await readFile(store.file(user, target), 'utf8')).includes('"id":"a"'), false);
    await assert.rejects(store.fork(user, thread, target, '覆盖'), { code: 'EEXIST' });
    await store.truncate(user, thread, 1);
    assert.equal(await readFile(store.file(user, thread) + '.rewind-backup', 'utf8'), content);
    assert.equal((await readFile(store.file(user, thread), 'utf8')).includes('usage'), false);
    assert.throws(() => historyPrefix(content + JSON.stringify({ type: 'compaction' }), 1), error => error.status === 409);
    assert.throws(() => historyPrefix(content, -1), error => error.status === 422);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rewinding counts user turns rather than flattened streaming display messages', () => {
  const roles = ['user', 'assistant', 'toolResult', 'assistant', 'user', 'assistant'];
  const rows = [{ type: 'session' }, ...roles.map((role, index) => ({ type: 'message', id: String(index), parentId: index ? String(index - 1) : null, message: { role, content: String(index) } }))];
  const raw = rows.map(JSON.stringify).join('\n') + '\n';
  const prefix = historyThroughUserTurns(raw, 1).trim().split('\n').map(JSON.parse);
  assert.equal(prefix.length, 5);
  assert.equal(prefix.at(-1).message.content, '3');
  assert.throws(() => historyThroughUserTurns(raw, 3), e => e.status === 409);
});

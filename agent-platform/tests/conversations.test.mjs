import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatStore, exportMessages, normalizeTitle, safeFilename, validThread } from '../conversations.mjs';
import { modelLabel } from '../shared.mjs';

const root = await mkdtemp(join(tmpdir(), 'agent-chats-'));
const sessionsRoot = join(root, 'sessions'), metaRoot = join(root, 'meta');
const a = 'a'.repeat(64), b = 'b'.repeat(64);
const idA = '11111111-1111-4111-8111-111111111111';
const idB = '22222222-2222-4222-8222-222222222222';
const session = (text, extra = []) => [
  { type: 'session', version: 3, id: 'x', cwd: '/tmp/pi/a' },
  { type: 'message', timestamp: '2026-10-30T10:00:00.000Z', message: { role: 'system', content: 'SECRET SYSTEM PROMPT' } },
  { type: 'message', timestamp: '2026-10-30T10:00:01.000Z', message: { role: 'user', content: text } },
  { type: 'message', timestamp: '2026-10-30T10:00:02.000Z', message: { role: 'assistant', content: [
    { type: 'thinking', thinking: '先检查工作区。' },
    { type: 'text', text: '目录结构如下：\n\n```text\nnotes/\n```' },
    { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls -la' } },
  ] } },
  { type: 'message', timestamp: '2026-10-30T10:00:03.000Z', message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'bash', isError: false, content: [{ type: 'text', text: 'notes' }] } },
  ...extra,
].map(value => JSON.stringify(value)).join('\n') + '\n';

await mkdir(join(sessionsRoot, a), { recursive: true });
await mkdir(join(sessionsRoot, b), { recursive: true });
await writeFile(join(sessionsRoot, a, idA + '.jsonl'), session('帮我查看工作区'));
await writeFile(join(sessionsRoot, b, idB + '.jsonl'), session('另一个用户的秘密对话'));
const store = new ChatStore({ sessionsRoot, metaRoot });
after(async () => rm(root, { recursive: true, force: true }));

test('chat metadata is per user and survives a new store instance', async () => {
  const before = await store.list(a);
  assert.equal(before.length, 1);
  assert.equal(before[0].title, '帮我查看工作区');
  assert.equal(before[0].pinned, false);
  assert.equal(before[0].archived, false);
  await store.rename(a, idA, '  工作区  检查  ');
  await store.setPinned(a, idA, true);
  await store.setArchived(a, idA, true);
  const saved = await store.list(a);
  assert.deepEqual({ title: saved[0].title, pinned: saved[0].pinned, archived: saved[0].archived },
    { title: '工作区 检查', pinned: true, archived: true });
  const reopened = new ChatStore({ sessionsRoot, metaRoot });
  assert.equal((await reopened.list(a))[0].title, '工作区 检查');
  const other = await store.list(b);
  assert.equal(other[0].title, '另一个用户的秘密对话');
  assert.equal(other[0].pinned, false);
  await store.setPinned(a, idA, false);
  assert.equal((await store.list(a))[0].pinned, false);
  assert.equal((await store.setArchived(a, idA, false)).archived, undefined);
  assert.equal((await store.list(a))[0].archived, false);
});

test('tenant isolation rejects another user id, traversal and invalid threads', async () => {
  await assert.rejects(store.rename(b, idA, '越权'), error => error.status === 404);
  await assert.rejects(store.setPinned(a, '../../etc/passwd', true), error => error.status === 422);
  await assert.rejects(store.rename(a, '11111111-1111-4111-8111-11111111111G', 'x'), error => error.status === 422);
  assert.equal(validThread(idA), true);
  assert.equal(validThread('../' + idA), false);
  await assert.rejects(async () => normalizeTitle(''), /标题/);
  await assert.rejects(async () => normalizeTitle('x'.repeat(81)), /标题/);
  assert.equal(normalizeTitle('  a\n b  '), 'a b');
  assert.doesNotMatch(safeFilename('../../秘密/对话', idA), /[\\/]/);
});

test('a failed metadata mutation does not block the next one or leak a rejection', async () => {
  let unhandled = 0;
  const listener = () => { unhandled += 1; };
  process.on('unhandledRejection', listener);
  try {
    await assert.rejects(async () => store.rename(a, idA, ''), error => error.status === 422);
    const result = await store.setPinned(a, idA, true);
    assert.equal(result.pinned, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(unhandled, 0);
  } finally {
    process.off('unhandledRejection', listener);
    await store.setPinned(a, idA, false);
  }
});

test('exports Markdown and JSON without system prompts or provider signatures', async () => {
  const markdown = await store.export(a, idA, 'md');
  assert.match(markdown.filename, /\.md$/);
  assert.match(markdown.content, /^# /);
  assert.match(markdown.content, /帮我查看工作区/);
  assert.match(markdown.content, /先检查工作区。/);
  assert.match(markdown.content, /```js(on)?\n/);
  assert.match(markdown.content, /工具结果 · bash/);
  assert.doesNotMatch(markdown.content, /SECRET SYSTEM PROMPT/);
  const json = await store.export(a, idA, 'json');
  const value = JSON.parse(json.content);
  assert.equal(value.schema, 'copylee.agent.chat.v1');
  assert.equal(value.chat.id, idA);
  assert.equal(value.messages[0].role, 'user');
  assert.equal(value.messages[1].role, 'assistant');
  assert.equal(value.messages[1].content.some(block => block.type === 'thinking'), true);
  assert.equal(value.messages[2].role, 'toolResult');
  assert.equal(value.messages[2].tool_name, 'bash');
  assert.doesNotMatch(json.content, /SECRET SYSTEM PROMPT/);
  assert.doesNotMatch(json.content, /thinkingSignature|textSignature/);
  await assert.rejects(store.export(a, idA, 'html'), error => error.status === 422);
});

test('known secrets are masked in both export formats and filenames', async () => {
  const secret = 'sk-legacy-secret-value';
  const id = '33333333-3333-4333-8333-333333333333';
  await writeFile(join(sessionsRoot, a, id + '.jsonl'), session('请检查 ' + secret, [
    { type: 'message', message: { role: 'toolResult', toolCallId: 'call_2', toolName: 'read',
      isError: false, content: [{ type: 'text', text: 'OUTPUT ' + secret }] } },
  ]));
  for (const format of ['md', 'json']) {
    const value = await store.export(a, id, format, [secret]);
    assert.doesNotMatch(value.content, new RegExp(secret));
    assert.doesNotMatch(value.filename, new RegExp(secret));
    assert.match(value.content, /\[REDACTED\]/);
  }
});

test('export normalization tolerates unknown blocks and keeps text', () => {
  const messages = exportMessages([
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', data: 'AAAA' }] } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'unknown', value: 1 }, { type: 'text', text: 'ok' }] } },
    { type: 'other' },
  ]);
  assert.deepEqual(messages[0].content, [{ type: 'text', text: 'hi' }, { type: 'image', omitted: true }]);
  assert.deepEqual(messages[1].content, [{ type: 'text', text: 'ok' }]);
});

test('model labels hide provider routes and remain readable', () => {
  assert.equal(modelLabel('opencode-go/deepseek-v4.1-flash'), 'DeepSeek V4.1 Flash');
  assert.equal(modelLabel('gpt-4o-mini'), 'GPT 4o Mini');
  assert.equal(modelLabel('claude-sonnet-5-5'), 'Claude Sonnet 5 5');
  assert.equal(modelLabel(''), 'Pi 模型');
});

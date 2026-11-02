// Run inside the deployed runner with its normal environment. Uses a dedicated
// synthetic tenant and prints only assertions, never credentials or file contents.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { sandbox, sandboxTool } from '/app/sandbox-client.mjs';
const user = createHash('sha256').update('iris-acceptance-20261102').digest('hex');
const thread = randomUUID();
async function api(path, fields = {}) {
  const response = await fetch('http://127.0.0.1:8081' + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Runner-Secret': process.env.RUNNER_SECRET },
    body: JSON.stringify({ user, ...fields }), signal: AbortSignal.timeout(90000) });
  if (path === '/prompt' && response.ok) return response.text();
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error), { status: response.status });
  return value;
}
for (const id of ['qa-main', 'qa-reference']) {
  try { await api('/projects/create', { id, name: id }); } catch (e) { if (e.status !== 409) throw e; }
}
const payload = Buffer.alloc(768 * 1024, 42).toString('base64');
await api('/files/upload', { path: 'qa-main/attachment.dat', content: payload, encoding: 'base64', overwrite: true });
assert.equal((await api('/files/download', { path: 'qa-main/attachment.dat' })).size, 768 * 1024);
console.log('PASS: 768 KiB binary upload through runner and broker');

await api('/files/upload', { path: 'qa-reference/README.txt', content: 'reference', overwrite: true });
const token = (await sandbox('/lease', user, undefined, { project: 'qa-main', scope: 'scoped', extraProjects: { 'qa-reference': 'read' } })).token;
assert.equal((await sandboxTool(token, { op: 'bash', command: 'cat /workspace/qa-reference/README.txt' })).output.trim(), 'reference');
assert.notEqual((await sandboxTool(token, { op: 'bash', command: 'echo changed > /workspace/qa-reference/README.txt' })).exitCode, 0);
console.log('PASS: real lease enforces scoped readonly for bash');

const renewal = setInterval(() => api('/renew').catch(() => {}), 5000);
try {
  const text = await api('/prompt', { thread, projectId: 'qa-main', permission: { scope: 'project_only', execution: 'auto' },
    message: '验收任务：只调用一次 bash 工具执行 pwd，然后回复“验收完成”。不要执行其他操作。' });
  assert.match(text, /tool_execution_start/);
  assert.match(text, /\/workspace\/qa-main/);
  assert.match(text, /agent_settled/);
  const chats = await api('/chats');
  assert.equal(chats.chats.find(chat => chat.id === thread)?.projectId, 'qa-main');
  console.log('PASS: real model executes bash in bound project; conversation persists');
} finally { clearInterval(renewal); }

const terminal = await api('/terminal/exec', { cwd: '/workspace/qa-main', command: 'git init -b main >/dev/null 2>&1; pwd' });
assert.equal(terminal.exitCode, 0);
assert.equal(terminal.cwd, '/workspace/qa-main');
assert.equal((await api('/git/status', { project: 'qa-main' })).isGit, true);
await assert.rejects(api('/git/checkout', { project: 'qa-main', branch: '--orphan' }), e => e.status === 422);
await assert.rejects(api('/git/status', { project: '$(touch injected)' }), e => e.status === 422);
console.log('PASS: terminal cwd, real git status, invalid project and option rejection');
await api('/chats/delete', { thread });
console.log('Dedicated acceptance tenant:', user);

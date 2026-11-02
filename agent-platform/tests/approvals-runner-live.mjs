// Opt-in real-model test inside an isolated candidate runner. No production chats.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { sandbox, sandboxTool } from '/app/sandbox-client.mjs';
const user = createHash('sha256').update('iris-acceptance-20261102').digest('hex');
const base = 'http://127.0.0.1:8081';
const headers = { 'Content-Type': 'application/json', 'X-Runner-Secret': process.env.RUNNER_SECRET };
async function api(path, data = {}) {
  const r = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify({ user, ...data }) });
  const value = await r.json();
  if (!r.ok) throw Object.assign(new Error(value.error), { status: r.status });
  return value;
}
await api('/projects/create', { id: 'qa-approval', name: '验收审批' });
const ownerLease = (await sandbox('/lease', user)).token;
for (const allowed of [false, true]) {
  const thread = randomUUID(), filename = 'approval-' + randomUUID() + '.txt';
  let requested = false, decided = false, settled = false;
  const renew = setInterval(() => api('/renew').catch(() => {}), 5000);
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 90000);
  try {
    const r = await fetch(base + '/prompt', { method: 'POST', headers, signal: controller.signal,
      body: JSON.stringify({ user, thread, projectId: 'qa-approval', permission: { scope: 'project_only', execution: 'ask' },
        message: `只调用一次 bash 工具执行命令：printf approved > ${filename} 。如果用户拒绝，立即结束，不重试也不改用其他工具。` }) });
    assert.equal(r.ok, true);
    let buffer = '';
    for await (const chunk of r.body) {
      buffer += Buffer.from(chunk).toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === 'extension_ui_request' && event.method === 'confirm') {
          requested = true;
          // Wait with a pending request: the command must not have run yet.
          await new Promise(resolve => setTimeout(resolve, 300));
          const probeLease = (await sandbox('/lease', user)).token;
          const before = await sandboxTool(probeLease, { op: 'bash', command: `test -e /workspace/qa-approval/${filename}` });
          assert.notEqual(before.exitCode, 0, 'Tool executed before approval');
          await assert.rejects(api('/approvals/resolve', { user: 'b'.repeat(64), thread, id: event.id, allow: true }), e => e.status === 409);
          await api('/approvals/resolve', { thread, id: event.id, allow: allowed });
          await assert.rejects(api('/approvals/resolve', { thread, id: event.id, allow: !allowed }), e => e.status === 409);
          decided = true;
        }
        if (event.type === 'gateway_error') throw new Error(event.error);
        if (event.type === 'agent_settled') settled = true;
      }
    }
    assert.ok(requested && decided && settled, 'Missing real approval lifecycle');
    const finalLease = (await sandbox('/lease', user)).token;
    const after = await sandboxTool(finalLease, { op: 'bash', command: `test -e /workspace/qa-approval/${filename}` });
    assert.equal(after.exitCode === 0, allowed);
    console.log(allowed ? 'PASS: explicit approval executes exact pending tool, replay/cross-user rejected' : 'PASS: pending and rejected tool never executes, replay/cross-user rejected');
  } finally {
    clearInterval(renew); clearTimeout(deadline);
    await api('/cancel').catch(() => {});
  }
}

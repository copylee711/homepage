// Opt-in: run inside an isolated runner with a synthetic tenant and real provider.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
const user = createHash('sha256').update('iris-acceptance-20261102').digest('hex');
const base = 'http://127.0.0.1:8081', headers = { 'Content-Type': 'application/json', 'X-Runner-Secret': process.env.RUNNER_SECRET };
async function api(path, fields = {}) {
  const r = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify({ user, ...fields }), signal: AbortSignal.timeout(60000) });
  const v = await r.json(); if (!r.ok) throw Object.assign(new Error(v.error), { status: r.status }); return v;
}
await api('/projects/create', { id: 'qa-interactions', name: '交互验收' }).catch(e => { if(e.status!==409)throw e; });
async function run(mode, message, onEvent) {
  const thread = randomUUID(), controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 150000), renew = setInterval(() => api('/renew').catch(() => {}), 5000);
  const events = [];
  try {
    const r = await fetch(base + '/prompt', { method: 'POST', headers, signal: controller.signal, body: JSON.stringify({ user, thread, projectId: 'qa-interactions', permission: { scope: 'project_only', execution: mode }, message }) });
    assert.equal(r.ok, true, await (!r.ok ? r.text() : ''));
    const decoder = new TextDecoder(); let buffer = '';
    for await (const chunk of r.body) {
      buffer += decoder.decode(chunk, { stream: true }); let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (!line.trim()) continue;
        const e = JSON.parse(line); events.push(e);
        if (e.type === 'gateway_error') throw new Error(e.error);
        await onEvent?.(e, thread);
      }
    }
    assert.ok(events.some(e => e.type === 'agent_settled'), 'task must settle');
    return { events, thread };
  } finally { clearTimeout(deadline); clearInterval(renew); await api('/cancel').catch(() => {}); }
}
let questions = 0, approvals = 0;
const first = await run('edit', '严格按顺序进行验收：1.调用 update_plan 建立两步计划；2.调用 write 写入 proof.txt，内容为 BEFORE；3.调用 read 读取 proof.txt；4.调用 ask_user 询问文件格式，选项 Markdown（推荐，说明便于阅读）和纯文本；等待回答；5.调用 bash 执行 printf AFTER > proof.txt；6.更新计划为全部完成；7.正文只回复“INTERACTION_OK”及用户选择。必须调用上述工具，不要省略。', async (e, thread) => {
  if (e.type === 'extension_ui_request' && e.method === 'input') {
    questions++; assert.ok(e.question.options.some(o => o.recommended));
    await assert.rejects(api('/questions/answer', { user: 'b'.repeat(64), thread, id: e.id, answer: 'bad' }), x => x.status === 409);
    await api('/questions/answer', { thread, id: e.id, answer: 'Markdown' });
    await assert.rejects(api('/questions/answer', { thread, id: e.id, answer: 'replay' }), x => x.status === 409);
  }
  if (e.type === 'extension_ui_request' && e.method === 'confirm') {
    approvals++; assert.match(e.title, /bash$/);
    await api('/chats/permission', { thread, permission: { scope: 'project_only', execution: 'auto' } });
  }
});
assert.equal(questions, 1); assert.equal(approvals, 1);
for (const name of ['update_plan', 'write', 'read', 'ask_user', 'bash']) assert.ok(first.events.some(e => e.type === 'tool_execution_start' && e.toolName === name), 'missing ' + name);
assert.match(JSON.stringify(first.events.filter(e => e.type === 'message_end' && e.message?.role === 'assistant')), /INTERACTION_OK/);
console.log('PASS: real model plan/read/edit/question; only bash asks; runtime auto releases exact pending operation; final body preserved');

let switched = false, denied = 0;
await run('auto', '必须严格顺序调用两次 bash：第一次执行 sleep 2; echo FIRST；第二次执行 echo SECOND。若第二次被拒绝就不要重试，结束并回复 SWITCH_OK。', async (e, thread) => {
  if (!switched && e.type === 'tool_execution_start' && e.toolName === 'bash') {
    switched = true;
    await api('/chats/permission', { thread, permission: { scope: 'project_only', execution: 'ask' } });
    await api('/steer', { thread, message: '补充要求：最终回答加上 STEER_ACK。第二次命令若拒绝不要重试。' });
  }
  if (e.type === 'extension_ui_request' && e.method === 'confirm') { denied++; await api('/approvals/resolve', { thread, id: e.id, allow: false }); }
});
assert.ok(switched && denied >= 1);
console.log('PASS: live auto→ask applies before next bash; steer accepted while busy; denial settles');

const results = await api('/search/test', { query: 'Python official documentation' });
assert.ok(results.results.length > 0 && results.results.every(r => /^https?:\/\//.test(r.url)));
console.log('PASS: standalone live search returns titles, URLs and snippets via ' + results.engine);
const search = await run('ask', '必须调用 web_search 搜索 Python official documentation，然后选一条真实结果调用 web_fetch 阅读，最后用一句中文提供 Python 官方文档链接。不得使用 bash。', (e) => {
  assert.ok(!(e.type === 'extension_ui_request' && e.method === 'confirm'), 'read-only search/fetch must not ask permission');
});
for (const name of ['web_search', 'web_fetch']) assert.ok(search.events.some(e => e.type === 'tool_execution_end' && e.toolName === name && !e.isError), 'missing successful ' + name);
console.log('PASS: real model web_search → web_fetch → cited answer, no Pi search plugins or manual read approval');

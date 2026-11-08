import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

process.env.TURN_HEARTBEAT_MS = '40';
process.env.PUBLIC_URL = 'http://127.0.0.1';
process.env.HOMEPAGE_CLIENT_SECRET = 'a'.repeat(64);
process.env.RUNNER_SECRET = 'b'.repeat(64);
process.env.SECURE_COOKIES = 'false';
process.env.NODE_ENV = 'test';

const calls = [];
let active = null;
let promptClosed = false;
const runner = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  JSON.parse(raw || '{}');
  assert.equal(req.headers['x-runner-secret'], 'b'.repeat(64));
  calls.push(req.url);
  if (req.url === '/prompt' || req.url === '/turns/subscribe') {
    promptClosed = false;
    active = res;
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(JSON.stringify({ type: 'message', text: 'started' }) + '\n');
    res.on('close', () => { if (res === active) promptClosed = true; });
    return;
  }
  if (req.url === '/abort') {
    try { active?.end(JSON.stringify({ type: 'agent_end', reason: 'abort' }) + '\n'); } catch { /* already closed */ }
    active = null;
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === '/turns/status') {
    res.end(JSON.stringify({ busy: false, settled: false, cursor: 0 }));
    return;
  }
  res.end(JSON.stringify({ ok: true }));
});
await new Promise(resolve => runner.listen(0, '127.0.0.1', resolve));
process.env.RUNNER_URL = `http://127.0.0.1:${runner.address().port}`;

let admin = true, granted = true, ssoAvailable = true;
const homepage = createServer(async (req, res) => {
  let incoming = '';
  for await (const chunk of req) incoming += chunk;
  JSON.parse(incoming || '{}');
  assert.equal(req.headers['x-agent-client-secret'], 'a'.repeat(64));
  res.setHeader('Content-Type', 'application/json');
  if (!ssoAvailable && req.url.endsWith('/execution/introspect')) { res.writeHead(503); res.end('{}'); return; }
  res.end(JSON.stringify({ user: { id: 'user-1', name: 'Tester' }, can_execute: admin || granted, admin }));
});
await new Promise(resolve => homepage.listen(0, '127.0.0.1', resolve));
process.env.HOMEPAGE_URL = `http://127.0.0.1:${homepage.address().port}`;

const { server } = await import('../gateway.mjs');
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const stops = () => calls.filter(path => path === '/cancel' || path === '/abort');

after(async () => {
  try { active?.end(); } catch { /* already closed */ }
  await Promise.all([
    new Promise(resolve => server.close(resolve)),
    new Promise(resolve => homepage.close(resolve)),
    new Promise(resolve => runner.close(resolve)),
  ]);
});

async function authHeaders() {
  const cookie = 'copylee_ai=' + 't'.repeat(64);
  const me = await (await fetch(base + '/api/me', { headers: { cookie } })).json();
  return { cookie, Origin: 'http://127.0.0.1', 'X-CSRF-Token': me.csrf, 'Content-Type': 'application/json' };
}

function lineReader(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let pending = null;
  const lines = [];
  return {
    lines,
    async take(want, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      while (lines.length < want && Date.now() < deadline) {
        if (!pending) pending = reader.read();
        let timer;
        const timeout = new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), Math.max(15, deadline - Date.now())); });
        const winner = await Promise.race([pending.then(item => ({ item })), timeout]);
        clearTimeout(timer);
        if (winner === 'timeout') continue;
        pending = null;
        if (winner.item.done) break;
        buf += decoder.decode(winner.item.value, { stream: true });
        let index;
        while ((index = buf.indexOf('\n')) >= 0) {
          lines.push(buf.slice(0, index));
          buf = buf.slice(index + 1);
        }
      }
      return lines;
    },
    cancel() { return reader.cancel().catch(() => {}); },
  };
}

test('browser disconnect keeps the turn, explicit abort and lost permission still stop it', async () => {
  const gateway = await readFile(new URL('../gateway.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(gateway, /res\.once\('close', \(\) => abort\.abort\(\)\)/);
  const headers = await authHeaders();
  const thread = '11111111-1111-4111-8111-111111111111';
  const controller = new AbortController();
  const prompt = await fetch(base + '/api/prompt', {
    method: 'POST', headers, signal: controller.signal,
    body: JSON.stringify({ thread, message: 'install the dependencies' }),
  });
  assert.equal(prompt.status, 200);
  const first = lineReader(prompt);
  assert.match((await first.take(1))[0], /started/);
  controller.abort();
  await first.cancel();
  // More than the old five-heartbeat cutoff, while the browser is away.
  ssoAvailable = false;
  try {
    await delay(320);
    assert.deepEqual(stops(), []);
  } finally { ssoAvailable = true; }
  const renewalCount = calls.filter(path => path === '/renew').length;
  for (let i = 0; i < 40 && calls.filter(path => path === '/renew').length === renewalCount; i++) await delay(25);
  assert.ok(calls.filter(path => path === '/renew').length > renewalCount);
  assert.deepEqual(stops(), []);
  assert.equal(promptClosed, false);
  assert.equal(active?.writableEnded, false);
  const status = await (await fetch(base + '/api/turns/status?thread=' + thread, { headers })).json();
  assert.equal(status.busy, true);
  assert.ok(status.cursor >= 1);

  const again = await fetch(base + '/api/prompt', {
    method: 'POST', headers, body: JSON.stringify({ thread, message: 'do not cancel the running turn' }),
  });
  assert.equal(again.status, 409);
  await again.text();
  assert.deepEqual(stops(), []);

  const sub = await fetch(base + '/api/turns/subscribe', {
    method: 'POST', headers, body: JSON.stringify({ thread, cursor: 0 }),
  });
  assert.equal(sub.status, 200);
  const replay = lineReader(sub);
  assert.match((await replay.take(1))[0], /started/);
  active.write(JSON.stringify({ type: 'tool', name: 'background_wait' }) + '\n');
  assert.match((await replay.take(2)).join('\n'), /background_wait/);
  await replay.cancel();
  const beforeCancel = stops().length;
  active.end();
  active = null;
  for (let i = 0; i < 40 && !calls.includes('/cancel'); i++) await delay(25);
  assert.ok(calls.includes('/cancel'));
  assert.equal(calls.filter(path => path === '/abort').length, 0);
  assert.ok(stops().length > beforeCancel);
  const settled = await (await fetch(base + '/api/turns/status?thread=' + thread, { headers })).json();
  assert.equal(settled.busy, false);
  assert.equal(settled.settled, true);

  const abortThread = '22222222-2222-4222-8222-222222222222';
  const running = await fetch(base + '/api/prompt', {
    method: 'POST', headers, body: JSON.stringify({ thread: abortThread, message: 'keep going until abort' }),
  });
  assert.equal(running.status, 200);
  const runningReader = lineReader(running);
  await runningReader.take(1);
  const abort = await fetch(base + '/api/abort', {
    method: 'POST', headers, body: JSON.stringify({ thread: abortThread }),
  });
  assert.equal(abort.status, 200);
  let abortStatus = {};
  for (let i = 0; i < 40; i++) {
    abortStatus = await (await fetch(base + '/api/turns/status?thread=' + abortThread, { headers })).json();
    if (calls.includes('/abort') && abortStatus.busy === false) break;
    await delay(25);
  }
  await runningReader.cancel();
  assert.ok(calls.includes('/abort'));
  assert.equal(abortStatus.busy, false);
  assert.equal(abortStatus.policyStopped, true);

  calls.length = 0;
  const policyThread = '33333333-3333-4333-8333-333333333333';
  const policy = await fetch(base + '/api/prompt', {
    method: 'POST', headers, body: JSON.stringify({ thread: policyThread, message: 'stop when the grant is revoked' }),
  });
  assert.equal(policy.status, 200);
  const policyReader = lineReader(policy);
  await policyReader.take(1);
  admin = false; granted = false;
  for (let i = 0; i < 40 && !calls.includes('/abort'); i++) await delay(30);
  assert.ok(calls.includes('/abort'), 'lost execution permission must abort the detached turn');
  await policyReader.cancel();
  admin = true; granted = true;
});

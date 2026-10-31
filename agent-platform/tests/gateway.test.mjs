import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
let admin = true, granted = false;
let lastRunner;
const runner = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  lastRunner = { path: req.url, value: JSON.parse(raw) };
  assert.equal(req.headers['x-runner-secret'], 'b'.repeat(64));
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(req.url === '/model' ? { label: 'DeepSeek V4.1 Flash' } : { ok: true, entries: [] }));
});
await new Promise(resolve => runner.listen(0, '127.0.0.1', resolve));
process.env.RUNNER_URL = `http://127.0.0.1:${runner.address().port}`;
const homepage = createServer(async (req, res) => {
  assert.equal(req.headers['x-agent-client-secret'], 'a'.repeat(64));
  res.setHeader('Content-Type', 'application/json');
  if (req.url.endsWith('/exchange')) res.end(JSON.stringify({ token: 't'.repeat(64), expires_at: Date.now() / 1000 + 3600 }));
  else res.end(JSON.stringify({ user: { id: 'user-1', name: 'Tester' }, can_execute: admin || granted, admin }));
});
await new Promise(resolve => homepage.listen(0, '127.0.0.1', resolve));
process.env.HOMEPAGE_URL = `http://127.0.0.1:${homepage.address().port}`;
process.env.PUBLIC_URL = 'http://127.0.0.1';
process.env.HOMEPAGE_CLIENT_SECRET = 'a'.repeat(64);
process.env.RUNNER_SECRET = 'b'.repeat(64);
process.env.SECURE_COOKIES = 'false';
process.env.NODE_ENV = 'test';
const { server } = await import('../gateway.mjs');
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => { await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => homepage.close(resolve)), new Promise(resolve => runner.close(resolve))]); });
test('anonymous access redirects and a callback needs the original signed browser flow', async () => {
  const root = await fetch(base, { redirect: 'manual' });
  assert.equal(root.status, 302);
  const start = await fetch(base + '/auth/login', { redirect: 'manual' });
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const cookie = start.headers.get('set-cookie').split(';')[0];
  const missing = await fetch(base + '/auth/callback?code=valid-code&state=' + state, { redirect: 'manual' });
  assert.equal(missing.status, 400);
  const wrong = await fetch(base + '/auth/callback?code=valid-code&state=wrong', { headers: { cookie }, redirect: 'manual' });
  assert.equal(wrong.status, 400);
  const completed = await fetch(base + '/auth/callback?code=valid-code&state=' + state, { headers: { cookie }, redirect: 'manual' });
  assert.equal(completed.status, 302);
  assert.match(completed.headers.get('set-cookie'), /HttpOnly/);
  assert.doesNotMatch(completed.headers.get('set-cookie'), /Domain=/);
});
test('server authorization and CSRF protect execution and provider settings', async () => {
  const cookie = 'copylee_ai=' + 't'.repeat(64);
  admin = false;
  assert.equal((await fetch(base + '/api/providers', { headers: { cookie } })).status, 403);
  admin = true;
  const response = await fetch(base + '/api/providers/save', { method: 'POST', headers: { cookie, Origin: 'http://evil.test' }, body: '{}' });
  assert.equal(response.status, 403);
  const me = await fetch(base + '/api/me', { headers: { cookie } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).csrf.length > 20, true);
  assert.equal(me.headers.get('referrer-policy'), 'no-referrer');
});

test('an execution grant never grants provider or user-management privileges', async () => {
  admin = false; granted = true;
  const cookie = 'copylee_ai=' + 't'.repeat(64);
  const me = await (await fetch(base + '/api/me', { headers: { cookie } })).json();
  assert.equal(me.can_execute, true); assert.equal(me.admin, false);
  for (const path of ['/api/providers', '/api/grants']) {
    assert.equal((await fetch(base + path, { headers: { cookie } })).status, 403);
  }
  for (const path of ['/api/providers/save', '/api/providers/test', '/api/grants/save']) {
    assert.equal((await fetch(base + path, { method: 'POST', headers: { cookie,
      Origin: 'http://127.0.0.1', 'X-CSRF-Token': me.csrf }, body: JSON.stringify({ user_id: 'other', days: 30 }) })).status, 403);
  }
  granted = false;
  assert.equal((await fetch(base + '/api/chats', { headers: { cookie } })).status, 403);
  admin = true;
});

test('new file/chat endpoints enforce CSRF and derive tenant identity; local modules stay authenticated', async () => {
  const cookie = 'copylee_ai=' + 't'.repeat(64);
  admin = false; granted = true;
  const me = await (await fetch(base + '/api/me', { headers: { cookie } })).json();
  const headers = { cookie, Origin: 'http://127.0.0.1', 'X-CSRF-Token': me.csrf };
  assert.equal((await fetch(base + '/api/files', { headers })).status, 200);
  assert.equal(lastRunner.value.user, createHash('sha256').update('user-1').digest('hex'));
  for (const path of ['/api/chats/rename', '/api/chats/pin', '/api/chats/archive', '/api/files/upload']) {
    const value = JSON.stringify({ user: 'forged', thread: '11111111-1111-4111-8111-111111111111', title: 'test', content: 'test', path: 'test.txt' });
    assert.equal((await fetch(base + path, { method: 'POST', headers: { cookie }, body: value })).status, 403);
    assert.equal((await fetch(base + path, { method: 'POST', headers, body: value })).status, 200);
    assert.notEqual(lastRunner.value.user, 'forged');
  }
  assert.equal((await fetch(base + '/js/main.js', { headers })).status, 200);
  assert.equal((await fetch(base + '/js/missing.js', { headers })).status, 404);
  assert.equal((await fetch(base + '/js/main.js', { redirect: 'manual' })).status, 302);
  granted = false;
  assert.equal((await fetch(base + '/api/files', { headers })).status, 403);
  assert.equal((await fetch(base + '/api/chats/export', { headers })).status, 403);
  admin = true;
});

import { createServer } from 'node:http';
import { createHmac, createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { body, equal, fail, json, required } from './shared.mjs';

const publicURL = new URL(required('PUBLIC_URL')).origin;
const homepage = new URL(required('HOMEPAGE_URL')).origin;
const secret = required('HOMEPAGE_CLIENT_SECRET');
const runnerSecret = required('RUNNER_SECRET');
const runnerURL = process.env.RUNNER_URL || 'http://runner:8081';
if (secret.length < 32 || runnerSecret.length < 32) throw new Error('Secrets must be at least 32 characters');
const secure = process.env.SECURE_COOKIES !== 'false';
const cookieName = secure ? '__Host-copylee_ai' : 'copylee_ai';
const flowName = secure ? '__Host-copylee_ai_flow' : 'copylee_ai_flow';
const sign = value => createHmac('sha256', secret).update(value).digest('base64url');
const csrf = token => sign('csrf:' + token);
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(s => {
  const i = s.indexOf('='); return [s.slice(0, i).trim(), s.slice(i + 1)];
}));
const cookie = (name, value, age) => `${name}=${value}; Path=/; Max-Age=${age}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
function redirect(res, location, setCookies = []) {
  res.writeHead(302, { Location: location, 'Set-Cookie': setCookies }); res.end();
}
async function sso(path, value) {
  let response;
  try {
    response = await fetch(homepage + '/api/agent' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Client-Secret': secret },
      body: JSON.stringify(value), signal: AbortSignal.timeout(10000), redirect: 'error',
    });
  } catch { fail(503, '账户服务暂时不可用，请稍后重试'); }
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    fail([401, 403, 404, 409, 422].includes(response.status) ? response.status : 502,
      typeof error.detail === 'string' ? error.detail : '账户服务请求失败，请重试');
  }
  return response.json();
}
async function identity(req) {
  const token = cookies(req)[cookieName];
  if (!token || !/^[A-Za-z0-9_-]{40,128}$/.test(token)) fail(401, '请先登录');
  return { ...await sso('/introspect', { token }), token };
}
function writeAccess(req, auth) {
  if (req.headers.origin !== publicURL || !equal(req.headers['x-csrf-token'], csrf(auth.token))) fail(403, '请求校验失败');
}
async function runner(path, user, payload, signal) {
  const response = await fetch(runnerURL + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Runner-Secret': runnerSecret },
    body: JSON.stringify({ ...payload, user: createHash('sha256').update(user).digest('hex') }),
    signal: signal || AbortSignal.timeout(45000), redirect: 'error',
  });
  if (!response.ok) {
    const value = await response.json().catch(() => ({}));
    fail(response.status, value.error || 'Agent 服务暂时不可用');
  }
  return response;
}
const assets = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']], ['/tokens.css', ['tokens.css', 'text/css']]]);

export const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const url = new URL(req.url, publicURL);
    if (url.pathname === '/healthz' && req.method === 'GET') return json(res, 200, { ok: true });
    if (url.pathname === '/auth/login' && req.method === 'GET') {
      const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
      const data = Buffer.from(JSON.stringify({ state, verifier, expires: Date.now() + 600000 })).toString('base64url');
      const target = new URL(homepage + '/api/agent/authorize');
      target.searchParams.set('state', state);
      target.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
      return redirect(res, target.href, [cookie(flowName, data + '.' + sign(data), 600)]);
    }
    if (url.pathname === '/auth/callback' && req.method === 'GET') {
      const [data, signature] = (cookies(req)[flowName] || '').split('.');
      if (!data || !signature || !equal(signature, sign(data))) fail(400, '登录流程已失效，请重新开始');
      const flow = JSON.parse(Buffer.from(data, 'base64url').toString());
      if (flow.expires < Date.now() || !equal(flow.state, url.searchParams.get('state'))) fail(400, '登录流程校验失败');
      const result = await sso('/exchange', { code: url.searchParams.get('code'), verifier: flow.verifier });
      return redirect(res, '/', [cookie(cookieName, result.token, Math.max(0, Math.floor(result.expires_at - Date.now() / 1000))), cookie(flowName, '', 0)]);
    }
    if (url.pathname === '/auth/check' && req.method === 'GET') {
      try { await identity(req); res.writeHead(204); return res.end(); }
      catch (error) {
        if (error.status !== 401) throw error;
        if ((req.headers['x-forwarded-uri'] || '').startsWith('/api/')) return json(res, 401, { error: '请重新登录' });
        return redirect(res, '/auth/login');
      }
    }
    const auth = await identity(req);
    if (url.pathname === '/api/me' && req.method === 'GET') {
      return json(res, 200, { user: auth.user, admin: auth.admin, can_execute: auth.can_execute,
        grant_expires_at: auth.grant_expires_at, csrf: csrf(auth.token), model: process.env.PI_MODEL || 'opencode-go/deepseek-v4.1-flash' });
    }
    if (url.pathname === '/auth/logout' && req.method === 'POST') {
      writeAccess(req, auth); await sso('/revoke', { token: auth.token });
      res.setHeader('Set-Cookie', cookie(cookieName, '', 0)); return json(res, 200, { ok: true });
    }
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname.startsWith('/api/grants')) {
        if (!auth.admin) fail(403, '仅管理员可管理执行授权');
        if (url.pathname === '/api/grants' && req.method === 'GET') return json(res, 200, await sso('/grants/list', { token: auth.token }));
        if (url.pathname === '/api/grants/save' && req.method === 'POST') {
          writeAccess(req, auth); const input = await body(req);
          const result = await sso('/grants/save', { token: auth.token, user_id: input.user_id, days: input.days });
          // SSO commit is authoritative; active gateways also recheck on each heartbeat.
          if (input.days === 0) await runner('/cancel', input.user_id, {});
          return json(res, 200, result);
        }
        fail(404, '接口不存在');
      }
      if (!auth.can_execute) fail(403, '此账户尚未获得 Agent 执行权限');
      if (url.pathname.startsWith('/api/providers') && !auth.admin) fail(403, '仅管理员可管理供应商');
      if (url.pathname === '/api/chats' && req.method === 'GET') {
        const response = await runner('/chats', auth.user.id, {}); return json(res, 200, await response.json());
      }
      if (url.pathname === '/api/providers' && req.method === 'GET') {
        const response = await runner('/providers', auth.user.id, {}); return json(res, 200, await response.json());
      }
      if (url.pathname === '/api/session' && req.method === 'GET') {
        const response = await runner('/session', auth.user.id, { thread: url.searchParams.get('chat') }); return json(res, 200, await response.json());
      }
      if (req.method !== 'POST') fail(405, '请求方法不支持');
      writeAccess(req, auth);
      const input = await body(req);
      if (['/api/providers/test', '/api/providers/save'].includes(url.pathname)) {
        const response = await runner(url.pathname.replace('/api', ''), auth.user.id, { config: input.config });
        return json(res, 200, await response.json());
      }
      if (url.pathname === '/api/abort') {
        const response = await runner('/abort', auth.user.id, { thread: input.thread }); return json(res, 200, await response.json());
      }
      if (url.pathname === '/api/prompt') {
        if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 20000) fail(422, '请输入 1–20000 个字符的任务');
        const abort = new AbortController();
        res.once('close', () => abort.abort());
        let checking = false;
        const timer = setInterval(async () => {
          if (checking) return; checking = true;
          try {
            const current = await identity(req);
            if (!current.can_execute) abort.abort();
            else await runner('/renew', auth.user.id, {});
          } catch { abort.abort(); }
          finally { checking = false; }
        }, 5000);
        try {
          const response = await runner('/prompt', auth.user.id, { message: input.message, thread: input.thread }, abort.signal);
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'X-Accel-Buffering': 'no' });
          await pipeline(Readable.fromWeb(response.body), res);
        } finally { clearInterval(timer); await runner('/cancel', auth.user.id, {}).catch(() => {}); }
        return;
      }
      fail(404, '接口不存在');
    }
    const asset = assets.get(url.pathname);
    if (!asset || req.method !== 'GET') fail(404, '页面不存在');
    res.writeHead(200, { 'Content-Type': asset[1] + '; charset=utf-8' });
    res.end(await readFile(new URL('./web/' + asset[0], import.meta.url)));
  } catch (error) {
    if (res.headersSent) return res.destroy();
    if (error.status === 401 && !req.url.startsWith('/api/')) return redirect(res, '/auth/login');
    json(res, error.status || 503, { error: error.status ? error.message : '服务暂时不可用，请稍后重试' });
  }
});
if (process.env.NODE_ENV !== 'test') server.listen(Number(process.env.PORT || 8080), '0.0.0.0');

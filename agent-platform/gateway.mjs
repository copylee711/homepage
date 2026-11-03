import { promptInput } from './prompt-input.mjs';
import { createServer } from 'node:http';
import { createHmac, createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { body, equal, fail, json, modelLabel, required } from './shared.mjs';
import { widgetDocument, WIDGET_CSP } from './widget-document.mjs';
const widgets = new Map();

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
const identityRequests = new Map();
async function identity(req) {
  const token = cookies(req)[cookieName];
  if (!token || !/^[A-Za-z0-9_-]{40,128}$/.test(token)) fail(401, '请先登录');
  // Coalesce concurrent asset/API checks only; retain no completed authorization.
  const key = createHash('sha256').update(token).digest('hex');
  let pending = identityRequests.get(key);
  if (!pending) {
    pending = sso('/introspect', { token });
    if (identityRequests.size < 256) identityRequests.set(key, pending);
    pending.finally(() => { if (identityRequests.get(key) === pending) identityRequests.delete(key); }).catch(() => {});
  }
  return { ...await pending, token };
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
// The console is a Vite SPA built into web/dist. Serve hashed assets with long
// cache; everything else falls back to index.html (client-side app, no routing).
const distRoot = new URL('./web/dist/', import.meta.url);
const mimeByExt = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.map': 'application/json',
};
function distAsset(pathname) {
  // Only serve real files under dist; reject traversal. Unknown paths → SPA shell.
  const clean = pathname.replace(/\?.*$/, '');
  if (clean === '/' || !/^\/[A-Za-z0-9._\-/]+$/.test(clean) || clean.includes('..')) return null;
  const ext = clean.slice(clean.lastIndexOf('.'));
  if (!mimeByExt[ext]) return null;
  return { rel: clean.replace(/^\//, ''), type: mimeByExt[ext], immutable: clean.startsWith('/assets/') };
}
const modelCache = { label: '', expires: 0 };
async function modelName(user) {
  if (Date.now() < modelCache.expires) return modelCache.label;
  try {
    const response = await runner('/model', user, {}, AbortSignal.timeout(2000));
    const value = await response.json();
    if (typeof value.label === 'string' && value.label) modelCache.label = value.label;
  } catch {}
  if (!modelCache.label) modelCache.label = modelLabel(process.env.PI_MODEL || '');
  modelCache.expires = Date.now() + 30000;
  return modelCache.label;
}
function filePath(url) {
  const value = url.searchParams.get('path') || '';
  if (value.length > 1024 || /[\u0000\r\n]/.test(value)) fail(422, '工作区路径无效');
  return value;
}
function downloadName(value) {
  const name = String(value || '').replace(/[\\/\u0000-\u001f\u007f"]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120);
  return name && !/^[. ]+$/.test(name) ? name : 'agent-export';
}
function attachment(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
function sendFile(res, file, inline = false) {
  const buffer = Buffer.from(file.data || '', 'base64');
  const ext = (file.name || '').slice((file.name || '').lastIndexOf('.')).toLowerCase();
  const type = mimeByExt[ext] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Content-Length': buffer.length };
  if (!inline) {
    headers['Content-Disposition'] = attachment(downloadName(file.name));
  } else {
    headers['Content-Disposition'] = 'inline';
    headers['Cache-Control'] = 'private, max-age=300';
  }
  res.writeHead(200, headers);
  res.end(buffer);
}
function sendExport(res, value) {
  const name = downloadName(value.filename);
  const content = Buffer.from(String(value.content || ''), 'utf8');
  res.writeHead(200, { 'Content-Type': value.contentType || 'application/octet-stream; charset=utf-8',
    'Content-Length': content.length, 'Content-Disposition': attachment(name) });
  res.end(content);
}

export const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const url = new URL(req.url, publicURL);
      if (url.pathname.startsWith('/preview/')) {
        if (req.method !== 'GET') fail(405, '预览仅支持 GET');
        const match = url.pathname.match(/^\/preview\/([A-Za-z0-9_-]{43})(\/.*)?$/);
        if (!match) fail(404, '预览链接无效');
        const response = await runner('/background/preview', 'preview-capability', { token: match[1], path: (match[2] || '/') + url.search });
        const value = await response.json();
        let data = Buffer.from(value.data || '', 'base64');
        if (data.length > 2 * 1024 * 1024) fail(413, '预览资源过大');
        if ([301, 302, 303, 307, 308].includes(value.status)) {
          const location = String(value.location || '');
          if (!location.startsWith('/') || location.startsWith('//')) fail(502, '预览重定向已阻止');
          const prefix = '/preview/' + match[1] + '/';
          res.writeHead(302, { Location: location.startsWith(prefix) ? location : prefix.slice(0, -1) + location }); return res.end();
        }
        // Bearer preview links are short-lived and scoped to one task. A CSP
        // sandbox gives active preview documents an opaque origin: they cannot
        // read Iris cookies/storage or call authenticated Iris APIs as the user.
        res.setHeader('Content-Security-Policy', "sandbox allow-scripts allow-forms; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src * data: blob:; connect-src 'self' ws: wss:; object-src 'none'; frame-ancestors 'self'");
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.writeHead(value.status >= 100 && value.status <= 599 ? value.status : 502, { 'Content-Type': value.contentType || 'application/octet-stream' });
        return res.end(data);
      }
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
    if (url.pathname === '/api/avatar' && req.method === 'GET') {
      const avatarPath = typeof auth.user?.avatar === 'string' ? auth.user.avatar.trim() : '';
      if (!avatarPath || !/^\/media\/avatars\/[A-Za-z0-9._-]+\.(webp|png|jpe?g|gif)$/i.test(avatarPath)) {
        fail(404, '暂无头像');
      }
      try {
        const target = new URL(avatarPath, homepage);
        const response = await fetch(target, { signal: AbortSignal.timeout(6000) });
        if (!response.ok) fail(404, '头像文件不存在');
        const ctype = response.headers.get('content-type') || 'image/webp';
        const buffer = Buffer.from(await response.arrayBuffer());
        res.writeHead(200, {
          'Content-Type': ctype,
          'Content-Length': buffer.length,
          'Cache-Control': 'private, max-age=3600',
        });
        return res.end(buffer);
      } catch {
        fail(404, '无法读取头像');
      }
    }
    if (url.pathname === '/api/me' && req.method === 'GET') {
      const user = auth.user ? { ...auth.user } : null;
      if (user && user.avatar) user.avatar = '/api/avatar';
      return json(res, 200, { user, admin: auth.admin, can_execute: auth.can_execute,
        grant_expires_at: auth.grant_expires_at, csrf: csrf(auth.token), model: await modelName(auth.user.id) });
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
      if (url.pathname === '/api/toolchains' && req.method === 'GET') {
        const response = await runner('/toolchains', auth.user.id, {}); return json(res, 200, await response.json());
      }
      if (url.pathname.startsWith('/api/packages') && !auth.admin) fail(403, '仅管理员可管理扩展');
      if (url.pathname.startsWith('/api/quotas') && !auth.admin) fail(403, '仅管理员可分配沙箱配额');
      if (url.pathname === '/api/quotas' && req.method === 'GET') {
        const response = await runner('/quotas', auth.user.id, { target: url.searchParams.get('user_id') }); return json(res, 200, await response.json());
      }
      if (url.pathname === '/api/packages' && req.method === 'GET') {
        const response = await runner('/packages', auth.user.id, { query: url.searchParams.get('q') || '' }); return json(res, 200, await response.json());
      }
      if (url.pathname === '/api/projects' && req.method === 'GET') {
        const response = await runner('/projects', auth.user.id, {}); return json(res, 200, await response.json());
      }
      if (url.pathname === '/api/chats' && req.method === 'GET') {
        const response = await runner('/chats', auth.user.id, {}); return json(res, 200, await response.json());
      }
      if (url.pathname === '/api/chats/export' && req.method === 'GET') {
        const response = await runner('/chats/export', auth.user.id, { thread: url.searchParams.get('chat'),
          format: url.searchParams.get('format') === 'json' ? 'json' : 'md' });
        return sendExport(res, await response.json());
      }
      if (url.pathname === '/api/files' && req.method === 'GET') {
        const response = await runner('/files/list', auth.user.id, { path: filePath(url), fresh: url.searchParams.get('fresh') === '1' }); return json(res, 200, await response.json());
      }
      if (url.pathname === '/api/files/preview' && req.method === 'GET') {
        const response = await runner('/files/preview', auth.user.id, { path: filePath(url), limit: Number(url.searchParams.get('limit')) || 65536, fresh: url.searchParams.get('fresh') === '1' });
        return json(res, 200, await response.json());
      }
      if (url.pathname === '/api/files/download' && req.method === 'GET') {
        const response = await runner('/files/download', auth.user.id, { path: filePath(url) });
        return sendFile(res, await response.json(), url.searchParams.get('inline') === '1');
      }
      if (url.pathname === '/api/providers' && req.method === 'GET') {
        const response = await runner('/providers', auth.user.id, {}); return json(res, 200, await response.json());
      }
      if (url.pathname === '/api/greeting' && req.method === 'GET') {
        const response = await runner('/greeting', auth.user.id, {}); return json(res, 200, await response.json());
      }
      if (url.pathname === '/api/widget-document' && req.method === 'GET') {
        const item=widgets.get(url.searchParams.get('id'));if(!item||item.user!==auth.user.id||item.expires<Date.now())fail(404,'组件已过期，请重新运行');
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':WIDGET_CSP,'X-Frame-Options':'SAMEORIGIN'});return res.end(widgetDocument(item.html));
      }
      if (url.pathname === '/api/image' && req.method === 'GET') {
        const response=await runner('/image',auth.user.id,{url:url.searchParams.get('url'),path:url.searchParams.get('path')},AbortSignal.timeout(45000));
        const value=await response.json();if(!['image/png','image/jpeg','image/gif','image/webp','image/svg+xml'].includes(value.mime))fail(415,'图片格式不支持');
        res.writeHead(200,{'Content-Type':value.mime,'Cache-Control':'private, max-age=300','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; sandbox"});return res.end(Buffer.from(value.data,'base64'));
      }
      if (url.pathname === '/api/search/settings' && req.method === 'GET') {
        const response = await runner('/search/settings', auth.user.id, {}); return json(res, 200, await response.json());
      }
      if (url.pathname === '/api/features' && req.method === 'GET') { const response = await runner('/features', auth.user.id, {}); return json(res, 200, await response.json()); }
      if (url.pathname === '/api/context/stats' && req.method === 'GET') { const response = await runner('/context/stats', auth.user.id, { thread:url.searchParams.get('chat') }); return json(res, 200, await response.json()); }
      if (url.pathname === '/api/memory' && req.method === 'GET') {
        const response = await runner('/memory', auth.user.id, { project: url.searchParams.get('project') || 'default' }); return json(res, 200, await response.json());
      }
      if (url.pathname === '/api/background' && req.method === 'GET') {
        const response = await runner('/background/list', auth.user.id, { id: url.searchParams.get('id') || undefined }); return json(res, 200, await response.json());
      }
      if (url.pathname === '/api/session' && req.method === 'GET') {
        const response = await runner('/session', auth.user.id, { thread: url.searchParams.get('chat') }); return json(res, 200, await response.json());
      }
      if (url.pathname === '/api/git/status' && req.method === 'GET') {
        const response = await runner('/git/status', auth.user.id, { project: url.searchParams.get('project') || 'default' });
        return json(res, 200, await response.json());
      }
      if (req.method !== 'POST') fail(405, '请求方法不支持');
      writeAccess(req, auth);
      if(url.pathname==='/api/widgets'){
        const input=await body(req,128*1024);if(typeof input.html!=='string'||Buffer.byteLength(input.html)>64000)fail(422,'组件内容最多 64 KiB');
        const id=createHmac('sha256',secret).update(auth.user.id+'\0'+input.html).digest('hex');
        for(const [key,item]of widgets)if(item.expires<Date.now())widgets.delete(key);
        widgets.delete(id);widgets.set(id,{user:auth.user.id,html:input.html,expires:Date.now()+3600000});
        const own=[...widgets].filter(([,item])=>item.user===auth.user.id);while(own.length>16)widgets.delete(own.shift()[0]);
        while(widgets.size>128)widgets.delete(widgets.keys().next().value);
        return json(res,200,{url:'/api/widget-document?id='+id});
      }
      if (url.pathname === '/api/files/upload') {
        const input = await body(req, 21 * 1024 * 1024);
        if (typeof input.path !== 'string' || !input.path || input.path.length > 1024 || /[\u0000\r\n]/.test(input.path)) fail(422, '工作区路径无效');
        if (typeof input.content !== 'string') fail(422, '请选择文件内容');
        const isBase64 = input.encoding === 'base64';
        if (isBase64) {
          const byteLen = Math.floor(input.content.length * 0.75);
          if (byteLen > 15 * 1024 * 1024) fail(413, '上传文件不能超过 15 MiB');
        } else {
          if (Buffer.byteLength(input.content, 'utf8') > 256 * 1024) fail(413, '上传文件不能超过 256 KiB');
          if (input.content.includes('\u0000')) fail(422, '暂不支持上传二进制文件');
        }
        const response = await runner('/files/upload', auth.user.id, {
          path: input.path,
          content: input.content,
          encoding: input.encoding,
          overwrite: input.overwrite === true,
          revision: input.revision,
        });
        return json(res, 200, await response.json());
      }
      const input = await body(req, url.pathname === '/api/prompt' ? 15 * 1024 * 1024 : url.pathname === '/api/features/save' ? 256 * 1024 : url.pathname === '/api/search/settings/save' ? 512 * 1024 : 65536);
      if (['/api/features/save','/api/features/mcp/test','/api/context/compact'].includes(url.pathname)) { const response = await runner(url.pathname.replace('/api',''), auth.user.id, {config:input.config,id:input.id,thread:input.thread,instructions:input.instructions}, AbortSignal.timeout(190000));return json(res,200,await response.json()); }
      if (url.pathname === '/api/memory/update') {
        const response = await runner('/memory/update', auth.user.id, { project: input.project, scope: input.scope, action: input.action, content: input.content, revision: input.revision }); return json(res, 200, await response.json());
      }
      if (url.pathname === '/api/background/stop') {
        const response = await runner('/background/stop', auth.user.id, { id: input.id }); return json(res, 200, await response.json());
      }
      if (['/api/questions/answer', '/api/steer', '/api/search/settings/save', '/api/search/test'].includes(url.pathname)) {
          const response = await runner(url.pathname.replace('/api', ''), auth.user.id, { thread: input.thread, id: input.id, answer: input.answer, message: input.message, config: input.config, query: input.query, category:input.category,source:input.source }, AbortSignal.timeout(55000));
        return json(res, 200, await response.json());
      }
      if (url.pathname === '/api/approvals/resolve') {
        const response = await runner('/approvals/resolve', auth.user.id, { thread: input.thread, id: input.id, allow: input.allow });
        return json(res, 200, await response.json());
      }
      if (url.pathname === '/api/quotas/save') {
        const response = await runner('/quotas/save', auth.user.id, { target: input.user_id, quota: input.quota }, AbortSignal.timeout(135000));
        return json(res, 200, await response.json());
      }
      if (url.pathname === '/api/toolchains/change') {
        const response = await runner('/toolchains/change', auth.user.id, { id: input.id, action: input.action, version: input.version });
        return json(res, 200, await response.json());
      }
      if (url.pathname === '/api/toolchains/cancel') {
        const response = await runner('/cancel', auth.user.id, {}); return json(res, 200, await response.json());
      }
      if (url.pathname === '/api/packages/change') {
        const response = await runner('/packages/change', auth.user.id, { name: input.name, version: input.version, action: input.action });
        return json(res, 200, await response.json());
      }
      if (url.pathname === '/api/files/manage') {
        const response = await runner('/files/manage', auth.user.id, { action: input.action, path: input.path, destination: input.destination });
        return json(res, 200, await response.json());
      }
      if (['/api/providers/test', '/api/providers/models', '/api/providers/save'].includes(url.pathname)) {
        const response = await runner(url.pathname.replace('/api', ''), auth.user.id, { config: input.config });
        if (url.pathname === '/api/providers/save') modelCache.expires = 0;
        return json(res, 200, await response.json());
      }
      if (url.pathname === '/api/providers/delete') {
        const response = await runner('/providers/delete', auth.user.id, { id: input.id });
        modelCache.expires = 0;
        return json(res, 200, await response.json());
      }
      if (url.pathname === '/api/providers/activate') {
        const response = await runner('/providers/activate', auth.user.id, { id: input.id, model: input.model });
        modelCache.expires = 0;
        return json(res, 200, await response.json());
      }

      if (['/api/chats/rename', '/api/chats/pin', '/api/chats/archive', '/api/chats/delete', '/api/chats/fork', '/api/chats/truncate', '/api/chats/project', '/api/chats/permission', '/api/projects/create', '/api/projects/rename', '/api/projects/delete', '/api/terminal/exec', '/api/git/status', '/api/git/checkout'].includes(url.pathname)) {
        const response = await runner(url.pathname.replace('/api', ''), auth.user.id, input);
        return json(res, 200, await response.json());
      }
      if (url.pathname === '/api/abort') {
        const response = await runner('/abort', auth.user.id, { thread: input.thread }); return json(res, 200, await response.json());
      }
      if (url.pathname === '/api/prompt') {
        const prompt=promptInput(input);
        const validThinking = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
        const thinking = typeof input.thinking === 'string' && validThinking.includes(input.thinking) ? input.thinking : undefined;
        const images=prompt.images;
        const abort = new AbortController();
        res.once('close', () => abort.abort());
        let checking = false, consecutiveFailures = 0;
        const timer = setInterval(async () => {
          if (checking) return; checking = true;
          try {
            const current = await identity(req);
            if (!current.can_execute) abort.abort();
            else {
              await runner('/renew', auth.user.id, {});
              consecutiveFailures = 0;
            }
          } catch {
            consecutiveFailures++;
            if (consecutiveFailures >= 5) abort.abort();
          }
          finally { checking = false; }
        }, 10000);
        try {
          const response = await runner('/prompt', auth.user.id, { message: input.message, images, thread: input.thread, thinking, projectId: input.projectId, permission: input.permission }, abort.signal);
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'X-Accel-Buffering': 'no' });
          await pipeline(Readable.fromWeb(response.body), res);
        } finally { clearInterval(timer); await runner('/cancel', auth.user.id, {}).catch(() => {}); }
        return;
      }
      fail(404, '接口不存在');
    }
    if (req.method !== 'GET') fail(404, '页面不存在');
    const asset = distAsset(url.pathname);
    if (asset) {
      let data;
      try { data = await readFile(new URL(asset.rel, distRoot)); }
      catch (error) { if (error.code === 'ENOENT') fail(404, '页面不存在'); throw error; }
      const headers = { 'Content-Type': asset.type.startsWith('text/') || asset.type === 'application/json' ? asset.type + '; charset=utf-8' : asset.type };
      // Hashed build assets are immutable; the shell and other files stay no-store.
      headers['Cache-Control'] = asset.immutable ? 'public, max-age=31536000, immutable' : 'no-store';
      res.writeHead(200, headers);
      return res.end(data);
    }
    // SPA fallback: any non-asset GET renders the app shell.
    const shell = await readFile(new URL('index.html', distRoot));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(shell);
  } catch (error) {
    if (res.headersSent) return res.destroy();
    if (error.status === 401 && !req.url.startsWith('/api/')) return redirect(res, '/auth/login');
    json(res, error.status || 503, { error: error.status ? error.message : '服务暂时不可用，请稍后重试' });
  }
});
if (process.env.NODE_ENV !== 'test') server.listen(Number(process.env.PORT || 8080), '0.0.0.0');

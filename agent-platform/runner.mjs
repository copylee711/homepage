import { promptInput } from './prompt-input.mjs';
import { WebSession } from './web-session.mjs';
import { FeatureStore, publicFeatures, mcpToolName } from './features.mjs';
import { McpConnections } from './mcp.mjs';
import { MemoryStore, memoryContext } from './memory.mjs';
import { requiresApproval } from './execution-policy.mjs';
import { streamEvent } from './stream-wire.mjs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { body, equal, fail, json, modelLabel, required } from './shared.mjs';
import { TurnFanout } from './turn-stream.mjs';
import { publicProviders, saveProvider, deleteProvider, activeProvider, activateProvider, testProvider, discoverProviderModels, proxyEnvironment, loadProviders } from './providers.mjs';
import { sandbox, sandboxTool } from './sandbox-client.mjs';
import { sessionCapacity } from './session-limits.mjs';
import { prepareSessionCwd } from './session-cwd.mjs';
import { ChatStore, normalizeProjectId, sanitizePermission } from './conversations.mjs';
import { SearchSettings, publicSearch } from './search.mjs';
import { ToolApprovals, UserQuestions } from './tool-approvals.mjs';
import { SessionSnapshots, projectSession } from './session-snapshot.mjs';
import { packageCatalog, changePackage, packageArguments, packageTextFiles } from './packages.mjs';
import { toolchainBusy, toolchainStatus, startToolchain, renewToolchain, cancelToolchain } from './toolchains.mjs';
import { listWorkspace, previewWorkspace, downloadWorkspace, uploadWorkspace, manageWorkspace, invalidateWorkspace } from './workspace.mjs';

const secret = required('RUNNER_SECRET');
const sessions = new Map();
const searchSettings = new SearchSettings();
const memories = new MemoryStore();
const features = new FeatureStore();
const deleting = new Set();
const chats = new ChatStore({ sessionsRoot: '/data/sessions', metaRoot: '/data/chat-meta' });
const snapshots = new SessionSnapshots(chats, projectSession);
// Pay the SDK import cost at service startup, before readiness, never on a click.
await projectSession('');
let configuring = false;
const model = process.env.PI_MODEL || 'opencode-go/deepseek-v4.1-flash';
function sameScope(a, b) { return (a?.scope || 'project_only') === (b?.scope || 'project_only') && JSON.stringify(Object.entries(a?.extraProjects || {}).sort()) === JSON.stringify(Object.entries(b?.extraProjects || {}).sort()); }
async function secretValues() {
  return [(process.env.OPENCODE_API_KEY || ''), ...(await loadProviders()).providers.map(item => item.apiKey || '')]
    .filter(key => key.length >= 8);
}
async function searchWeb(lease, config, input) {
  const image = input.category === 'image';
  const count = input.count ?? config.count;
  const request = { op: 'web-search', ...config, query: input.query, count };
  try {
    return await sandboxTool(lease, { ...request, category: image ? 'image' : 'web', engine: image ? config.imageEngine : config.engine }, 45000);
  } catch (error) {
    if (!image || !config.sources.some(source => source.enabled && source.category === 'image')) throw error;
    // Open-license image indexes are sparse for niche queries. Inspect a few
    // already-ranked source pages through the same public-only broker.
    const web = await sandboxTool(lease, { ...request, category: 'web', engine: config.engine, count: 3 }, 20000);
    const pages = await Promise.allSettled(web.results.slice(0, 3).map(result =>
      sandboxTool(lease, { op: 'web-fetch', url: result.url }, 20000)));
    const images = new Map();
    for (const page of pages) {
      if (page.status !== 'fulfilled') continue;
      for (const item of page.value.images || []) {
        if (!item.alt?.trim() || images.has(item.url)) continue;
        images.set(item.url, { ...item, title: item.alt, provider: 'source-page' });
      }
    }
    if (!images.size) throw error;
    const candidates = [...images.values()].slice(0, count);
    return { engine: 'source-page', images: candidates, results: candidates,
      notice: '这些是网页中的候选图。核对图片与主题的相关性，附原网页链接。授权情况未知。' };
  }
}
class Pi {
  constructor(user, thread) {
    this.runtimeToken = randomUUID(); this.user = user; this.thread = thread; this.key = user + ':' + thread; this.pending = new Map(); this.busy = false; this.buffer = '';
    const reply = event => { if (this.proc?.stdin.writable) this.proc.stdin.write(JSON.stringify(event) + '\n'); };
    const emit = event => { this.publish(streamEvent(event)); };
    this.disk = Promise.resolve();
    this.questions = new UserQuestions(reply, emit);
    this.mcp = new McpConnections(value => sandboxTool(this.lease, value, 45000));
    this.approvals = new ToolApprovals(reply, emit);
  }
  async start() {
    // Never mount or load instructions/extensions from an untrusted tool workspace.
    const cwd = `/tmp/pi/${this.user}`;
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    await mkdir(`/data/sessions/${this.user}`, { recursive: true, mode: 0o700 });
    await prepareSessionCwd(`/data/sessions/${this.user}/${this.thread}.jsonl`, cwd);
    const config = await activeProvider();
    const meta = await chats.loadMeta(this.user);
    const chatItem = meta.chats[this.thread] || {};
    const projectId = chatItem.projectId || 'default';
    this.projectId = projectId;
    const permission = chatItem.permission || { scope: 'project_only', extraProjects: {} };
    this.execution = ['auto', 'edit'].includes(permission.execution) ? permission.execution : 'ask';
    this.secrets = await secretValues();
    this.lease = (await sandbox('/lease', this.user, undefined, { project: projectId, ...permission })).token;
    await sandboxTool(this.lease, { op: 'mkdir', path: `/workspace/${projectId}` });
    const env = proxyEnvironment(config.proxy); delete env.RUNNER_SECRET; delete env.SANDBOX_SECRET;
    env.SANDBOX_URL = process.env.SANDBOX_URL || 'http://192.168.84.1:18082';
    env.SANDBOX_LEASE = this.lease;
    env.IRIS_RUNTIME_TOKEN = this.runtimeToken;
    env.PI_PROJECT = projectId;
    env.PI_PERMISSION = JSON.stringify(permission);
    const personalSkills = await features.skills(this.user);
    env.PI_PACKAGE_TEXT_FILES = JSON.stringify([...await packageTextFiles(), ...personalSkills.files]);
    env.PI_OFFLINE = '1';
    // Private broker traffic must never use the model's Mihomo proxy.
    env.NO_PROXY = env.no_proxy = '127.0.0.1,localhost,192.168.84.1';
    this.proc = spawn('pi', ['--mode', 'rpc', '--model', config.id + '/' + config.model, '--session', `/data/sessions/${this.user}/${this.thread}.jsonl`,
      '--no-builtin-tools', '--no-extensions', '--no-mcp', '--no-context-files', '-e', '/opt/pi/sandbox-extension.ts',
      '--no-skills', '--no-prompt-templates', '--no-themes', ...await packageArguments(), ...personalSkills.args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stderr.on('data', () => {}); // Diagnostics can contain provider details; never log them.
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', chunk => {
      this.buffer += chunk;
      if (this.buffer.length > 8 * 1024 * 1024) return this.proc.kill();
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (this.busy) { this.approvals.capture(event); this.questions.capture(event); setImmediate(() => this.approvals.allowPending(tool => !requiresApproval(this.execution, tool))); }
        if (event.type === 'response') {
          const wait = this.pending.get(event.id);
          if (wait) { this.pending.delete(event.id); clearTimeout(wait.timer); event.success ? wait.resolve(event.data) : wait.reject(Object.assign(new Error(event.error || 'Pi 请求失败'), { status: 502 })); }
        }
        if (this.fanout) {
          // Delta events contain a growing full-message snapshot in the SDK.
          // The browser reducer only needs the delta: avoid quadratic wire traffic.
          const wire = event.type === 'message_update' ? {type:event.type,assistantMessageEvent:{...event.assistantMessageEvent}} : event;
          if(wire.type === 'message_update') { delete wire.assistantMessageEvent.partial; delete wire.assistantMessageEvent.message; }
          this.publish(wire);
        }
        if (event.type === 'agent_settled') this.finish();
      }
    });
    this.proc.on('error', () => this.stop());
    this.proc.on('exit', () => this.stop());
    await this.command('get_state');
    await this.command('set_auto_compaction', { enabled: (await features.get(this.user)).autoCompaction });
  }
  stop() {
    this.finish(); if (sessions.get(this.key)?.pi === this) sessions.delete(this.key);
    for (const wait of this.pending.values()) { clearTimeout(wait.timer); wait.reject(Object.assign(new Error('Pi 进程已退出，请重试'), { status: 503 })); }
    this.pending.clear();
  }
  mask(text) { for (const key of this.secrets || []) text = text.split(key).join('[REDACTED]'); return text; }
  publish(event) {
    if (!this.fanout || !event) return;
    const line = this.mask(JSON.stringify(event, (_key, value) =>
      value?.type === 'image' && typeof value.data === 'string'
        ? { type: 'text', text: '[图片已交给模型]' } : value)) + '\n';
    this.fanout.publish(line);
    this.persist(line);
  }
  persist(line) {
    if (!this.turnFile || this.persisted > 8 * 1024 * 1024) return;
    this.persisted += line.length;
    const file = this.turnFile;
    this.disk = this.disk.then(() => appendFile(file, line)).catch(() => {});
  }
  abortTurn() {
    // Policy stop: deadline, storage cap, or lost renew. Not a browser disconnect.
    if (!this.busy || this.stopping) return;
    this.stopping = true;
    void cancel(this.user, { stopInstalls: true }).catch(() => { try { this.proc?.kill(); } catch { /* already gone */ } });
  }
  finish() {
    this.approvals.clear(); this.questions.clear();
    invalidateWorkspace(this.user);
    clearTimeout(this.deadline); clearInterval(this.storageCheck); clearInterval(this.renewWatch);
    this.busy = false;
    this.fanout?.end();
  }
  command(type, fields = {}, timeout = 120000) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error('Pi 响应超时'), { status: 504 })); this.proc.kill(); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ id, type, ...fields }) + '\n', error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(Object.assign(new Error('Pi 输入已关闭'), { status: 503 })); }
      });
    });
  }
  async prompt(res, message, thinking, images, permission) {
    if (this.maintenance) fail(409, '正在压缩此对话');
    if (deleting.has(this.key)) fail(409, '正在删除此对话');
    invalidateWorkspace(this.user);
    if (this.busy) fail(409, '当前任务尚未结束，请先停止或等待完成');
    if ([...sessions.values()].some(entry => entry.pi !== this && entry.pi.user === this.user && entry.pi.busy)) fail(409, '每个用户同时只能运行一个任务');
    await sessionCapacity(`/data/sessions/${this.user}`, this.thread);
    if (deleting.has(this.key)) fail(409, '正在删除此对话');
    // Recheck after the asynchronous capacity read before claiming this user's task.
    if ([...sessions.values()].some(entry => entry.pi.user === this.user && entry.pi.busy)) fail(409, '每个用户同时只能运行一个任务');
    if (permission?.execution && ['auto', 'edit', 'ask'].includes(permission.execution)) {
      this.execution = permission.execution;
    }
    this.busy = true; this.webSession = new WebSession(); this.stopping = false; this.lastRenew = Date.now();
    this.fanout = new TurnFanout(); this.persisted = 0; this.disk = Promise.resolve();
    this.turnFile = await resetTurnLog(this.user, this.thread);
    // The HTTP response is only a subscriber. Its close must not kill Pi.
    try {
      if (!res.destroyed && !res.writableEnded) {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'X-Accel-Buffering': 'no', 'Cache-Control': 'no-store' });
        this.fanout.attach(res, 0);
      }
    } catch { /* the browser left before the first byte; the turn still runs */ }
    this.deadline = setTimeout(() => this.abortTurn(), 30 * 60000);
    // Gateway heartbeats renew the lease. If that stops, the lease is already
    // dead and this turn must not keep running on a stale authorization.
    this.renewWatch = setInterval(() => {
      if (this.busy && Date.now() - (this.lastRenew || 0) > 30000) this.abortTurn();
    }, 5000);
    let checking = false;
    this.storageCheck = setInterval(async () => {
      if (checking) return; checking = true;
      try { await sessionCapacity(`/data/sessions/${this.user}`, this.thread); }
      catch {
        this.publish({ type: 'gateway_error', error: '对话存储达到上限，任务已停止。请联系管理员归档。' });
        this.abortTurn();
      }
      finally { checking = false; }
    }, 10000);
    try {
      if (typeof thinking === 'string' && ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking)) {
        await this.command('set_thinking_level', { level: thinking }).catch(() => {});
      }
      const promptFields = { message };
      if (Array.isArray(images) && images.length) promptFields.images = images;
      await this.command('prompt', promptFields, 120000);
    }
    catch (error) { this.publish({ type: 'gateway_error', error: error.message }); this.finish(); }
  }
}
async function instance(user, thread) {
  const key = user + ':' + thread;
  if (deleting.has(key)) fail(409, '正在删除此对话');
  if (toolchainBusy(user)) fail(409, '工具链正在安装，请等待完成');
  if (configuring) fail(409, '正在更新供应商，请稍后重试');
  await sessionCapacity(`/data/sessions/${user}`, thread, { readExisting: true });
  if (toolchainBusy(user)) fail(409, '工具链正在安装，请等待完成');
  if (deleting.has(key)) fail(409, '正在删除此对话');
  let entry = sessions.get(key);
  if (entry) {
    await entry.ready;
    try { await sandbox('/renew', user, entry.pi.lease); }
    catch { entry.pi.proc?.kill(); sessions.delete(key); entry = undefined; }
  }
  if (!entry) {
    if (sessions.size >= 4) {
      const idle = [...sessions.values()].filter(item => !item.initializing && !item.pi.busy).sort((a, b) => a.touched - b.touched)[0];
      if (!idle) fail(429, 'Agent 会话已满，请稍后重试');
      sessions.delete(idle.pi.key); idle.pi.proc?.kill();
    }
    const pi = new Pi(user, thread);
    entry = { pi, ready: pi.start(), initializing: true, touched: Date.now() }; sessions.set(key, entry);
    entry.ready.then(() => { entry.initializing = false; }, () => {
      pi.proc?.kill(); if (sessions.get(key) === entry) sessions.delete(key);
    });
  }
  entry.touched = Date.now();
  await entry.ready;
  if (deleting.has(key)) fail(409, '正在删除此对话');
  return entry.pi;
}
async function deleteChat(user, thread) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(thread || '')) fail(422, '对话标识无效');
  const key = user + ':' + thread;
  if (deleting.has(key)) fail(409, '正在删除此对话');
  deleting.add(key);
  try {
    const entry = sessions.get(key);
    if (entry) {
      await entry.ready.catch(() => {});
      if (entry.pi.busy) fail(409, '此对话正在运行，请先停止任务');
      const proc = entry.pi.proc;
      if (proc?.pid && proc.exitCode === null && proc.signalCode === null) {
        let force, deadline;
        try {
          const exited = new Promise(resolve => proc.once('exit', resolve));
          proc.kill(); force = setTimeout(() => proc.kill('SIGKILL'), 1500);
          await Promise.race([exited, new Promise((_, reject) => { deadline = setTimeout(() => reject(Object.assign(new Error('未能关闭对话进程，请稍后重试'), { status: 503 })), 5000); })]);
        } finally { clearTimeout(force); clearTimeout(deadline); }
      }
      if (sessions.get(key) === entry) sessions.delete(key);
    }
    const result = await chats.delete(user, thread);
    snapshots.forget(user, thread);
    return result;
  } finally { deleting.delete(key); }
}
async function resetTurnLog(user, thread) {
  const file = `/data/turns/${user}/${thread}.ndjson`;
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, '', { mode: 0o600 });
    return file;
  } catch { return undefined; }
}
async function savedTurn(user, thread) {
  const file = `/data/turns/${user}/${thread}.ndjson`;
  try {
    const info = await stat(file);
    if (Date.now() - info.mtimeMs > 30 * 60 * 1000) return null;
    const text = await readFile(file, 'utf8');
    const lines = text.split('\n').filter(line => line.length > 0);
    return { lines, cursor: lines.length };
  } catch { return null; }
}
async function cancel(user, extra) {
  cancelToolchain(user);
  // Kill model generation AND every tool descendant, including detached processes.
  for (const [key, entry] of sessions) {
    if (entry.pi.user === user) { sessions.delete(key); entry.pi.proc?.kill(); }
  }
  await sandbox('/cancel', user, undefined, undefined, extra);
}
function assertUserIdle(user) {
  if (toolchainBusy(user) || [...sessions.values()].some(entry => entry.pi.user === user && (entry.initializing || entry.pi.busy || entry.pi.maintenance))) {
    fail(409, '请先停止或等待当前任务完成');
  }
}
function forgetIdleSessions(user) {
  for (const [key, entry] of sessions) if (entry.pi.user === user) {
    sessions.delete(key); entry.pi.proc?.kill();
  }
}
function shellQuote(value) { return "'" + String(value).replaceAll("'", "'\\''") + "'"; }
async function projectDirectory(user, value) {
  const id = normalizeProjectId(value || 'default');
  const meta = await chats.loadMeta(user);
  if (!meta.projects[id]) fail(404, '项目空间不存在');
  return '/workspace/' + id;
}
export const server = createServer(async (req, res) => {
  try {
    if (req.url === '/healthz' && req.method === 'GET') return json(res, 200, { ok: true, model });
    if (req.url?.startsWith('/runtime/')) {
      if (req.method !== 'POST') fail(405, '请求方法不支持');
      const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
      const pi = [...sessions.values()].map(e => e.pi).find(pi => equal(pi.runtimeToken, token));
      if (!pi || (!pi.busy && req.url !== '/runtime/mcp/tools')) fail(403, '运行时请求无效');
      if (req.url === '/runtime/mcp/tools') {
        const config = await features.get(pi.user);
        return json(res, 200, { tools: config.mcpServers.filter(s => s.enabled).flatMap(server => (server.tools || []).map(tool => ({ name: mcpToolName(server.id, tool.name), description: server.name + ': ' + tool.description, inputSchema: tool.inputSchema }))) });
      }
      if (req.url === '/runtime/mcp/call') {
        const input = await body(req), config = await features.get(pi.user);
        for (const server of config.mcpServers.filter(s => s.enabled)) {
          const tool = (server.tools || []).find(t => mcpToolName(server.id, t.name) === input.name);
          if (!tool) continue;
          const result = await pi.mcp.call(server, tool.name, input.arguments);
          for (const s of config.mcpServers) if (s.token) result.text = result.text.split(s.token).join('[REDACTED]');
          return json(res, 200, result);
        }
        fail(404, 'MCP 工具未启用');
      }
      if (req.url === '/runtime/context') {const item=(await chats.loadMeta(pi.user)).chats[pi.thread];return json(res,200,{context:memoryContext(await memories.read(pi.user,pi.projectId))+(item?.titleSource==='pending'?'\nThis is a new conversation: call set_chat_title early with a concise summary of the actual task, rather than copying user text.':'')});}
      if (req.url === '/runtime/memory/read') return json(res, 200, await memories.read(pi.user, pi.projectId));
      if (req.url === '/runtime/memory/update') return json(res, 200, await memories.update(pi.user, pi.projectId, await body(req)));
      if (req.url === '/runtime/policy') return json(res, 200, { execution: pi.execution });
      if(req.url==='/runtime/chat/title'){
        const input = await body(req);
        const title = typeof input.title === 'string' ? pi.mask(input.title) : input.title;
        const result = await chats.autoTitle(pi.user, pi.thread, title);
        if (!result.skipped) pi.publish({ type: 'chat_title', thread: pi.thread, title: result.title });
        return json(res,200,result);
      }
      if (req.url === '/runtime/search') {
        const input = await body(req), config = await searchSettings.get(pi.user);
        if (!config.enabled) fail(403, '联网搜索已在设置中关闭');
        return json(res, 200, await pi.webSession.run(input.category === 'image' ? 'image' : 'search', input.query,() => searchWeb(pi.lease, config, input)));
      }
      if(req.url==='/runtime/fetch'){const input=await body(req);return json(res,200,await pi.webSession.run('fetch',input.url,()=>sandboxTool(pi.lease,{op:'web-fetch',url:input.url},35000)));}
      fail(404, '接口不存在');
    }
    if (!equal(req.headers['x-runner-secret'], secret)) fail(401, '服务认证失败');
    if (req.method !== 'POST') fail(405, '请求方法不支持');
    // Prompts carry inline base64 images, so they need the same room the
    // gateway allows (up to 12 MiB per image) instead of the 64 KiB default.
    const input = await body(req, req.url === '/files/upload' ? 21 * 1024 * 1024 : req.url === '/prompt' ? 20 * 1024 * 1024 : req.url === '/features/save' ? 256 * 1024 : req.url === '/search/settings/save' ? 512 * 1024 : 65536);
    if (!/^[a-f0-9]{64}$/.test(input.user || '')) fail(422, '用户标识无效');
    if (req.url === '/image') {
      if(input.path){const value=await downloadWorkspace(input.user,input.path);const data=Buffer.from(value.data,'base64');const mime=data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':data[0]===255&&data[1]===216?'image/jpeg':data.subarray(0,3).toString()==='GIF'?'image/gif':data.subarray(0,4).toString()==='RIFF'&&data.subarray(8,12).toString()==='WEBP'?'image/webp':'';if(!mime||data.length>5*1024*1024)fail(415,'图片格式不支持或超过 5 MiB');return json(res,200,{data:value.data,mime});}
      const lease=(await sandbox('/lease',input.user)).token;
      try { return json(res,200,await sandboxTool(lease,{op:'image-fetch',url:input.url},20000)); }
      catch { return json(res,200,await sandboxTool(lease,{op:'image-fetch',url:input.url,useProxy:false},20000)); }
    }
    if (req.url === '/features') return json(res, 200, publicFeatures(await features.get(input.user)));
    if (req.url === '/features/save') {
      assertUserIdle(input.user); const result = await features.save(input.user, input.config); forgetIdleSessions(input.user); return json(res, 200, result);
    }
    if (req.url === '/features/mcp/test') {
      assertUserIdle(input.user);
      const config = await features.get(input.user), server = config.mcpServers.find(s => s.id === input.id);
      if (!server) fail(404, 'MCP 配置不存在');
      const lease = (await sandbox('/lease', input.user)).token;
      const connection = new McpConnections(value => sandboxTool(lease, value, 45000));
      const renewal = setInterval(() => sandbox('/renew', input.user, lease).catch(() => {}), 5000);
      try {
        const tools = await connection.tools(server);
        if (server.token && JSON.stringify(tools).includes(server.token)) fail(502, 'MCP 工具定义包含认证信息，已拒绝加载');
        return json(res, 200, await features.tools(input.user, server.id, tools, server.url));
      } finally { clearInterval(renewal); }
    }
    if (req.url === '/context/stats' || req.url === '/context/compact') {
      await chats.assertOwned(input.user, input.thread);
      if (req.url.endsWith('/compact')) assertUserIdle(input.user);
      const pi = await instance(input.user, input.thread);
      if (req.url.endsWith('/stats')) { const data = await pi.command('get_session_stats'); return json(res, 200, { tokens: data.tokens, cost: data.cost, contextUsage: data.contextUsage || null, totalMessages: data.totalMessages, toolCalls: data.toolCalls }); }
      pi.maintenance = true;
      try { const result = await pi.command('compact', { customInstructions: String(input.instructions || '').slice(0,2000) }, 180000); snapshots.forget(input.user, input.thread); return json(res, 200, { ok:true, tokensBefore:result.tokensBefore, estimatedTokensAfter:result.estimatedTokensAfter }); }
      catch (error) { if (/Nothing to compact|session too small/i.test(error.message)) return json(res, 200, { ok:true, skipped:true, reason:'当前上下文较短，暂不需要压缩' }); throw error; }
      finally { pi.maintenance = false; }
    }
    if (req.url === '/background/preview') {
      const response = await fetch((process.env.SANDBOX_URL || 'http://192.168.84.1:18082') + '/background/preview', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + required('SANDBOX_SECRET') }, body: JSON.stringify({ token: input.token, path: input.path }), signal: AbortSignal.timeout(15000) });
      const value = await response.json(); if (!response.ok) fail(404, value.error || '预览不可用'); return json(res, 200, value);
    }
    if (req.url === '/background/list' || req.url === '/background/stop') {
      const lease = (await sandbox('/lease', input.user)).token;
      return json(res, 200, await sandboxTool(lease, { op: req.url.endsWith('/list') ? 'background-status' : 'background-stop', id: input.id }));
    }
    if (req.url === '/memory' || req.url === '/memory/update') {
      const project = input.project || 'default'; await projectDirectory(input.user, project);
      return json(res, 200, req.url === '/memory' ? await memories.read(input.user, project) : await memories.update(input.user, project, input));
    }
    if (req.url === '/cancel') { await cancel(input.user); return json(res, 200, { ok: true }); }
    if (req.url === '/renew') {
      await renewToolchain(input.user);
      for (const entry of sessions.values()) {
        if (entry.pi.user === input.user && entry.pi.busy) {
          await sandbox('/renew', input.user, entry.pi.lease);
          entry.pi.lastRenew = Date.now();
        }
      }
      return json(res, 200, { ok: true });
    }
    if (req.url === '/model') {
      const config = await activeProvider().catch(() => undefined);
      return json(res, 200, { label: modelLabel(config?.model || model.split('/').pop()) });
    }
    if (req.url === '/search/settings') return json(res, 200, publicSearch(await searchSettings.get(input.user)));
    if (req.url === '/search/settings/save') return json(res, 200, await searchSettings.save(input.user, input.config));
    if (req.url === '/search/test') {
      const config = await searchSettings.get(input.user);
      if (!config.enabled) fail(403, '联网搜索已关闭');
      const lease = (await sandbox('/lease', input.user)).token;
      const renewal = setInterval(() => sandbox('/renew', input.user, lease).catch(() => {}), 5000);
      try {
        if (!input.source) return json(res, 200, await searchWeb(lease, config, input));
        return json(res, 200, await sandboxTool(lease, { op: 'web-search', ...config, engine:input.category==='image'?config.imageEngine:config.engine, category:input.category === 'image'?'image':'web', query: input.query, ...(input.source?{sources:config.sources.filter(s=>s.id===input.source).map(s=>({...s,enabled:true}))}:{}) }, 45000));
      } finally { clearInterval(renewal); }
    }
    if (req.url === '/providers') return json(res, 200, await publicProviders());
    if (req.url === '/greeting') {
      // Rotate a small curated set (≤16 chars). Cheap, deterministic-ish by time
      // so it varies across visits without spending model tokens.
      const lines = ['今天想做点什么？', '把任务交给我吧', '准备好了，说说想法', '需要我做什么？', '一起把它完成吧', '有什么可以帮你的？', '从哪里开始？'];
      return json(res, 200, { text: lines[Math.floor(Date.now() / 3.6e6) % lines.length] });
    }

    if (req.url === '/quotas' || req.url === '/quotas/save') {
      if (typeof input.target !== 'string' || !input.target || input.target.length > 128) fail(422, '用户标识无效');
      const target = createHash('sha256').update(input.target).digest('hex');
      if (req.url.endsWith('/save') && (toolchainBusy(target) || [...sessions.values()].some(entry => entry.pi.user === target && (entry.pi.busy || entry.pi.maintenance || entry.initializing)))) fail(409, '该用户正在运行任务，请先停止或等待完成');
      const response = await fetch((process.env.SANDBOX_URL || 'http://192.168.84.1:18082') + (req.url.endsWith('/save') ? '/quota/set' : '/quota/get'), {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + required('SANDBOX_SECRET') },
        body: JSON.stringify({ user: target, quota: input.quota }), signal: AbortSignal.timeout(130000), redirect: 'error' });
      const result = await response.json();
      if (!response.ok) fail(response.status === 409 ? 409 : 422, result.error || '配额操作失败');
      return json(res, 200, result);
    }
    if (req.url === '/toolchains') return json(res, 200, await toolchainStatus(input.user));
    if (req.url === '/toolchains/change') {
      if ([...sessions.values()].some(entry => entry.pi.user === input.user && (entry.initializing || entry.pi.busy || entry.pi.maintenance))) fail(409, '请先等待当前模型任务结束');
      invalidateWorkspace(input.user);
      return json(res, 200, await startToolchain(input.user, input));
    }
    if (req.url === '/packages') return json(res, 200, await packageCatalog(input.query));
    if (req.url === '/packages/change') {
      if (configuring || [...sessions.values()].some(entry => entry.initializing || entry.pi.busy || entry.pi.maintenance)) fail(409, '请先等待所有任务结束，再修改扩展');
      configuring = true;
      try {
        const result = await changePackage(input);
        for (const entry of sessions.values()) entry.pi.proc?.kill();
        sessions.clear();
        return json(res, 200, result);
      } finally { configuring = false; }
    }
    if (req.url === '/providers/test') return json(res, 200, await testProvider(input.config));
    if (req.url === '/providers/models') return json(res, 200, await discoverProviderModels(input.config));
    if (req.url === '/providers/delete') {
      if (configuring) fail(409, '供应商正在更新，请稍后重试');
      if ([...sessions.values()].some(entry => entry.pi.busy)) fail(409, '请先等待所有任务结束或停止任务，再删除供应商');
      configuring = true;
      try {
        const result = await deleteProvider(input.id);
        for (const entry of sessions.values()) entry.pi.proc?.kill();
        sessions.clear();
        return json(res, 200, result);
      } finally { configuring = false; }
    }
    if (req.url === '/providers/save') {
      if (configuring) fail(409, '供应商正在更新，请稍后重试');
      if ([...sessions.values()].some(entry => entry.pi.busy)) fail(409, '请先等待所有任务结束或停止任务，再修改供应商');
      configuring = true;
      try {
        const result = await saveProvider(input.config);
        for (const entry of sessions.values()) entry.pi.proc?.kill();
        sessions.clear();
        return json(res, 200, result);
      } finally { configuring = false; }
    }
    if (req.url === '/providers/activate') {
      if (configuring) fail(409, '供应商正在更新，请稍后重试');
      if ([...sessions.values()].some(entry => entry.pi.busy)) fail(409, '请先等待所有任务结束或停止任务，再切换模型');
      configuring = true;
      try {
        const result = await activateProvider({ id: input.id, model: input.model });
        // New sessions must pick up the newly active model.
        for (const entry of sessions.values()) entry.pi.proc?.kill();
        sessions.clear();
        return json(res, 200, result);
      } finally { configuring = false; }
    }
    if (req.url === '/projects') return json(res, 200, { projects: await chats.listProjects(input.user) });
    if (req.url === '/questions/answer' || req.url === '/steer') {
      const entry = sessions.get(input.user + ':' + input.thread);
      if (!entry || !entry.pi.busy) fail(409, '此任务已结束');
      if (req.url === '/questions/answer') return json(res, 200, entry.pi.questions.resolve(input.id, input.answer));
      if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 20000) fail(422, '补充内容无效');
      await entry.pi.command('steer', { message: input.message.trim() });
      return json(res, 200, { ok: true });
    }
    if (req.url === '/chats/permission') {
      const entry = sessions.get(input.user + ':' + input.thread);
      if (entry?.initializing) fail(409, '任务正在初始化，请稍后重试');
      if (entry?.pi.busy) {
        const meta = await chats.loadMeta(input.user), current = meta.chats[input.thread]?.permission || { scope: 'project_only', extraProjects: {} };
        const next = sanitizePermission(input.permission, meta.chats[input.thread]?.projectId || 'default');
        if (!sameScope(next, current)) fail(409, '运行中只能切换执行方式，项目范围请在任务结束后调整');
        const result = await chats.setChatPermission(input.user, input.thread, next);
        entry.pi.execution = next.execution;
        entry.pi.approvals.allowPending(tool => !requiresApproval(next.execution, tool));
        return json(res, 200, result);
      }
    }
    if (req.url === '/approvals/resolve') {
      const entry = sessions.get(input.user + ':' + input.thread);
      if (!entry || !entry.pi.busy) fail(409, '此任务已结束，审批无效');
      return json(res, 200, entry.pi.approvals.resolve(input.id, input.allow));
    }
    if (req.url === '/projects/create') {
      const proj = await chats.createProject(input.user, input);
      return json(res, 200, proj);
    }
    if (req.url === '/projects/rename') return json(res, 200, await chats.renameProject(input.user, input.id, input.name));
    if (req.url === '/projects/delete' || req.url === '/chats/project' || req.url === '/chats/permission') {
      assertUserIdle(input.user);
      const previousPermission = req.url === '/chats/permission' ? (await chats.loadMeta(input.user)).chats[input.thread]?.permission : null;
      const nextPermission = req.url === '/chats/permission' ? sanitizePermission(input.permission) : null;
      if (req.url !== '/chats/permission' || !sameScope(previousPermission, nextPermission)) await sandbox('/background/stop-user', input.user);
      const result = req.url === '/projects/delete' ? await chats.deleteProject(input.user, input.id)
        : req.url === '/chats/project' ? await chats.setChatProject(input.user, input.thread, input.projectId)
        : await chats.setChatPermission(input.user, input.thread, input.permission);
      forgetIdleSessions(input.user);
      return json(res, 200, result);
    }
    if (req.url === '/git/status') {
      const dir = await projectDirectory(input.user, input.project);
      try {
        const lease = (await sandbox('/lease', input.user)).token;
        const check = await sandboxTool(lease, { op: 'bash', command: `cd ${shellQuote(dir)} 2>/dev/null && git rev-parse --is-inside-work-tree 2>/dev/null`, timeout: 5 });
        if (!check.output || !check.output.includes('true')) {
          return json(res, 200, { isGit: false, branch: '', branches: [] });
        }
        const cmd = `cd ${shellQuote(dir)} && { git branch --show-current 2>/dev/null; echo "---"; git branch --list --format="%(refname:short)" 2>/dev/null; }`;
        const resGit = await sandboxTool(lease, { op: 'bash', command: cmd, timeout: 5 });
        const parts = (resGit.output || '').split('---');
        const curBranch = (parts[0] || '').trim();
        const branchList = (parts[1] || '').split('\n').map(b => b.trim()).filter(Boolean);
        if (curBranch && !branchList.includes(curBranch)) branchList.unshift(curBranch);
        return json(res, 200, { isGit: true, branch: curBranch, branches: branchList.length ? branchList : [curBranch || 'main'] });
      } catch {
        return json(res, 200, { isGit: false, branch: '', branches: [] });
      }
    }
    if (req.url === '/git/checkout') {
      assertUserIdle(input.user);
      const targetBranch = String(input.branch || '').trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(targetBranch) || targetBranch.includes('..')) fail(422, '分支名称无效');
      const dir = await projectDirectory(input.user, input.project);
      try {
        const lease = (await sandbox('/lease', input.user)).token;
        const resGit = await sandboxTool(lease, { op: 'bash', command: `cd ${shellQuote(dir)} && git switch -- ${shellQuote(targetBranch)}`, timeout: 10 });
        if (resGit.exitCode !== 0) {
          fail(400, resGit.output || '切换分支失败');
        }
        return json(res, 200, { ok: true, branch: targetBranch });
      } catch (err) {
        fail(400, err.message || '切换分支失败');
      }
    }
    if (req.url === '/terminal/exec') {
      assertUserIdle(input.user);
      if (typeof input.command !== 'string' || !input.command.trim() || input.command.length > 20000) fail(422, '命令无效');
      const lease = (await sandbox('/lease', input.user)).token;
      const cwd = typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : '/workspace';
      if (!(cwd === '/workspace' || cwd.startsWith('/workspace/')) || /[\u0000\r\n]/.test(cwd) || cwd.split('/').includes('..')) fail(422, '终端工作目录无效');
      const sentinel = '__PWD_' + Date.now() + '__';
      const wrapped = `cd ${shellQuote(cwd)} 2>/dev/null || exit 1; ${input.command}\n__EC=$?; printf '\\n${sentinel}'; pwd; exit $__EC`;
      const result = await sandboxTool(lease, { op: 'bash', cwd, command: wrapped, timeout: 15 });
      invalidateWorkspace(input.user);
      let output = result.output || '';
      let nextCwd = cwd;
      const idx = output.lastIndexOf('\n' + sentinel);
      if (idx !== -1) {
        const after = output.slice(idx + sentinel.length + 1).trim();
        if (after) nextCwd = after;
        output = output.slice(0, idx);
      }
      return json(res, 200, { output, exitCode: result.exitCode ?? 0, cwd: nextCwd });
    }
    if (req.url === '/chats') return json(res, 200, { chats: await chats.list(input.user) });
    if (req.url === '/chats/rename') return json(res, 200, await chats.rename(input.user, input.thread, input.title));
    if (req.url === '/chats/pin') return json(res, 200, await chats.setPinned(input.user, input.thread, input.pinned));
    if (req.url === '/chats/archive') return json(res, 200, await chats.setArchived(input.user, input.thread, input.archived));
    if (req.url === '/chats/delete') return json(res, 200, await deleteChat(input.user, input.thread));
    if (req.url === '/chats/export') return json(res, 200, await chats.export(input.user, input.thread, input.format, await secretValues()));
    if (req.url === '/chats/fork') {
      assertUserIdle(input.user);
      const target = input.targetThread || randomUUID();
      await sessionCapacity(`/data/sessions/${input.user}`, target, { readExisting: true });
      return json(res, 200, await chats.fork(input.user, input.thread, target, input.title, input.keepMessages, input.keepUserTurns));
    }
    if (req.url === '/chats/truncate') {
      assertUserIdle(input.user);
      const result = await chats.truncate(input.user, input.thread, Number(input.keepMessages) || 0, input.keepUserTurns);
      snapshots.forget(input.user, input.thread);
      const live = sessions.get(input.user + ':' + input.thread);
      if (live) {
        live.pi.proc?.kill();
        sessions.delete(input.user + ':' + input.thread);
      }
      return json(res, 200, result);
    }
    // Workspace calls use an independent short lease; they never cancel model work.
    if (req.url.startsWith('/files/') && [...sessions.values()].some(entry => entry.pi.user === input.user && entry.pi.busy)) invalidateWorkspace(input.user);
    if (req.url === '/files/list') return json(res, 200, await listWorkspace(input.user, input.path, input.fresh === true));
    if (req.url === '/files/preview') return json(res, 200, await previewWorkspace(input.user, input.path, input.limit, input.fresh === true));
    if (req.url === '/files/download') return json(res, 200, await downloadWorkspace(input.user, input.path));
    if (req.url === '/files/upload') return json(res, 200, await uploadWorkspace(input.user, input.path, input.content, input.overwrite === true, input.revision, input.encoding));
    if (req.url === '/files/manage') return json(res, 200, await manageWorkspace(input.user, input));
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.thread || '')) fail(422, '对话标识无效');
    if (req.url === '/session') {
      const live = sessions.get(input.user + ':' + input.thread);
      const busy = live?.pi.busy === true;
      const messages = busy ? (await live.pi.command('get_messages')).messages || [] : await snapshots.read(input.user, input.thread);
      let text = JSON.stringify(messages);
      for (const key of await secretValues()) text = text.split(key).join('[REDACTED]');
      return json(res, 200, { messages: JSON.parse(text), busy });
    }
    if (req.url === '/abort') { await cancel(input.user, { stopInstalls: true }); return json(res, 200, { ok: true }); }
    if (req.url === '/turns/status') {
      const pi = sessions.get(input.user + ':' + input.thread)?.pi;
      if (pi?.fanout) return json(res, 200, { thread: input.thread, busy: pi.busy === true, settled: pi.busy !== true && pi.fanout.cursor > 0, cursor: pi.fanout.cursor });
      const saved = await savedTurn(input.user, input.thread);
      if (saved) return json(res, 200, { thread: input.thread, busy: false, settled: saved.cursor > 0, cursor: saved.cursor });
      return json(res, 200, { thread: input.thread, busy: false, settled: false, cursor: 0 });
    }
    if (req.url === '/turns/subscribe') {
      const cursor = Number.isFinite(Number(input.cursor)) && Number(input.cursor) > 0 ? Math.floor(Number(input.cursor)) : 0;
      const pi = sessions.get(input.user + ':' + input.thread)?.pi;
      if (pi?.fanout && (pi.busy || pi.fanout.cursor > 0)) {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'X-Accel-Buffering': 'no', 'Cache-Control': 'no-store', 'X-Turn-Cursor': String(pi.fanout.cursor) });
        pi.fanout.attach(res, cursor, { endIfIdle: !pi.busy });
        return;
      }
      const saved = await savedTurn(input.user, input.thread);
      if (!saved) fail(404, '没有可恢复的任务');
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'X-Accel-Buffering': 'no', 'Cache-Control': 'no-store', 'X-Turn-Cursor': String(saved.cursor) });
      for (const line of saved.lines.slice(cursor)) res.write(line + '\n');
      res.end();
      return;
    }
    if (req.url === '/prompt') {
      const prompt=promptInput(input);
      await chats.initialize(input.user, input.thread, input.projectId, input.permission);
      const pi = await instance(input.user, input.thread);
      return await pi.prompt(res, prompt.message, input.thinking, prompt.images, input.permission);
    }
    fail(404, '接口不存在');
  } catch (error) {
    if (res.headersSent) return res.destroy();
    json(res, error.status || 503, { error: error.status ? error.message : 'Pi 服务暂时不可用' });
  }
});
server.listen(Number(process.env.PORT || 8081), '0.0.0.0');

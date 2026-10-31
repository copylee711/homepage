import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readdir, stat, open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { body, equal, fail, json, required } from './shared.mjs';
import { publicProviders, saveProvider, activeProvider, testProvider, proxyEnvironment, loadProviders } from './providers.mjs';
import { sandbox } from './sandbox-client.mjs';
import { sessionCapacity } from './session-limits.mjs';
import { prepareSessionCwd } from './session-cwd.mjs';

const secret = required('RUNNER_SECRET');
const sessions = new Map();
let configuring = false;
const model = process.env.PI_MODEL || 'opencode-go/deepseek-v4.1-flash';
class Pi {
  constructor(user, thread) { this.user = user; this.thread = thread; this.key = user + ':' + thread; this.pending = new Map(); this.busy = false; this.buffer = ''; }
  async start() {
    // Never mount or load instructions/extensions from an untrusted tool workspace.
    const cwd = `/tmp/pi/${this.user}`;
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    await mkdir(`/data/sessions/${this.user}`, { recursive: true, mode: 0o700 });
    await prepareSessionCwd(`/data/sessions/${this.user}/${this.thread}.jsonl`, cwd);
    const config = await activeProvider();
    this.secrets = [(process.env.OPENCODE_API_KEY || ''), ...(await loadProviders()).providers.map(item => item.apiKey || '')].filter(key => key.length >= 8);
    this.lease = (await sandbox('/lease', this.user)).token;
    const env = proxyEnvironment(config.proxy); delete env.RUNNER_SECRET; delete env.SANDBOX_SECRET;
    env.SANDBOX_URL = process.env.SANDBOX_URL || 'http://192.168.84.1:18082';
    env.SANDBOX_LEASE = this.lease;
    // Private broker traffic must never use the model's Mihomo proxy.
    env.NO_PROXY = env.no_proxy = '127.0.0.1,localhost,192.168.84.1';
    this.proc = spawn('pi', ['--mode', 'rpc', '--model', config.id + '/' + config.model, '--session', `/data/sessions/${this.user}/${this.thread}.jsonl`,
      '--no-builtin-tools', '--no-extensions', '-e', '/opt/pi/sandbox-extension.ts',
      '--no-skills', '--no-prompt-templates', '--no-themes'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
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
        if (event.type === 'response') {
          const wait = this.pending.get(event.id);
          if (wait) { this.pending.delete(event.id); clearTimeout(wait.timer); event.success ? wait.resolve(event.data) : wait.reject(Object.assign(new Error(event.error || 'Pi 请求失败'), { status: 502 })); }
        }
        if (this.output) {
          this.output.write(this.mask(JSON.stringify(event)) + '\n');
          if (this.output.writableLength > 2 * 1024 * 1024) this.output.destroy();
        }
        if (event.type === 'agent_settled') this.finish();
      }
    });
    this.proc.on('error', () => this.stop());
    this.proc.on('exit', () => this.stop());
    await this.command('get_state');
  }
  stop() {
    this.finish(); if (sessions.get(this.key)?.pi === this) sessions.delete(this.key);
    for (const wait of this.pending.values()) { clearTimeout(wait.timer); wait.reject(Object.assign(new Error('Pi 进程已退出，请重试'), { status: 503 })); }
    this.pending.clear();
  }
  mask(text) { for (const key of this.secrets || []) text = text.split(key).join('[REDACTED]'); return text; }
  finish() {
    clearTimeout(this.deadline); clearInterval(this.storageCheck); this.busy = false;
    const output = this.output; this.output = undefined;
    if (output && !output.destroyed) output.end();
  }
  command(type, fields = {}) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error('Pi 响应超时'), { status: 504 })); this.proc.kill(); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ id, type, ...fields }) + '\n', error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(Object.assign(new Error('Pi 输入已关闭'), { status: 503 })); }
      });
    });
  }
  async prompt(res, message) {
    if (this.busy) fail(409, '当前任务尚未结束，请先停止或等待完成');
    if ([...sessions.values()].some(entry => entry.pi !== this && entry.pi.user === this.user && entry.pi.busy)) fail(409, '每个用户同时只能运行一个任务');
    await sessionCapacity(`/data/sessions/${this.user}`, this.thread);
    // Recheck after the asynchronous capacity read before claiming this user's task.
    if ([...sessions.values()].some(entry => entry.pi.user === this.user && entry.pi.busy)) fail(409, '每个用户同时只能运行一个任务');
    this.busy = true; this.output = res;
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    const abort = () => { if (this.busy && this.output === res) void cancel(this.user).catch(() => this.proc?.kill()); };
    res.once('close', abort);
    this.deadline = setTimeout(abort, 10 * 60000);
    let checking = false;
    this.storageCheck = setInterval(async () => {
      if (checking) return; checking = true;
      try { await sessionCapacity(`/data/sessions/${this.user}`, this.thread); }
      catch { if (this.output === res) { res.write(JSON.stringify({ type: 'gateway_error', error: '对话存储达到上限，任务已停止。请联系管理员归档。' }) + '\n'); abort(); } }
      finally { checking = false; }
    }, 500);
    try { await this.command('prompt', { message }); }
    catch (error) { res.write(JSON.stringify({ type: 'gateway_error', error: error.message }) + '\n'); this.finish(); }
  }
}
async function instance(user, thread) {
  if (configuring) fail(409, '正在更新供应商，请稍后重试');
  await sessionCapacity(`/data/sessions/${user}`, thread, { readExisting: true });
  const key = user + ':' + thread;
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
  await entry.ready; return entry.pi;
}
async function cancel(user) {
  // Kill model generation AND every tool descendant, including detached processes.
  for (const [key, entry] of sessions) {
    if (entry.pi.user === user) { sessions.delete(key); entry.pi.proc?.kill(); }
  }
  await sandbox('/cancel', user);
}
async function chats(user) {
  const directory = `/data/sessions/${user}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const result = [];
  for (const file of (await readdir(directory)).filter(file => /^[a-f0-9-]{36}\.jsonl$/.test(file))) {
    const handle = await open(directory + '/' + file, 'r');
    try {
      const buffer = Buffer.alloc(65536), read = await handle.read(buffer, 0, buffer.length, 0);
      let title = '新对话';
      for (const line of buffer.subarray(0, read.bytesRead).toString().split('\n')) {
        try {
          const item = JSON.parse(line);
          if (item.message?.role === 'user') {
            const content = item.message.content;
            title = (typeof content === 'string' ? content : content.filter(item => item.type === 'text').map(item => item.text).join(' ')).slice(0, 70);
            break;
          }
        } catch {}
      }
      result.push({ id: file.slice(0, -6), title, updated: (await stat(directory + '/' + file)).mtimeMs });
    } finally { await handle.close(); }
  }
  return result.sort((a, b) => b.updated - a.updated).slice(0, 100);
}
export const server = createServer(async (req, res) => {
  try {
    if (req.url === '/healthz' && req.method === 'GET') return json(res, 200, { ok: true, model });
    if (!equal(req.headers['x-runner-secret'], secret)) fail(401, '服务认证失败');
    if (req.method !== 'POST') fail(405, '请求方法不支持');
    const input = await body(req);
    if (!/^[a-f0-9]{64}$/.test(input.user || '')) fail(422, '用户标识无效');
    if (req.url === '/cancel') { await cancel(input.user); return json(res, 200, { ok: true }); }
    if (req.url === '/renew') {
      for (const entry of sessions.values()) {
        if (entry.pi.user === input.user && entry.pi.busy) await sandbox('/renew', input.user, entry.pi.lease);
      }
      return json(res, 200, { ok: true });
    }
    if (req.url === '/providers') return json(res, 200, await publicProviders());
    if (req.url === '/providers/test') return json(res, 200, await testProvider(input.config));
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
    if (req.url === '/chats') return json(res, 200, { chats: await chats(input.user) });
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.thread || '')) fail(422, '对话标识无效');
    const pi = await instance(input.user, input.thread);
    if (req.url === '/session') {
      const result = await pi.command('get_messages');
      return json(res, 200, { messages: JSON.parse(pi.mask(JSON.stringify(result.messages || []))), busy: pi.busy });
    }
    if (req.url === '/abort') { await cancel(input.user); return json(res, 200, { ok: true }); }
    if (req.url === '/prompt') {
      if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 20000) fail(422, '任务内容无效');
      return await pi.prompt(res, input.message);
    }
    fail(404, '接口不存在');
  } catch (error) {
    if (res.headersSent) return res.destroy();
    json(res, error.status || 503, { error: error.status ? error.message : 'Pi 服务暂时不可用' });
  }
});
server.listen(Number(process.env.PORT || 8081), '0.0.0.0');

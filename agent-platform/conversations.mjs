import { lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { fail } from './shared.mjs';

const THREAD = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_TITLE = 80;
const MAX_EXPORT = 4 * 1024 * 1024;
const queues = new Map();

export function validThread(value) {
  return typeof value === 'string' && THREAD.test(value);
}
export function normalizeTitle(value) {
  if (typeof value !== 'string') fail(422, '请填写对话标题');
  const title = value.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!title || title.length > MAX_TITLE) fail(422, '标题需为 1–80 个字符');
  return title;
}
export function safeFilename(title, id) {
  const value = String(title || '').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  return (value.slice(0, 60) || '对话-' + id.slice(0, 8));
}
function excerpt(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 70) || '新对话';
}
function contentText(content) {
  if (typeof content === 'string') return content;
  return (content || []).filter(part => part?.type === 'text').map(part => part.text || '').join('\n');
}
function blocksOf(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content.filter(part => part && typeof part.type === 'string') : [];
}

// Session files stay untouched; per-user metadata lives in a separate atomic file.
export class ChatStore {
  constructor({ sessionsRoot, metaRoot }) {
    this.sessionsRoot = sessionsRoot;
    this.metaRoot = metaRoot;
  }
  directory(user) { return `${this.sessionsRoot}/${user}`; }
  file(user, thread) { return `${this.directory(user)}/${thread}.jsonl`; }
  metaFile(user) { return `${this.metaRoot}/${user}.json`; }
  serialize(user, task) {
    const previous = queues.get(user) || Promise.resolve();
    const result = previous.catch(() => {}).then(task);
    // Store a non-rejecting completion gate so a failed mutation cannot surface as
    // an unhandled rejection or permanently block the next mutation.
    const tail = result.catch(() => {});
    queues.set(user, tail);
    tail.finally(() => { if (queues.get(user) === tail) queues.delete(user); });
    return result;
  }
  async assertOwned(user, thread) {
    if (!validThread(thread)) fail(422, '对话标识无效');
    let info;
    try { info = await lstat(this.file(user, thread)); }
    catch (error) { if (error.code === 'ENOENT') fail(404, '对话不存在'); throw error; }
    if (!info.isFile() || info.isSymbolicLink()) fail(404, '对话不存在');
    return info;
  }
  async loadMeta(user) {
    let value;
    try { value = JSON.parse(await readFile(this.metaFile(user), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return { version: 1, chats: {} };
      if (error instanceof SyntaxError) fail(503, '对话元数据异常，请联系管理员检查');
      throw error;
    }
    const chats = {};
    for (const [id, item] of Object.entries(value?.chats || {})) {
      if (!validThread(id) || !item || typeof item !== 'object') continue;
      const entry = {};
      if (typeof item.title === 'string' && item.title.trim()) entry.title = item.title.trim().slice(0, MAX_TITLE);
      if (item.pinned === true) entry.pinned = true;
      if (item.archived === true) entry.archived = true;
      if (Number.isFinite(item.updatedAt)) entry.updatedAt = item.updatedAt;
      if (Object.keys(entry).length) chats[id] = entry;
    }
    return { version: 1, chats };
  }
  async saveMeta(user, meta) {
    await mkdir(this.metaRoot, { recursive: true, mode: 0o700 });
    const target = this.metaFile(user), temporary = target + '.tmp-' + process.pid + '-' + Date.now();
    await writeFile(temporary, JSON.stringify({ version: 1, chats: meta.chats }), { mode: 0o600 });
    try { await rename(temporary, target); }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  }
  async update(user, thread, change) {
    await this.assertOwned(user, thread);
    return this.serialize(user, async () => {
      const meta = await this.loadMeta(user);
      const next = change({ ...(meta.chats[thread] || {}) });
      if (next && typeof next === 'object') meta.chats[thread] = next;
      else delete meta.chats[thread];
      await this.saveMeta(user, meta);
      return { ...(meta.chats[thread] || {}), id: thread };
    });
  }
  rename(user, thread, value) {
    const title = normalizeTitle(value);
    return this.update(user, thread, item => ({ ...item, title }));
  }
  setPinned(user, thread, pinned) {
    if (typeof pinned !== 'boolean') fail(422, '置顶状态无效');
    return this.update(user, thread, item => {
      if (pinned) item.pinned = true; else delete item.pinned;
      return item;
    });
  }
  setArchived(user, thread, archived) {
    if (typeof archived !== 'boolean') fail(422, '归档状态无效');
    return this.update(user, thread, item => {
      if (archived) item.archived = true; else delete item.archived;
      return item;
    });
  }
  async list(user) {
    const directory = this.directory(user);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let meta;
    try { meta = await this.loadMeta(user); }
    catch { meta = { chats: {} }; }
    const result = [];
    for (const file of (await readdir(directory)).filter(name => /^[a-f0-9-]{36}\.jsonl$/.test(name))) {
      const id = file.slice(0, -6);
      if (!validThread(id)) continue;
      const full = directory + '/' + file;
      let info, title = '新对话';
      try {
        info = await lstat(full);
        if (!info.isFile() || info.isSymbolicLink()) continue;
        const handle = await open(full, 'r');
        try {
          const buffer = Buffer.alloc(65536), read = await handle.read(buffer, 0, buffer.length, 0);
          for (const line of buffer.subarray(0, read.bytesRead).toString().split('\n')) {
            try {
              const item = JSON.parse(line);
              if (item.message?.role === 'user') { title = excerpt(contentText(item.message.content)); break; }
            } catch {}
          }
        } finally { await handle.close(); }
      } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const saved = meta.chats[id] || {};
      result.push({ id, title: saved.title || title, pinned: saved.pinned === true,
        archived: saved.archived === true, updated: info.mtimeMs });
    }
    // Keep pinned first, then most recently active; archived stays in the same stream.
    return result.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated - a.updated).slice(0, 100);
  }
  async export(user, thread, format, secrets = []) {
    if (format !== 'md' && format !== 'json') fail(422, '导出格式无效');
    const info = await this.assertOwned(user, thread);
    if (info.size > MAX_EXPORT) fail(413, '此对话超过 4 MiB，无法导出');
    const meta = await this.loadMeta(user).catch(() => ({ chats: {} }));
    const entries = [];
    for (const line of (await readFile(this.file(user, thread), 'utf8')).split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch {}
    }
    // Tool output may contain credentials recorded before the key was rotated.
    // Apply the same known-secret masking used by live session responses.
    const known = (Array.isArray(secrets) ? secrets : []).filter(key => typeof key === 'string' && key.length >= 8);
    const mask = text => known.reduce((value, key) => value.split(key).join('[REDACTED]'), String(text));
    const title = mask(meta.chats[thread]?.title || this.deriveTitle(entries) || '对话');
    const messages = exportMessages(entries);
    const chat = { id: thread, title, pinned: meta.chats[thread]?.pinned === true,
      archived: meta.chats[thread]?.archived === true, updated_at: new Date(info.mtimeMs).toISOString() };
    if (format === 'json') {
      return { contentType: 'application/json; charset=utf-8', filename: safeFilename(title, thread) + '.json',
        content: mask(JSON.stringify({ schema: 'copylee.agent.chat.v1', exported_at: new Date().toISOString(), chat, messages }, null, 2)) };
    }
    return { contentType: 'text/markdown; charset=utf-8', filename: safeFilename(title, thread) + '.md',
      content: mask(markdownExport(chat, messages)) };
  }
  deriveTitle(entries) {
    for (const entry of entries) {
      if (entry?.type === 'message' && entry.message?.role === 'user') {
        return excerpt(contentText(entry.message.content)) || undefined;
      }
    }
  }
}

export function exportMessages(entries) {
  const messages = [];
  for (const entry of entries) {
    if (entry?.type !== 'message' || !entry.message) continue;
    const message = entry.message;
    if (!['user', 'assistant', 'toolResult'].includes(message.role)) continue;
    const item = { role: message.role, timestamp: entry.timestamp || (Number.isFinite(message.timestamp) ? new Date(message.timestamp).toISOString() : undefined) };
    if (message.role === 'toolResult') {
      item.tool_call_id = message.toolCallId;
      item.tool_name = message.toolName;
      item.is_error = message.isError === true;
      item.content = blocksOf(message.content).map(block => block.type === 'text'
        ? { type: 'text', text: block.text || '' }
        : { type: block.type, omitted: true });
    } else {
      item.content = blocksOf(message.content).flatMap(block => {
        if (block.type === 'text') return [{ type: 'text', text: block.text || '' }];
        if (block.type === 'thinking') return block.thinking ? [{ type: 'thinking', text: block.thinking }] : [];
        if (block.type === 'toolCall') return [{ type: 'toolCall', id: block.id, name: block.name, arguments: block.arguments }];
        if (block.type === 'image') return [{ type: 'image', omitted: true }];
        return [];
      });
    }
    // Do not export provider replay signatures or hidden reasoning payloads.
    messages.push(item);
  }
  return messages;
}

function fence(text, language = '') {
  const body = String(text ?? '');
  const ticks = body.includes('```') ? '~~~~' : '```';
  return ticks + language + '\n' + body.replace(/\r\n/g, '\n') + '\n' + ticks;
}
function markdownExport(chat, messages) {
  const lines = ['# ' + chat.title, '', '> 导出自 Copy Lee Agent · ' +
    new Date().toLocaleString('zh-CN', { hour12: false }) + ' · ' + messages.length + ' 条消息', ''];
  for (const message of messages) {
    const stamp = message.timestamp ? ' · ' + new Date(message.timestamp).toLocaleString('zh-CN', { hour12: false }) : '';
    if (message.role === 'user') {
      lines.push('## 你' + stamp, '');
      for (const block of message.content) if (block.type === 'text') lines.push(block.text, '');
    } else if (message.role === 'assistant') {
      lines.push('## Pi' + stamp, '');
      for (const block of message.content) {
        if (block.type === 'text') lines.push(block.text, '');
        if (block.type === 'thinking') lines.push('<details><summary>思考过程</summary>', '', block.text, '', '</details>', '');
        if (block.type === 'toolCall') {
          lines.push('### 工具调用 · ' + String(block.name || 'tool'), '', fence(JSON.stringify(block.arguments || {}, null, 2), 'json'), '');
        }
      }
    } else {
      lines.push('### 工具结果 · ' + String(message.tool_name || 'tool') + (message.is_error ? ' · 失败' : ''), '');
      for (const block of message.content) if (block.type === 'text') lines.push(fence(block.text));
      lines.push('');
    }
  }
  return lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd() + '\n';
}

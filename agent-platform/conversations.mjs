import { lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { fail } from './shared.mjs';
import { MAX_SESSION_READ_BYTES } from './session-limits.mjs';

const THREAD = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const PROJECT_ID = /^[a-zA-Z0-9_\-一-龥]{1,40}$/;
const RESERVED_PROJECTS = new Set(['__proto__', 'constructor', 'prototype', 'lost+found', 'node_modules']);
const MAX_TITLE = 80;
export const CHAT_PAGE_DEFAULT = 50, CHAT_PAGE_MAX = 500;

// Optional paging over the full, sorted chat list. Without limit or cursor every chat is
// returned, so older clients keep working. cursor is the opaque nextCursor of the previous
// page (an offset into the pinned-first, most-recent-first order).
export function paginateChats(chats, { limit, cursor } = {}) {
  const given = value => value !== undefined && value !== null && value !== '';
  if (!given(limit) && !given(cursor)) return { chats, total: chats.length, hasMore: false, nextCursor: null };
  const size = given(limit) ? Number(limit) : CHAT_PAGE_DEFAULT;
  if (!Number.isInteger(size) || size < 1 || size > CHAT_PAGE_MAX) fail(422, '分页数量需为 1–' + CHAT_PAGE_MAX);
  const raw = given(cursor) ? String(cursor) : '0';
  if (!/^\d{1,9}$/.test(raw)) fail(422, '分页游标无效');
  const start = Number(raw), page = chats.slice(start, start + size), end = start + page.length;
  return { chats: page, total: chats.length, hasMore: end < chats.length, nextCursor: end < chats.length ? String(end) : null };
}
const queues = new Map();

export function validThread(value) {
  return typeof value === 'string' && THREAD.test(value);
}
export function validProjectId(value) {
  return typeof value === 'string' && PROJECT_ID.test(value) && !RESERVED_PROJECTS.has(value);
}
export function normalizeProjectId(value) {
  if (typeof value !== 'string') fail(422, '请填写项目空间标识');
  const id = value.trim();
  if (!validProjectId(id)) fail(422, '项目标识需为 1–40 个字符，仅支持字母、数字、短横线、下划线及中文');
  return id;
}
export function normalizeProjectName(value, fallback = '新项目') {
  if (typeof value !== 'string') return fallback;
  const name = value.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 40);
  return name || fallback;
}
export function sanitizePermission(value, currentProject = 'default') {
  if (!value || typeof value !== 'object') {
    return { scope: 'project_only', extraProjects: {}, execution: 'ask' };
  }
  const scope = ['project_only', 'scoped', 'full'].includes(value.scope) ? value.scope : 'project_only';
  const extraProjects = {};
  if (scope === 'scoped' && value.extraProjects && typeof value.extraProjects === 'object') {
    for (const [pId, access] of Object.entries(value.extraProjects)) {
      if (validProjectId(pId) && pId !== currentProject && (access === 'read' || access === 'write')) {
        extraProjects[pId] = access;
      }
    }
  }
  return { scope, extraProjects, execution: ['auto', 'edit', 'plan'].includes(value.execution) ? value.execution : 'ask' };
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
// Rewind supports a linear, uncompacted history only. Refuse complex Pi trees
// rather than silently flattening branches or corrupting compaction references.
export function historyPrefix(content, count) {
  if (!Number.isInteger(count) || count < 0) fail(422, '保留消息数量无效');
  const lines = content.split('\n').filter(line => line.trim());
  let messages = 0, previous = null, cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    let item;
    try { item = JSON.parse(lines[i]); } catch { fail(409, '历史格式异常，未修改对话'); }
    if (['compaction', 'branch_summary', 'context_edit', 'custom_message'].includes(item.type)) fail(409, '此对话包含分支或压缩历史，暂不支持回退');
    if (item.type !== 'session' && item.id) {
      if ((item.parentId || null) !== previous) fail(409, '此对话包含分支历史，暂不支持回退');
      previous = item.id;
    }
    if (item.type === 'message') {
      if (messages === count && cut === lines.length) cut = i;
      messages++;
    }
  }
  if (count > messages) fail(409, '对话已变化，请刷新后重试');
  return lines.slice(0, cut).join('\n') + '\n';
}
export function historyThroughUserTurns(content, count) {
  if (!Number.isInteger(count) || count < 0) fail(422, '保留轮次数量无效');
  historyPrefix(content, 0); // Validate linear/uncompacted tree before any mutation.
  const lines = content.split('\n').filter(line => line.trim());
  let turns = 0;
  for (let i = 0; i < lines.length; i++) {
    const item = JSON.parse(lines[i]);
    if (item.type === 'message' && item.message?.role === 'user') {
      if (turns === count) return lines.slice(0, i).join('\n') + '\n';
      turns++;
    }
  }
  if (count > turns) fail(409, '对话已变化，请刷新后重试');
  return content;
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
      if (error.code === 'ENOENT') {
        return {
          version: 2,
          projects: { default: { id: 'default', name: '默认项目', createdAt: 0 } },
          chats: {},
          settings: { autoArchiveDays: 0 },
        };
      }
      if (error instanceof SyntaxError) fail(503, '对话元数据异常，请联系管理员检查');
      throw error;
    }
    const projects = {
      default: { id: 'default', name: '默认项目', createdAt: 0 },
    };
    if (value?.projects && typeof value.projects === 'object') {
      for (const [id, item] of Object.entries(value.projects)) {
        if (!validProjectId(id) || !item || typeof item !== 'object') continue;
        projects[id] = {
          id,
          name: typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 40) : (id === 'default' ? '默认项目' : id),
          createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
          description: typeof item.description === 'string' ? item.description.slice(0, 200) : '',
        };
      }
    }
    const chats = {};
    for (const [id, item] of Object.entries(value?.chats || {})) {
      if (!validThread(id) || !item || typeof item !== 'object') continue;
      const entry = {};
      if (typeof item.title === 'string' && item.title.trim()) entry.title = item.title.trim().slice(0, MAX_TITLE);
      if (['pending','agent','user'].includes(item.titleSource)) entry.titleSource=item.titleSource;
      if (Number.isFinite(item.createdAt)) entry.createdAt=item.createdAt;
      if (item.pinned === true) entry.pinned = true;
      if (item.archived === true) entry.archived = true;
      if (Number.isFinite(item.updatedAt)) entry.updatedAt = item.updatedAt;
      const pId = typeof item.projectId === 'string' && validProjectId(item.projectId) && projects[item.projectId]
        ? item.projectId
        : 'default';
      entry.projectId = pId;
      entry.permission = sanitizePermission(item.permission, pId);
      if (Object.keys(entry).length) chats[id] = entry;
    }
    const days = Number(value?.settings?.autoArchiveDays);
    const settings = { autoArchiveDays: Number.isInteger(days) && days > 0 && days <= 365 ? days : 0 };
    return { version: 2, projects, chats, settings };
  }
  async saveMeta(user, meta) {
    await mkdir(this.metaRoot, { recursive: true, mode: 0o700 });
    const target = this.metaFile(user), temporary = target + '.tmp-' + process.pid + '-' + Date.now();
    await writeFile(temporary, JSON.stringify({ version: 2, projects: meta.projects, chats: meta.chats, settings: meta.settings }), { mode: 0o600 });
    try { await rename(temporary, target); }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  }
  async setChatSettings(user, input) {
    const days = Number(input?.autoArchiveDays);
    if (!Number.isInteger(days) || days < 0 || days > 365) fail(422, '自动归档天数需为 0–365 的整数（0 表示关闭）');
    return this.serialize(user, async () => {
      const meta = await this.loadMeta(user);
      meta.settings = { ...meta.settings, autoArchiveDays: days };
      await this.saveMeta(user, meta);
      return meta.settings;
    });
  }
  // Archive unpinned conversations idle longer than the user's chosen window.
  autoArchive(user, busy = new Set()) {
    return this.serialize(user, async () => {
      const meta = await this.loadMeta(user);
      const days = meta.settings?.autoArchiveDays || 0;
      if (!days) return 0;
      const cutoff = Date.now() - days * 864e5;
      let changed = 0;
      for (const [id, item] of Object.entries(meta.chats)) {
        if (item.archived || item.pinned || busy.has(id)) continue;
        let updated;
        try { updated = (await lstat(this.file(user, id))).mtimeMs; } catch { updated = item.updatedAt || item.createdAt || Date.now(); }
        if (updated < cutoff) { item.archived = true; changed++; }
      }
      if (changed) await this.saveMeta(user, meta);
      return changed;
    });
  }
  async listProjects(user) {
    const meta = await this.loadMeta(user);
    const counts = {};
    for (const chat of Object.values(meta.chats)) {
      const pid = chat.projectId || 'default';
      counts[pid] = (counts[pid] || 0) + 1;
    }
    return Object.values(meta.projects).map(p => ({
      ...p,
      chatCount: counts[p.id] || 0,
    })).sort((a, b) => (a.id === 'default' ? -1 : (b.id === 'default' ? 1 : a.createdAt - b.createdAt)));
  }
  initialize(user, thread, projectId = 'default', permission) {
    if (!validThread(thread)) fail(422, '对话标识无效');
    return this.serialize(user, async () => {
      const meta = await this.loadMeta(user);
      const existing = meta.chats[thread];
      if (existing) {
        if (!existing.titleSource && (!existing.title || /^正在命名(?:…|\.\.\.)$/.test(existing.title))) {
          existing.titleSource = 'pending';
          existing.title = '新任务';
          await this.saveMeta(user, meta);
        }
        return;
      }
      if (Object.keys(meta.chats).length >= 100) fail(429, '对话元数据数量已达上限，请清理未使用的对话');
      // Legacy histories keep their default project. New histories bind exactly once,
      // before Pi starts, rather than depending on a not-yet-created JSONL file.
      const exists = await this.assertOwned(user, thread).then(() => true, error => {
        if (error.status === 404) return false;
        throw error;
      });
      const pid = exists ? 'default' : normalizeProjectId(projectId);
      if (!meta.projects[pid]) fail(404, '目标项目空间不存在');
      meta.chats[thread] = { projectId: pid, permission: sanitizePermission(exists ? undefined : permission, pid),...(!exists?{title:'新任务',titleSource:'pending',createdAt:Date.now()}:{} ) };
      await this.saveMeta(user, meta);
    });
  }
  async createProject(user, { id, name, description }) {
    const projId = normalizeProjectId(id);
    const projName = normalizeProjectName(name, projId);
    return this.serialize(user, async () => {
      const meta = await this.loadMeta(user);
      if (meta.projects[projId]) fail(409, '项目空间已存在');
      if (Object.keys(meta.projects).length >= 64) fail(429, '项目空间数量已达上限');
      meta.projects[projId] = {
        id: projId,
        name: projName,
        description: typeof description === 'string' ? description.slice(0, 200) : '',
        createdAt: Date.now(),
      };
      await this.saveMeta(user, meta);
      return { ...meta.projects[projId], chatCount: 0 };
    });
  }
  async renameProject(user, id, name) {
    const projId = normalizeProjectId(id);
    const projName = normalizeProjectName(name, projId);
    return this.serialize(user, async () => {
      const meta = await this.loadMeta(user);
      if (!meta.projects[projId]) fail(404, '项目空间不存在');
      meta.projects[projId].name = projName;
      await this.saveMeta(user, meta);
      let count = 0;
      for (const c of Object.values(meta.chats)) if (c.projectId === projId) count++;
      return { ...meta.projects[projId], chatCount: count };
    });
  }
  async deleteProject(user, id) {
    const projId = normalizeProjectId(id);
    if (projId === 'default') fail(422, '默认项目空间不可删除');
    return this.serialize(user, async () => {
      const meta = await this.loadMeta(user);
      if (!meta.projects[projId]) fail(404, '项目空间不存在');
      if (Object.values(meta.chats).some(chat => chat.projectId === projId)) fail(409, '项目仍有关联对话，请先删除这些对话');
      delete meta.projects[projId];
      for (const chat of Object.values(meta.chats)) {
        if (chat.permission?.extraProjects) delete chat.permission.extraProjects[projId];
      }
      await this.saveMeta(user, meta);
      return { ok: true };
    });
  }
  setChatProject(user, thread, projectId) {
    const pId = normalizeProjectId(projectId);
    return this.serialize(user, async () => {
      await this.assertOwned(user, thread);
      const meta = await this.loadMeta(user);
      if (!meta.projects[pId]) fail(404, '目标项目空间不存在');
      const item = meta.chats[thread] || {};
      if ((item.projectId || 'default') !== pId) {
        fail(403, '会话主项目空间在开启后不可更改');
      }
      item.projectId = pId;
      item.permission = sanitizePermission(item.permission, pId);
      meta.chats[thread] = item;
      await this.saveMeta(user, meta);
      return { ...(meta.chats[thread] || {}), id: thread };
    });
  }
  setChatPermission(user, thread, permission) {
    return this.serialize(user, async () => {
      await this.assertOwned(user, thread);
      const meta = await this.loadMeta(user);
      const item = meta.chats[thread] || {};
      const currentProj = item.projectId || 'default';
      item.permission = sanitizePermission(permission, currentProj);
      meta.chats[thread] = item;
      await this.saveMeta(user, meta);
      return { ...(meta.chats[thread] || {}), id: thread };
    });
  }
  async update(user, thread, change) {
    return this.serialize(user, async () => {
      await this.assertOwned(user, thread);
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
    return this.update(user, thread, item => ({ ...item, title,titleSource:'user' }));
  }
  async autoTitle(user,thread,value){
    const title=normalizeTitle(value);return this.serialize(user,async()=>{const meta=await this.loadMeta(user);const item=meta.chats[thread];if(!item)fail(404,'对话不存在');if(item.titleSource!=='pending')return {ok:true,skipped:true,title:item.title};item.title=title;item.titleSource='agent';await this.saveMeta(user,meta);return {ok:true,title};});
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
  async delete(user, thread) {
    return this.serialize(user, async () => {
      const meta = await this.loadMeta(user);
      const exists=await this.assertOwned(user,thread).then(()=>true,error=>{if(error.status===404&&meta.chats[thread]?.createdAt)return false;throw error;});
      // Exact owned files only. Never recursively delete a user-controlled path.
      if(exists)await unlink(this.file(user, thread));
      await unlink(this.file(user, thread) + '.cwd-backup').catch(error => { if (error.code !== 'ENOENT') throw error; });
      await unlink(this.file(user, thread) + '.rewind-backup').catch(error => { if (error.code !== 'ENOENT') throw error; });
      delete meta.chats[thread];
      await this.saveMeta(user, meta);
      return { ok: true };
    });
  }
  async fork(user, sourceThread, targetThread, title, keepMessages, keepUserTurns) {
    if (!validThread(targetThread)) fail(422, '新对话标识无效');
    return this.serialize(user, async () => {
      await this.assertOwned(user, sourceThread);
      const meta = await this.loadMeta(user);
      const sourceFile = this.file(user, sourceThread);
      const targetFile = this.file(user, targetThread);
      const raw = await readFile(sourceFile, 'utf8');
      const content = keepUserTurns !== undefined ? historyThroughUserTurns(raw, keepUserTurns) : keepMessages === undefined ? raw : historyPrefix(raw, keepMessages);
      const lines = content.split('\n');
      if (lines[0]) {
        try {
          const header = JSON.parse(lines[0]);
          if (header.type === 'session') {
            header.id = targetThread;
            lines[0] = JSON.stringify(header);
          }
        } catch {}
      }
      await writeFile(targetFile, lines.join('\n'), { mode: 0o600, flag: 'wx' });
      const newTitle = normalizeTitle(title || (meta.chats[sourceThread]?.title || '对话') + ' (分支)');
      const srcChat = meta.chats[sourceThread] || {};
      meta.chats[targetThread] = {
        title: newTitle,
        projectId: srcChat.projectId || 'default',
        permission: srcChat.permission || { scope: 'project_only', extraProjects: {} },
        updatedAt: Date.now(),
      };
      await this.saveMeta(user, meta);
      return { ok: true, id: targetThread, title: newTitle, projectId: meta.chats[targetThread].projectId };
    });
  }
  async truncate(user, thread, keepMessagesCount, keepUserTurns) {
    return this.serialize(user, async () => {
      await this.assertOwned(user, thread);
      const sourceFile = this.file(user, thread);
      const content = await readFile(sourceFile, 'utf8');
      const prefix = keepUserTurns !== undefined ? historyThroughUserTurns(content, keepUserTurns) : historyPrefix(content, keepMessagesCount);
      await writeFile(sourceFile + '.rewind-backup', content, { mode: 0o600 });
      const temporary = sourceFile + '.tmp';
      await writeFile(temporary, prefix, { mode: 0o600 });
      await rename(temporary, sourceFile);
      return { ok: true, keptMessages: keepMessagesCount };
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
      result.push({
        id,
        title: saved.title || title,
        pinned: saved.pinned === true,
        archived: saved.archived === true,
        updated: info.mtimeMs,
        projectId: saved.projectId || 'default',
        permission: saved.permission || { scope: 'project_only', extraProjects: {} },
      });
    }
    // Keep pinned first, then most recently active; archived stays in the same stream.
    const present=new Set(result.map(item=>item.id));
    for(const [id,item]of Object.entries(meta.chats||{}))if(!present.has(id)&&item.createdAt&&['pending','agent'].includes(item.titleSource))result.push({id,title:item.title||'新任务',updated:item.createdAt||item.updatedAt,projectId:item.projectId||'default',permission:item.permission,pinned:item.pinned===true,archived:item.archived===true});
    return result.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated - a.updated || (a.id < b.id ? -1 : 1));
  }
  async export(user, thread, format, secrets = []) {
    if (format !== 'md' && format !== 'json') fail(422, '导出格式无效');
    const info = await this.assertOwned(user, thread);
    if (info.size > MAX_SESSION_READ_BYTES) fail(413, '此对话超过导出上限');
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

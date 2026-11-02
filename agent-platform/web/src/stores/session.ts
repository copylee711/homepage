import { reactiveLive, handleEvent } from '../services/live.mjs';
import { defineStore } from 'pinia';
import { reactive } from 'vue';
import { get, post, setCsrf, ApiError } from '../services/api';
import { streamPrompt } from '../services/stream';
import { useUi } from './ui';

export type PermissionScope = 'project_only' | 'scoped' | 'full';

export interface ChatPermission {
  scope: PermissionScope;
  extraProjects?: Record<string, 'read' | 'write'>;
  execution?: 'ask' | 'edit' | 'auto';
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  chatCount?: number;
}

export interface Chat {
  id: string;
  title: string;
  updated: number;
  pinned?: boolean;
  archived?: boolean;
  projectId?: string;
  permission?: ChatPermission;
}

export interface Identity {
  csrf: string; admin: boolean; can_execute: boolean; model?: string;
  grant_expires_at?: number; user?: { id: string; name: string; avatar?: string };
}

export interface WorkspaceRef {
  path: string;
  name: string;
  type?: 'file' | 'dir' | 'symlink' | 'image';
  size?: number;
  previewUrl?: string;
  base64?: string;
  mimeType?: string;
}

export interface TextQuote {
  id: string;
  text: string;
  source?: string;
}

function uuid() {
  return (crypto as any).randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); });
}

/** The central store: identity, chat list, the active conversation transcript and
    the live streaming task. Components read reactive state and call actions. */
export const useSession = defineStore('session', {
  state: () => ({
    auth: null as Identity | null,
    booted: false,
    bootError: '' as string,
    projects: [] as Project[],
    projectsLoading: false,
    lastProjectId: (typeof localStorage !== 'undefined' ? localStorage.getItem('iris-last-project') : null) || 'default',
    newChatProjectId: null as string | null,
    newChatPermission: { scope: 'project_only', extraProjects: {} as Record<string, 'read' | 'write'> } as ChatPermission,
    chats: [] as Chat[],
    chatsLoading: true,
    chatsError: '' as string,
    chatId: null as string | null,
    messages: [] as any[],        // transcript for the active chat
    workspaceRefs: [] as WorkspaceRef[], // referenced workspace files attached to composer
    textQuotes: [] as TextQuote[],       // quoted message excerpts attached to composer
    draftText: '' as string,             // prompt restored to composer by rewind or draft actions
    loadingChat: false,
    chatError: '' as string,
    busy: false,
    stopping: false,
    lastUserText: '',
    // live streaming assistant view model (null when idle)
    live: null as any,
    controller: null as AbortController | null,
    snapshots: new Map<string, any>(),
  }),
  getters: {
    canExecute: (s) => !!s.auth?.can_execute,
    isAdmin: (s) => !!s.auth?.admin,
    modelLabel: (s) => s.auth?.model || 'Iris 模型',
    currentChat: (s) => s.chats.find(c => c.id === s.chatId) || null,
    isEmpty: (s) => s.messages.length === 0 && !s.live,
    currentProjectId: (s): string => s.chats.find(c => c.id === s.chatId)?.projectId || s.newChatProjectId || s.lastProjectId || 'default',
    currentProject: (s): Project => {
      const pid = s.chats.find(c => c.id === s.chatId)?.projectId || s.newChatProjectId || s.lastProjectId || 'default';
      return s.projects.find(p => p.id === pid) || { id: pid, name: pid === 'default' ? '默认项目' : pid, createdAt: 0 };
    },
    currentChatPermission: (s): ChatPermission => {
      const chat = s.chats.find(c => c.id === s.chatId);
      if (chat?.permission) return chat.permission;
      return s.newChatPermission || { scope: 'project_only', extraProjects: {} };
    },
  },
  actions: {
    async answerQuestion(id: string, answer: string) {
      const item = this.live?.questions?.find((q: any) => q.id === id);
      if (!item || item.state !== 'pending' || item.saving) return;
      item.saving = true; item.error = '';
      try { await post('/api/questions/answer', { thread: this.chatId, id, answer }); item.state = 'answered'; item.answer = answer; }
      catch(e: any) { item.error = e.message; if (e.status === 409) item.state = 'expired'; }
      finally { item.saving = false; }
    },
    async steer(message: string) {
      await post('/api/steer', { thread: this.chatId, message });
      if (this.live) this.live.status = '补充指令已发送，模型将在下一个处理点接收';
      useUi().toast('已补充指令', { tone: 'success' });
    },
    async resolveApproval(id: string, allow: boolean) {
      const approval = this.live?.approvals?.find((item: any) => item.id === id);
      if (!approval || approval.state !== 'pending' || approval.saving) return;
      approval.saving = true; approval.error = '';
      try {
        await post('/api/approvals/resolve', { thread: this.chatId, id, allow });
        approval.state = allow ? 'allowed' : 'denied';
      } catch (error: any) {
        approval.error = error.message || '提交审批失败，请重试';
        if (error.status === 409) approval.state = 'expired';
      } finally { approval.saving = false; }
    },
    applyIdentity(value: Identity) {
      const changedUser = this.auth && (this.auth.user?.id !== value.user?.id || !value.can_execute);
      this.auth = value;
      setCsrf(value.csrf);
      if (changedUser) { this.snapshots.clear(); this.messages = []; this.live = null; }
    },
    async refreshIdentity() {
      try { this.applyIdentity(await get('/api/me')); return true; }
      catch (error: any) {
        if (this.auth) this.applyIdentity({ ...this.auth, admin: false, can_execute: false });
        return false;
      }
    },
    async boot() {
      try {
        const me = await get('/api/me');
        this.applyIdentity(me);
        this.booted = true;
        if (!me.can_execute) { this.chatsLoading = false; return; }
        await Promise.all([this.loadProjects(), this.loadChats()]);
        const id = new URLSearchParams(location.search).get('chat');
        if (id && /^[a-f0-9-]{36}$/.test(id)) await this.selectChat(id);
        else this.startNew();
      } catch (error: any) {
        this.bootError = error.message || '无法读取账户，请刷新重试。';
      }
    },
    async loadProjects() {
      this.projectsLoading = true;
      try {
        const data = await get('/api/projects');
        this.projects = data.projects || [];
        if (!this.projects.some(p => p.id === 'default')) {
          this.projects.unshift({ id: 'default', name: '默认项目', createdAt: 0 });
        }
        if (!this.projects.some(p => p.id === this.lastProjectId)) this.lastProjectId = 'default';
        if (this.newChatProjectId && !this.projects.some(p => p.id === this.newChatProjectId)) this.newChatProjectId = 'default';
      } catch {
        this.projects = [{ id: 'default', name: '默认项目', createdAt: 0 }];
      } finally {
        this.projectsLoading = false;
      }
    },
    async createProject(id: string, name?: string, description?: string) {
      const p = await post('/api/projects/create', { id, name: name || id, description });
      await this.loadProjects();
      return p;
    },
    async renameProject(id: string, name: string) {
      const p = await post('/api/projects/rename', { id, name });
      await this.loadProjects();
      return p;
    },
    async deleteProject(id: string) {
      await post('/api/projects/delete', { id });
      if (this.lastProjectId === id) this.lastProjectId = 'default';
      if (this.newChatProjectId === id) this.newChatProjectId = 'default';
      await Promise.all([this.loadProjects(), this.loadChats()]);
    },
    async setChatProject(thread: string, projectId: string) {
      await post('/api/chats/project', { thread, projectId });
      const c = this.chats.find(x => x.id === thread);
      if (c) c.projectId = projectId;
      this.lastProjectId = projectId;
      try { localStorage.setItem('iris-last-project', projectId); } catch {}
      await this.loadProjects();
    },
    async setChatPermission(thread: string, permission: ChatPermission) {
      const c = this.chats.find(x => x.id === thread);
      if (c || this.busy) {
        const result = await post('/api/chats/permission', { thread, permission });
        if (c) c.permission = result.permission || permission;
        else this.newChatPermission = result.permission || permission;
      } else {
        this.newChatPermission = permission;
      }
    },
    async loadChats() {
      this.chatsLoading = true; this.chatsError = '';
      try { this.chats = (await get('/api/chats')).chats || []; }
      catch (error: any) { this.chatsError = error.message || '无法读取对话'; }
      finally { this.chatsLoading = false; }
    },
    setChatUrl(id: string | null) {
      history.replaceState(null, '', id ? '/?chat=' + encodeURIComponent(id) : '/');
    },
    startNew(targetProjectId?: string) {
      if (this.busy) return;
      this.chatId = uuid();
      this.messages = [];
      this.workspaceRefs = [];
      this.textQuotes = [];
      this.live = null;
      this.lastUserText = '';
      const chosen = targetProjectId || this.currentChat?.projectId || this.lastProjectId || 'default';
      this.newChatProjectId = chosen;
      this.lastProjectId = chosen;
      try { localStorage.setItem('iris-last-project', chosen); } catch {}
      this.setChatUrl(this.chatId);
    },
    addWorkspaceRef(item: { path: string; name?: string; type?: 'file' | 'dir' | 'symlink' | 'image'; size?: number; previewUrl?: string; base64?: string; mimeType?: string }) {
      const clean = String(item.path || '').replace(/^\/workspace\/?/, '').replace(/^\/+/, '');
      if (!clean) return;
      const name = item.name || clean.split('/').pop() || clean;
      if (!this.workspaceRefs.some(r => r.path === clean)) {
        this.workspaceRefs.push({
          path: clean,
          name,
          type: item.type || (clean.endsWith('/') ? 'dir' : 'file'),
          size: item.size,
          previewUrl: item.previewUrl,
          base64: item.base64,
          mimeType: item.mimeType,
        });
      }
    },
    removeWorkspaceRef(path: string) {
      const clean = String(path || '').replace(/^\/workspace\/?/, '').replace(/^\/+/, '');
      this.workspaceRefs = this.workspaceRefs.filter(r => r.path !== clean);
    },
    clearWorkspaceRefs() {
      this.workspaceRefs = [];
    },
    addTextQuote(text: string, source = 'Iris') {
      const clean = String(text || '')
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n+/g, '\n\n')
        .replace(/(?<=\S)\n(?=\S)/g, ' ')
        .trim();
      if (!clean) return;
      if (this.textQuotes.some(q => q.text === clean)) return;
      this.textQuotes.push({
        id: uuid(),
        text: clean,
        source,
      });
    },
    removeTextQuote(id: string) {
      this.textQuotes = this.textQuotes.filter(q => q.id !== id);
    },
    clearTextQuotes() {
      this.textQuotes = [];
    },
    async selectChat(id: string) {
      if (this.busy) return;
      this.chatId = id;
      const found = this.chats.find(c => c.id === id);
      if (found?.projectId) {
        this.lastProjectId = found.projectId;
        try { localStorage.setItem('iris-last-project', found.projectId); } catch {}
      }
      this.newChatProjectId = null;
      this.setChatUrl(id);
      this.workspaceRefs = [];
      this.textQuotes = [];
      this.live = null;
      const cached = this.snapshots.get(id);
      if (cached) { this.messages = cached.messages || []; }
      else { this.messages = []; this.loadingChat = true; }
      this.chatError = '';
      try {
        const value = await get('/api/session?chat=' + encodeURIComponent(id));
        if (this.chatId !== id) return;
        this.snapshots.set(id, value);
        this.messages = value.messages || [];
        this.busy = value.busy === true;
        this.lastUserText = lastUser(this.messages);
      } catch (error: any) {
        if (this.chatId !== id) return;
        this.chatError = error.message || '无法读取对话。';
      } finally { this.loadingChat = false; }
    },
    async send(text: string, opts: { retry?: boolean; continuation?: boolean } = {}) {
      const rawText = String(text || '').trim();
      const attachedRefs = [...this.workspaceRefs];
      const attachedQuotes = [...this.textQuotes];
      if (!rawText && !attachedRefs.length && !attachedQuotes.length) return;
      if (!this.canExecute || this.busy) return;
      if (!this.chatId) this.startNew();
      const thread = this.chatId!;
      this.snapshots.delete(thread);

      const sections: string[] = [];
      if (attachedRefs.length > 0) {
        sections.push('【工作区引用文件】\n' + attachedRefs.map(r => `- \`/workspace/${r.path}\``).join('\n'));
      }
      if (attachedQuotes.length > 0) {
        sections.push('【引用内容】\n' + attachedQuotes.map(q => q.text.split('\n').map(l => '> ' + l).join('\n')).join('\n\n'));
      }
      if (rawText) {
        sections.push(rawText);
      } else {
        sections.push('请根据以上引用内容进行分析并回答。');
      }

      const message = sections.join('\n\n');
      this.workspaceRefs = [];
      this.textQuotes = [];

      const images: Array<{ type: 'image'; data: string; mimeType: string }> = [];
      for (const r of attachedRefs) {
        if (r.type === 'image' || /\.(png|jpe?g|gif|webp|bmp)$/i.test(r.name)) {
          if (r.base64) {
            images.push({ type: 'image', data: r.base64, mimeType: r.mimeType || 'image/png' });
          } else if (r.path) {
            try {
              const imgData: any = await post('/api/image', { path: r.path });
              if (imgData?.data && imgData?.mime) {
                images.push({ type: 'image', data: imgData.data, mimeType: imgData.mime });
              }
            } catch {}
          }
        }
      }

      const turnStartTime = Date.now();
      this.messages.push({
        role: 'user',
        timestamp: turnStartTime,
        content: message,
        refs: attachedRefs.map(r => ({ path: r.path, name: r.name, type: r.type, size: r.size, previewUrl: r.previewUrl })),
        quotes: attachedQuotes.map(q => ({ id: q.id, text: q.text, source: q.source })),
        _rawPrompt: rawText,
        _fresh: true,
      });
      this.lastUserText = rawText || message;
      this.stopping = false;
      const controller = new AbortController();
      this.controller = controller;
      this.busy = true;
      const live = reactive(reactiveLive());
      this.live = live;
      let received = false;
      try {
        const result = await streamPrompt({
          thread, message, images: images.length ? images : undefined, thinking: useUi().thinkingLevel, projectId: this.currentProjectId,
          permission: this.currentChatPermission, signal: controller.signal,
          onEvent: (event) => { received = true; handleEvent(event, live); },
        });
        if (!result.settled && !this.stopping) throw new ApiError('连接在任务完成前关闭，请刷新对话查看实际结果。', 0);
        live.finished = true;
        live.status = '';
      } catch (error: any) {
        if (error.name === 'AbortError') {
          if (this.stopping) { live.stopped = true; }
          else live.error = '与服务器的流式连接中断，请刷新对话后重试。';
        } else {
          if (!received) { this.messages.pop(); }
          live.error = error.message || '任务启动失败，请重试。';
        }
      } finally {
        // fold the live view model into the transcript as a finalized message
        const durationMs = Math.max(0, Date.now() - turnStartTime);
        this.messages.push({ role: 'assistant', timestamp: Date.now(), durationMs, content: live.blocks, _vm: live, _fresh: true });
        this.live = null;
        this.controller = null;
        this.busy = false;
        this.stopping = false;
        await this.refreshIdentity();
        if (this.canExecute) { try { await this.loadChats(); } catch {} }
      }
    },
    async stop() {
      if (!this.busy || this.stopping) return;
      this.stopping = true;
      try { await post('/api/abort', { thread: this.chatId }); } catch {}
      this.controller?.abort();
    },
    async renameChat(id: string, title: string) {
      const t = String(title || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 80) return false;
      await post('/api/chats/rename', { thread: id, title: t });
      const c = this.chats.find(x => x.id === id);
      if (c) c.title = t;
      return true;
    },
    async retryFromMessage(msg: any) {
      if (this.busy) return;
      const idx = this.messages.findIndex(m => m === msg || (m.timestamp === msg.timestamp && m.role === msg.role));
      if (idx < 0) return;
      let userIdx = -1;
      for (let i = idx - 1; i >= 0; i--) {
        if (this.messages[i].role === 'user') { userIdx = i; break; }
      }
      if (userIdx < 0) return;
      const userMsg = this.messages[userIdx];
      const rawPrompt = userMsg._rawPrompt || userMsg.content;
      if (this.chatId) {
        try { await post('/api/chats/truncate', { thread: this.chatId, keepUserTurns: this.messages.slice(0, userIdx).filter(m => m.role === 'user').length }); }
        catch (error: any) { useUi().toast(error.message || '重试失败，历史已保留', { tone: 'error' }); return; }
      }
      this.messages = this.messages.slice(0, userIdx);
      await this.send(rawPrompt);
    },
    async rewindFromMessage(msg: any) {
      if (this.busy) return;
      const idx = this.messages.findIndex(m => m === msg || (m.timestamp === msg.timestamp && m.role === msg.role));
      if (idx < 0) return;
      let userIdx = idx;
      if (msg.role === 'assistant') {
        for (let i = idx - 1; i >= 0; i--) {
          if (this.messages[i].role === 'user') { userIdx = i; break; }
        }
      }
      const userMsg = this.messages[userIdx];
      const rawPrompt = userMsg?._rawPrompt || userMsg?.content || '';
      if (this.chatId) {
        try { await post('/api/chats/truncate', { thread: this.chatId, keepUserTurns: this.messages.slice(0, userIdx).filter(m => m.role === 'user').length }); }
        catch (error: any) { useUi().toast(error.message || '回退失败，历史已保留', { tone: 'error' }); return; }
      }
      this.messages = this.messages.slice(0, userIdx);
      this.draftText = rawPrompt;
    },
    async forkFromMessage(msg: any) {
      if (this.busy || !this.chatId) return null;
      const idx = this.messages.findIndex(m => m === msg || (m.timestamp === msg.timestamp && m.role === msg.role));
      const keep = idx >= 0 ? idx + 1 : this.messages.length;
      try {
        const res = await post('/api/chats/fork', {
          thread: this.chatId,
          title: (this.currentChat?.title || '新任务') + ' (分支)',
          keepUserTurns: this.messages.slice(0, keep).filter(m => m.role === 'user').length,
        });
        await this.loadChats();
        if (res?.id) {
          await this.selectChat(res.id);
          return { id: res.id, title: res.title || '新分支' };
        }
      } catch (err: any) {
        useUi().toast('分叉失败: ' + err.message, { tone: 'error' });
      }
      return null;
    },
    async activateModel(id: string, model?: string) {
      const result = await post('/api/providers/activate', { id, model });
      await this.refreshIdentity();
      return result;
    },
    async getGitStatus(projectId?: string) {
      const pid = projectId || this.currentProjectId || 'default';
      try {
        const res = await get(`/api/git/status?project=${encodeURIComponent(pid)}`);
        return res as { isGit: boolean; branch: string; branches: string[] };
      } catch {
        return { isGit: false, branch: '', branches: [] };
      }
    },
    async checkoutGitBranch(branch: string, projectId?: string) {
      const pid = projectId || this.currentProjectId || 'default';
      const res = await post('/api/git/checkout', { project: pid, branch });
      return res as { ok: boolean; branch: string };
    },
  },
});

function lastUser(items: any[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const m = items[i];
    if (m?.role === 'user') return typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('\n') : '');
  }
  return '';
}

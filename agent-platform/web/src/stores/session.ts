import { reactiveLive, handleEvent, settleTools } from '../services/live.mjs';
import { resolveTaskPlan } from '../services/plan-state.mjs';
import { defineStore } from 'pinia';
import { reactive } from 'vue';
import { get, post, setCsrf, ApiError } from '../services/api';
import { textContent } from '../services/format';
import { streamPrompt, resumePrompt } from '../services/stream';
import { useUi } from './ui';

type ImagePart = { type: 'image'; data: string; mimeType: string };

export type PermissionScope = 'project_only' | 'scoped' | 'full';

export interface ChatPermission {
  scope: PermissionScope;
  extraProjects?: Record<string, 'read' | 'write'>;
  execution?: 'ask' | 'edit' | 'auto' | 'plan';
}

// The execution mode is a habit, not a per-chat setting: remember the last
// choice so a brand-new task starts in the mode the user last picked. Plan mode
// is a per-task phase, so it is never remembered as the habit.
const EXECUTION_KEY = 'iris-execution';
export function readExecutionPref(): ChatPermission['execution'] {
  try {
    const value = localStorage.getItem(EXECUTION_KEY);
    if (value === 'ask' || value === 'edit' || value === 'auto') return value;
  } catch {}
  return undefined;
}
function writeExecutionPref(execution?: ChatPermission['execution']) {
  if (!execution || execution === 'plan') return;
  try { localStorage.setItem(EXECUTION_KEY, execution); } catch {}
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
  /** Pasted image that lives only in the prompt payload, never in the workspace. */
  inline?: boolean;
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
    newChatPermission: { scope: 'project_only', extraProjects: {} as Record<string, 'read' | 'write'>, execution: readExecutionPref() } as ChatPermission,
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
    // The running stream may belong to another thread than the one on screen;
    // liveThread says which chat `live` renders for, and liveMessages keeps that
    // chat's transcript while the reader browses elsewhere.
    liveThread: null as string | null,
    liveMessages: [] as any[],
    // Every abnormal turn end of the open chat, served beside the transcript so
    // the reason survives a reload and older failures stay visible.
    turnNotes: [] as any[],
    lastUserText: '',
    // live streaming assistant view model (null when idle)
    live: null as any,
    controller: null as AbortController | null,
    snapshots: new Map<string, any>(),
    pendingChatIds: [] as string[],
  }),
  getters: {
    canExecute: (s) => !!s.auth?.can_execute,
    isAdmin: (s) => !!s.auth?.admin,
    modelLabel: (s) => s.auth?.model || 'Iris 模型',
    currentChat: (s) => s.chats.find(c => c.id === s.chatId) || null,
    isEmpty: (s) => s.messages.length === 0 && !(s.live && s.liveThread === s.chatId),
    // The live model belongs to one thread only; other chats keep rendering
    // their own transcript while it streams in the background.
    activeLive: (s): any => (s.live && s.liveThread === s.chatId ? s.live : null),
    // Latest checklist for this chat. Live blocks win over older transcripts,
    // and a stale pending/0/n snapshot cannot roll a completed plan backwards.
    taskPlan: (s): Array<{ step: string; status: string }> => {
      const live = s.live && s.liveThread === s.chatId ? s.live : null;
      return resolveTaskPlan(s.messages, live?.blocks) || [];
    },
    busyHere: (s): boolean => s.busy && s.liveThread === s.chatId,
    busyElsewhere: (s): boolean => s.busy && !!s.liveThread && s.liveThread !== s.chatId,
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
      try { await post('/api/questions/answer', { thread: this.liveThread || this.chatId, id, answer }); item.state = 'answered'; item.answer = answer; }
      catch(e: any) { item.error = e.message; if (e.status === 409) item.state = 'expired'; }
      finally { item.saving = false; }
    },
    async steer(message: string) {
      const thread = this.liveThread || this.chatId;
      await post('/api/steer', { thread, message });
      if (this.live) this.live.status = '补充指令已发送，模型将在下一个处理点接收';
      useUi().toast('已补充指令', { tone: 'success' });
    },
    async resolveApproval(id: string, allow: boolean) {
      const approval = this.live?.approvals?.find((item: any) => item.id === id);
      if (!approval || approval.state !== 'pending' || approval.saving) return;
      approval.saving = true; approval.error = '';
      try {
        await post('/api/approvals/resolve', { thread: this.liveThread || this.chatId, id, allow });
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
      if (changedUser) { this.snapshots.clear(); this.messages = []; this.live = null; this.liveThread = null; this.liveMessages = []; }
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
      writeExecutionPref(permission.execution);
      const c = this.chats.find(x => x.id === thread);
      if (c || this.busy) {
        const result = await post('/api/chats/permission', { thread, permission });
        if (c) c.permission = result.permission || permission;
        else this.newChatPermission = result.permission || permission;
      } else {
        this.newChatPermission = permission;
      }
    },
    // New tasks keep the mode they were created with; remember it even when
    // the choice was made before a chat exists (no setChatPermission round-trip).
    rememberExecution(execution?: ChatPermission['execution']) {
      writeExecutionPref(execution);
    },
    async loadChats() {
      this.chatsLoading = true; this.chatsError = '';
      try { const incoming=(await get('/api/chats')).chats||[];const ids=new Set(incoming.map((c:Chat)=>c.id));const pending=this.chats.filter(c=>this.pendingChatIds.includes(c.id)&&!ids.has(c.id));this.chats=[...pending,...incoming];this.pendingChatIds=this.pendingChatIds.filter(id=>!ids.has(id)); }
      catch (error: any) { this.chatsError = error.message || '无法读取对话'; }
      finally { this.chatsLoading = false; }
    },
    setChatUrl(id: string | null) {
      history.replaceState(null, '', id ? '/?chat=' + encodeURIComponent(id) : '/');
    },
    startNew(targetProjectId?: string) {
      this.chatId = uuid();
      this.messages = [];
      this.workspaceRefs = [];
      this.textQuotes = [];
      this.lastUserText = '';
      const chosen = targetProjectId || this.currentChat?.projectId || this.lastProjectId || 'default';
      this.newChatProjectId = chosen;
      this.lastProjectId = chosen;
      this.newChatPermission = { ...this.newChatPermission, execution: readExecutionPref() };
      try { localStorage.setItem('iris-last-project', chosen); } catch {}
      this.setChatUrl(this.chatId);
    },
    addWorkspaceRef(item: { path: string; name?: string; type?: 'file' | 'dir' | 'symlink' | 'image'; size?: number; previewUrl?: string; base64?: string; mimeType?: string; inline?: boolean }) {
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
          inline: item.inline === true || undefined,
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
      this.chatError = '';
      this.turnNotes = [];
      // Returning to the thread that is still streaming: restore its in-flight
      // transcript (the server copy lacks the current turn) and let the live
      // view render on top.
      if (this.live && this.liveThread === id) {
        this.messages = this.liveMessages;
        this.loadingChat = false;
        this.lastUserText = lastUser(this.messages);
        return;
      }
      const cached = this.snapshots.get(id);
      if (cached) { this.messages = cached.messages || []; this.turnNotes = cached.notes || []; }
      else { this.messages = []; this.loadingChat = true; }
      try {
        const value = await get('/api/session?chat=' + encodeURIComponent(id));
        if (this.chatId !== id) return;
        this.snapshots.set(id, value);
        this.messages = value.messages || [];
        this.turnNotes = value.notes || [];
        // A stream running for another thread owns the global task flag; only
        // trust this thread's own server state when nothing is streaming here.
        if (!this.live) {
          this.busy = value.busy === true;
          this.liveThread = this.busy ? id : null;
          if (this.busy) void this.resumeTurn(id);
        }
        this.lastUserText = lastUser(this.messages);
      } catch (error: any) {
        if (this.chatId !== id) return;
        this.chatError = error.message || '无法读取对话。';
      } finally { this.loadingChat = false; }
    },
    async resumeTurn(thread: string) {
      const controller = new AbortController();
      const live = reactive(reactiveLive());
      const messages = this.messages;
      this.liveMessages = messages;
      this.controller = controller;
      this.live = live;
      let matchedPrompt = false;
      try {
        const result = await resumePrompt({ thread, signal: controller.signal, onEvent: event => {
          if (!matchedPrompt && event.type === 'message_start' && event.message?.role === 'user') {
            matchedPrompt = true;
            const index = messages.findLastIndex(item => item.role === 'user' && item.timestamp === event.message.timestamp);
            if (index >= 0) messages.splice(index + 1);
            else messages.push(event.message);
          }
          if (event.type === 'chat_title' && event.thread === thread) {
            const chat = this.chats.find(c => c.id === thread);
            if (chat) chat.title = event.title;
          }
          handleEvent(event, live);
        } });
        if (!result.settled) throw new ApiError('实时连接已结束，请重新载入对话。', 0);
      } catch (error: any) {
        if (!controller.signal.aborted) useUi().toast(error.message || '实时连接中断', { tone: 'error' });
      } finally {
        this.snapshots.delete(thread);
        let snapshot;
        try { snapshot = await get('/api/session?chat=' + encodeURIComponent(thread)); } catch {}
        if (snapshot && !snapshot.busy) {
          this.snapshots.set(thread, snapshot);
          if (this.chatId === thread) { this.messages = snapshot.messages || []; this.turnNotes = snapshot.notes || []; }
        }
        this.live = null;
        this.liveThread = null;
        this.liveMessages = [];
        this.controller = null;
        this.busy = false;
        this.stopping = false;
        if (this.chatId === thread) this.lastUserText = lastUser(this.messages);
        if (this.canExecute) void this.loadChats();
      }
    },
    async send(text: string, opts: { retry?: boolean; continuation?: boolean; goal?: boolean; replay?: { images: ImagePart[]; refs: WorkspaceRef[]; quotes: TextQuote[] } } = {}) {
      const rawText = typeof text === 'string' ? (opts.replay ? text : text.trim()) : '';
      const attachedRefs = opts.replay?.refs ?? [...this.workspaceRefs];
      const attachedQuotes = opts.replay?.quotes ?? [...this.textQuotes];
      if (!rawText && !attachedRefs.length && !attachedQuotes.length && !opts.replay?.images.length) return;
      if (!this.canExecute || this.busy) return;
      if (!this.chatId) this.startNew();
      const thread = this.chatId!;
      this.snapshots.delete(thread);

      const sections: string[] = [];
      const workspaceRefs = attachedRefs.filter(r => !r.inline);
      const inlineImages = attachedRefs.filter(r => r.inline);
      if (workspaceRefs.length > 0) {
        sections.push('【工作区引用文件】\n' + workspaceRefs.map(r => `- \`/workspace/${r.path}\``).join('\n'));
      }
      if (attachedQuotes.length > 0) {
        sections.push('【引用内容】\n' + attachedQuotes.map(q => q.text.split('\n').map(l => '> ' + l).join('\n')).join('\n\n'));
      }
      const imageOnly = !rawText && !attachedQuotes.length && attachedRefs.length > 0
        && attachedRefs.every(r => r.type === 'image' || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(r.name || ''));
      if (rawText) {
        sections.push(rawText);
      } else if (!imageOnly) {
        sections.push('请根据以上引用内容进行分析并回答。');
      }

      const message = opts.replay ? rawText : sections.join('\n\n');
      if (!opts.replay) { this.workspaceRefs = []; this.textQuotes = []; }

      // Show the chat in the sidebar as soon as the first turn starts, instead
      // of waiting for the server list refresh after the stream ends. The first
      // message is a better label than a "naming…" placeholder; an attachment-
      // only message still falls back to the generic label until the agent
      // calls set_chat_title.
      if (!this.chats.some(c => c.id === thread)) {
        const seedTitle = rawText.replace(/\s+/g, ' ').trim().slice(0, 60) || '新任务';
        this.pendingChatIds.push(thread);
        this.chats.unshift({ id: thread, title: seedTitle, updated: Date.now(), projectId: this.currentProjectId, permission: this.currentChatPermission });
      }

      const images: ImagePart[] = opts.replay?.images ?? [];
      for (const r of opts.replay ? [] : attachedRefs) {
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
      // Keep a direct reference to the streaming chat's transcript: the reader
      // may switch to another chat while this stream continues.
      const streamMessages = this.messages;
      streamMessages.push({
        role: 'user',
        timestamp: turnStartTime,
        content: message,
        refs: attachedRefs.map(r => ({ path: r.path, name: r.name, type: r.type, size: r.size, previewUrl: r.previewUrl, inline: r.inline })),
        quotes: attachedQuotes.map(q => ({ id: q.id, text: q.text, source: q.source })),
        _rawPrompt: rawText,
        _promptImages: images,
        _fresh: true,
      });
      this.lastUserText = rawText || message;
      this.stopping = false;
      this.turnNotes = [];
      // Tab hide, pagehide and beforeunload must not abort this request.
      // The gateway renews the sandbox lease; only stop() cancels the prompt.
      const controller = new AbortController();
      this.controller = controller;
      this.busy = true;
      this.liveThread = thread;
      this.liveMessages = streamMessages;
      const live = reactive(reactiveLive());
      this.live = live;
      let received = false;
      try {
        const result = await streamPrompt({
          thread, message, images: images.length ? images : undefined, thinking: useUi().thinkingLevel, projectId: this.currentProjectId,
          permission: this.currentChatPermission, goal: opts.goal, signal: controller.signal,
          onEvent: (event) => { received = true;if(event.type==='chat_title'&&event.thread===thread){const chat=this.chats.find(c=>c.id===thread);if(chat)chat.title=event.title;}handleEvent(event, live); },
        });
        if (!result.settled && !this.stopping) throw new ApiError('连接在任务完成前关闭，请刷新对话查看实际结果。', 0);
        live.finished = true;
        live.status = '';
      } catch (error: any) {
        if (this.stopping && (error.name === 'AbortError' || error.message === '任务已停止')) {
          live.stopped = true;
        } else if (error.name === 'AbortError') {
          live.error = '与服务器的流式连接中断，请刷新对话后重试。';
        } else {
          if (!received) { streamMessages.pop(); }
          live.error = error.message || '任务启动失败，请重试。';
        }
      } finally {
        settleTools(live, live.stopped ? 'stopped' : 'interrupted');
        // fold the live view model into the transcript as a finalized message
        const durationMs = Math.max(0, Date.now() - turnStartTime);
        streamMessages.push({ role: 'assistant', timestamp: Date.now(), durationMs, content: live.blocks, stopReason: live.stopReason === 'length' ? 'length' : undefined, _vm: live, _fresh: true });
        const notes = live.error ? [{ at: Date.now(), kind: 'error', message: live.error }]
          : live.stopped ? [{ at: Date.now(), kind: 'stopped', message: '任务已由你停止。' }] : [];
        if (this.chatId === thread) this.turnNotes = [...this.turnNotes, ...notes];
        this.snapshots.set(thread, { messages: streamMessages, busy: false, notes });
        this.live = null;
        this.liveThread = null;
        this.liveMessages = [];
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
      const thread = this.liveThread || this.chatId;
      const controller = this.controller;
      try { if (thread) await post('/api/abort', { thread }); }
      catch (error: any) {
        this.stopping = false;
        useUi().toast(error.message || '停止任务失败，请重试', { tone: 'error' });
        return;
      }
      controller?.abort();
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
      const rawPrompt = textContent(userMsg.content);
      const parts = Array.isArray(userMsg.content) ? userMsg.content : [];
      const images: ImagePart[] = (userMsg._promptImages ?? parts).filter((part: any) =>
        part?.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string');
      if (!rawPrompt.trim() && !images.length) {
        useUi().toast('原消息没有可重新发送的内容，历史已保留', { tone: 'error' });
        return;
      }
      if (this.chatId) {
        try { await post('/api/chats/truncate', { thread: this.chatId, keepUserTurns: this.messages.slice(0, userIdx).filter(m => m.role === 'user').length }); }
        catch (error: any) { useUi().toast(error.message || '重试失败，历史已保留', { tone: 'error' }); return; }
      }
      this.messages = this.messages.slice(0, userIdx);
      await this.send(rawPrompt, { replay: { images, refs: userMsg.refs || [], quotes: userMsg.quotes || [] } });
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
      const rawPrompt = userMsg?._rawPrompt ?? textContent(userMsg?.content);
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

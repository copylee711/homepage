import { defineStore } from 'pinia';
import { get, post, setCsrf, ApiError } from '../services/api';
import { streamPrompt } from '../services/stream';

export interface Chat { id: string; title: string; updated: number; pinned?: boolean; archived?: boolean; }
export interface Identity {
  csrf: string; admin: boolean; can_execute: boolean; model?: string;
  grant_expires_at?: number; user?: { id: string; name: string; avatar?: string };
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
    chats: [] as Chat[],
    chatsLoading: true,
    chatsError: '' as string,
    chatId: null as string | null,
    messages: [] as any[],        // transcript for the active chat
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
  },
  actions: {
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
        await this.loadChats();
        const id = new URLSearchParams(location.search).get('chat');
        if (id && /^[a-f0-9-]{36}$/.test(id)) await this.selectChat(id);
        else this.startNew();
      } catch (error: any) {
        this.bootError = error.message || '无法读取账户，请刷新重试。';
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
    startNew() {
      if (this.busy) return;
      this.chatId = uuid();
      this.messages = [];
      this.live = null;
      this.lastUserText = '';
      this.setChatUrl(this.chatId);
    },
    async selectChat(id: string) {
      if (this.busy) return;
      this.chatId = id;
      this.setChatUrl(id);
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
      const message = String(text || '').trim();
      if (!message || !this.canExecute || this.busy) return;
      if (!this.chatId) this.startNew();
      const thread = this.chatId!;
      this.snapshots.delete(thread);
      this.messages.push({ role: 'user', timestamp: Date.now(), content: message, _fresh: true });
      this.lastUserText = message;
      this.stopping = false;
      const controller = new AbortController();
      this.controller = controller;
      this.busy = true;
      const live = reactiveLive();
      this.live = live;
      let received = false;
      try {
        const result = await streamPrompt({
          thread, message, signal: controller.signal,
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
        this.messages.push({ role: 'assistant', timestamp: Date.now(), content: live.blocks, _vm: live, _fresh: true });
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
    async activateModel(id: string, model?: string) {
      const result = await post('/api/providers/activate', { id, model });
      await this.refreshIdentity();
      return result;
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

// A plain reactive-friendly object describing the streaming assistant turn.
function reactiveLive() {
  return { blocks: [] as any[], status: '正在连接模型…', spinner: true, finished: false, error: '', stopped: false, tools: {} as Record<string, any> };
}

// Reduce a runner stream event into the live view model's block list.
function handleEvent(event: any, live: any) {
  if (!event || typeof event !== 'object') return;
  const vm = live;
  const ensureBlock = (index: number, type: string) => {
    let b = vm.blocks.find((x: any) => x.index === index);
    if (!b) { b = { index, type, text: '', fresh: true }; vm.blocks.push(b); vm.blocks.sort((a: any, z: any) => a.index - z.index); }
    return b;
  };
  if (event.type === 'message_update') {
    const u = event.assistantMessageEvent; if (!u) return;
    switch (u.type) {
      case 'text_start': ensureBlock(u.contentIndex, 'text'); break;
      case 'text_delta': { const b = ensureBlock(u.contentIndex, 'text'); b.text += u.delta || ''; break; }
      case 'text_end': { const b = ensureBlock(u.contentIndex, 'text'); if (typeof u.content === 'string') b.text = u.content; break; }
      case 'thinking_start': ensureBlock(u.contentIndex, 'thinking'); break;
      case 'thinking_delta': { const b = ensureBlock(u.contentIndex, 'thinking'); b.text += u.delta || ''; break; }
      case 'thinking_end': { const b = ensureBlock(u.contentIndex, 'thinking'); if (typeof u.content === 'string') b.text = u.content; break; }
      case 'toolcall_start': { const b = ensureBlock(u.contentIndex, 'tool'); b.id = u.id || u.toolCall?.id; b.name = u.toolName || u.toolCall?.name || 'tool'; b.state = 'pending'; b.args = ''; vm.status = '正在准备工具…'; break; }
      case 'toolcall_delta': { const b = ensureBlock(u.contentIndex, 'tool'); b.args = (b.args || '') + (u.delta || ''); break; }
      case 'toolcall_end': { const b = ensureBlock(u.contentIndex, 'tool'); const tc = u.toolCall || {}; b.id = tc.id || b.id; b.name = tc.name || b.name; b.args = tc.arguments ? JSON.stringify(tc.arguments, null, 2) : b.args; b.state = 'pending'; break; }
    }
    return;
  }
  if (event.type === 'tool_execution_start') {
    const b = vm.blocks.find((x: any) => x.type === 'tool' && x.id === event.toolCallId) || ensureBlock(1e6 + Object.keys(vm.tools).length, 'tool');
    b.id = event.toolCallId; b.name = event.toolName || b.name; b.state = 'running'; if (event.args) b.args = JSON.stringify(event.args, null, 2);
    b.started = Date.now(); vm.status = '正在执行工具 · ' + (event.toolName || ''); vm.spinner = true;
    return;
  }
  if (event.type === 'tool_execution_end') {
    const b = vm.blocks.find((x: any) => x.type === 'tool' && x.id === event.toolCallId);
    if (b) { b.state = event.isError ? 'error' : 'success'; b.result = toolText(event.result); b.durationMs = event.durationMs || (b.started ? Date.now() - b.started : 0); }
    vm.status = '正在整理结果…'; return;
  }
  if (event.type === 'gateway_error') throw new ApiError(event.error || '任务中断，请重试', 0);
  if (event.type === 'agent_settled') { if (event.aborted) vm.stopped = true; vm.status = ''; vm.spinner = false; }
}

function toolText(value: any): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter(p => p?.type === 'text').map(p => p.text || '').join('\n') || value.map(p => p?.text || '').join('');
  if (value && typeof value === 'object') return String(value.output || value.stdout || JSON.stringify(value));
  return String(value ?? '');
}

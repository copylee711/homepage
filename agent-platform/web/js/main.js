import { $, $$, el, icon, iconButton, hydrateIcons, announce, trapTab, platformKey } from './dom.js';
import { setCsrf, get, post, ApiError } from './api.js';
import { Transcript, textContent } from './messages.js';
import { ChatSidebar } from './chats.js';
import { WorkspacePanel } from './workspace.js';
import { setupDialogs, bindConfirmDialog } from './dialogs.js';
import { streamPrompt } from './stream.js';
import { openMenu, closeMenu } from './menu.js';
import { grantDate, workspaceReference } from './format.js';

const app = $('#app'), sidebarEl = $('#sidebar'), mainEl = $('#main'), scrim = $('#scrim');
const notice = $('#notice'), noticeText = $('#notice-text'), noticeAction = $('#notice-action');
const connection = $('#connection-banner');
const messages = $('#messages'), conversation = $('#conversation'), welcome = $('#welcome');
const prompt = $('#prompt'), promptForm = $('#prompt-form'), send = $('#send'), stop = $('#stop');
const taskState = $('#task-state'), composerCount = $('#composer-count');
const chatTitle = $('#chat-title'), chatSubtitle = $('#chat-subtitle'), modelChip = $('#model-chip');
const menuToggle = $('#menu-toggle'), workspaceToggle = $('#workspace-toggle'), chatMenuButton = $('#chat-menu');
const jumpLatest = $('#jump-latest');
const themeToggle = $('#theme-toggle');
const mobile = matchMedia('(max-width: 860px)');
const narrowPanel = matchMedia('(max-width: 1180px)');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

let auth = null;
let chatId = null;
let busy = false;
let stopping = false;
let streamController = null;
let lastUserText = '';
let drawer = null;
let noticeHandler = null;
let workspaceRestoreTimer = null;

const transcript = new Transcript({
  container: messages,
  welcome,
  onNotice: (text, options) => toast(text, options),
  onRetry: () => { if (lastUserText) void sendPrompt(lastUserText, { retry: true }); },
  onContinue: () => void sendPrompt('继续完成上一条任务。', { continuation: true }),
});

const sidebar = new ChatSidebar({
  list: $('#chat-list'),
  search: $('#chat-search'),
  clear: $('#clear-chat-search'),
  activeTab: $('#view-active'),
  archivedTab: $('#view-archived'),
  onSelect: chat => void selectChat(chat.id),
  onRename: chat => dialogs.openRename(chat, async title => {
    await sidebar.rename(chat, title);
    if (chat.id === chatId) syncHeader();
    sidebar.focusChat(chat.id);
  }),
  onArchive: (chat, archived) => {
    if (chat.id === chatId) syncHeader();
    toast(archived ? '已归档“' + chat.title + '”' : '已恢复“' + chat.title + '”', {
      tone: 'success',
      action: archived ? { label: '撤销', run: () => void setArchived(chat, false) } : null,
    });
    announce(archived ? '对话已归档，可随时恢复' : '对话已恢复');
  },
  onNotice: (text, options) => toast(text, options),
  onMutated: event => { if (event.chat.id === chatId) syncHeader(); },
});

const workspace = new WorkspacePanel({
  panel: $('#workspace'),
  crumb: $('#ws-crumb'),
  list: $('#ws-list'),
  status: $('#ws-status'),
  preview: $('#ws-preview'),
  previewTitle: $('#ws-preview-title'),
  previewMeta: $('#ws-preview-meta'),
  previewBody: $('#ws-preview-body'),
  previewNote: $('#ws-preview-note'),
  up: $('#ws-up'),
  refresh: $('#ws-refresh'),
  upload: $('#ws-upload'),
  fileInput: $('#ws-file-input'),
  closePreview: $('#ws-close-preview'),
  download: $('#ws-download'),
  insert: $('#ws-insert'),
  onInsert: path => insertWorkspacePath(path),
  notice: (text, options) => toast(text, options),
  confirmOverwrite: path => dialogs.confirm({
    title: '覆盖已有文件',
    body: '工作区中已存在 “' + path + '”。覆盖会替换其现有内容，此操作无法撤销。',
    confirmLabel: '覆盖文件',
    tone: 'danger',
  }),
});

const dialogs = setupDialogs({
  notice: (text, options) => toast(text, options),
  onModelChange: () => { void refreshIdentity(); },
});
bindConfirmDialog();

function isMobile() { return mobile.matches; }
function isNarrowPanel() { return narrowPanel.matches; }
function scrollBehavior() { return reduced.matches ? 'auto' : 'smooth'; }

function toast(message, { tone = 'info', action = null, duration = 4800 } = {}) {
  const region = $('#toasts');
  const item = el('div', { class: 'toast tone-' + tone, attrs: { role: tone === 'error' ? 'alert' : 'status' } });
  item.append(el('span', { class: 'toast-text', text: message }));
  if (action) {
    const button = el('button', { type: 'button', class: 'toast-action', text: action.label });
    button.addEventListener('click', () => { remove(); action.run(); });
    item.append(button);
  }
  const close = iconButton('x', '关闭通知', 'toast-close');
  close.addEventListener('click', () => remove());
  item.append(close);
  region.append(item);
  let timer;
  const remove = () => { clearTimeout(timer); item.classList.remove('is-visible'); setTimeout(() => item.remove(), 180); };
  requestAnimationFrame(() => item.classList.add('is-visible'));
  timer = setTimeout(remove, duration);
  item.addEventListener('pointerenter', () => clearTimeout(timer));
  item.addEventListener('pointerleave', () => { timer = setTimeout(remove, 2200); });
}
function showNotice(text, { tone = 'info', actionLabel = '', action = null } = {}) {
  notice.hidden = !text;
  notice.className = 'notice' + (tone ? ' tone-' + tone : '');
  noticeText.textContent = text || '';
  noticeAction.hidden = !actionLabel;
  noticeAction.textContent = actionLabel || '';
  noticeHandler = action;
}
function clearNotice() { showNotice(''); }

function setWelcomeMode(mode) {
  const normal = mode !== 'permission';
  $('#welcome-title').textContent = normal ? '开始一段新对话' : '尚未开通执行权限';
  $('#welcome-text').textContent = normal
    ? 'Pi 在隔离的工作区中读写文件、运行命令。沙箱没有网络，任务最长运行 10 分钟。'
    : '此账户可以登录，但尚未获得 Agent 执行权限。已有授权可能已过期或被撤销，请联系管理员开通。';
  $('#starters').hidden = !normal;
}

function updateComposer() {
  const value = prompt.value;
  prompt.style.height = 'auto';
  prompt.style.height = Math.min(prompt.scrollHeight, 220) + 'px';
  composerCount.textContent = value.length > 16000 ? value.length + ' / 20000' : '';
  send.disabled = busy || !auth?.can_execute || !value.trim();
  prompt.disabled = !auth?.can_execute;
  stop.hidden = !busy;
  send.hidden = busy;
  taskState.textContent = busy ? (stopping ? '正在停止任务…' : 'Pi 正在处理任务…')
    : auth?.can_execute ? '独立沙箱 · 无网络' : '尚未开通执行权限';
}
function setBusy(value) {
  busy = value;
  app.classList.toggle('is-busy', value);
  sidebar.setBusy(value);
  $('#new-chat').disabled = value || !auth?.can_execute;
  stop.disabled = stopping;
  updateHeader();
  updateComposer();
}
function syncHeader() {
  const chat = sidebar.chats.find(item => item.id === chatId);
  const title = chat?.title || '新对话';
  chatTitle.textContent = title;
  chatSubtitle.textContent = busy ? '正在生成回复…'
    : chat?.archived ? '已归档'
      : auth?.can_execute ? '独立沙箱 · 无网络' : '暂无执行权限';
  document.title = (busy ? '生成中 · ' : '') + title + ' — Copy Lee Agent';
  chatMenuButton.disabled = !chat || !auth?.can_execute;
  chatMenuButton.title = chat ? '对话操作' : '发送第一条消息后可管理对话';
  workspaceToggle.hidden = !auth?.can_execute;
}
function updateHeader() { syncHeader(); }

function applyIdentity(value) {
  auth = value;
  setCsrf(value.csrf);
  modelChip.textContent = value.model || 'Pi 模型';
  modelChip.title = '当前使用的模型';
  $('#account-name').textContent = value.user?.name || '账户';
  $('#account-role').textContent = value.admin ? '管理员 · 独立沙箱'
    : value.can_execute && value.grant_expires_at ? '已授权至 ' + grantDate(value.grant_expires_at)
      : value.can_execute ? '已授权 · 独立沙箱' : '无执行权限';
  $('#account-avatar').textContent = (value.user?.name || '·').slice(0, 1);
  $('#settings-button').hidden = !value.admin;
  $('#grants-button').hidden = !value.admin;
  $('#new-chat').disabled = busy || !value.can_execute;
  workspaceToggle.hidden = !value.can_execute;
  if (!value.can_execute) {
    if (drawer) closeDrawer({ restore: false, immediate: true });
    workspace.close();
    workspace.panel.inert = true;
    chatMenuButton.disabled = true;
  }
  prompt.placeholder = value.can_execute ? '描述任务，或接着聊…' : '此账户尚未获得 Agent 执行权限';
  setWelcomeMode(value.can_execute ? 'normal' : 'permission');
  updateComposer();
  syncHeader();
  updateToggles();
}
async function refreshIdentity() {
  try { applyIdentity(await get('/api/me')); return true; }
  catch (error) {
    if (auth) applyIdentity({ ...auth, admin: false, can_execute: false });
    if (error.status === 401) showNotice('登录已过期，请重新登录。', { tone: 'error', actionLabel: '重新登录', action: () => location.assign('/auth/login') });
    else showNotice('暂时无法复核登录状态，执行入口已关闭。请重新加载后重试。', { tone: 'error', actionLabel: '重新加载', action: () => location.reload() });
    return false;
  }
}

function messageState(text, { spinner = false, tone = '', actionLabel = '', action = null } = {}) {
  transcript.reset();
  welcome.hidden = true;
  const state = el('div', { class: 'conversation-state' + (tone ? ' tone-' + tone : '') });
  if (spinner) state.append(el('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } }));
  state.append(el('span', { text }));
  if (action) {
    const button = el('button', { type: 'button', class: 'btn btn-quiet', text: actionLabel });
    button.addEventListener('click', action);
    state.append(button);
  }
  messages.append(state);
}

function setChatUrl(id) {
  if (!id) { history.replaceState(null, '', '/'); return; }
  history.replaceState(null, '', '/?chat=' + encodeURIComponent(id));
}

function startNew({ focus = true } = {}) {
  if (busy) { toast('任务正在运行，请先停止或等待完成。', { tone: 'warning' }); return; }
  closeMenu();
  closeDrawer({ restore: false });
  chatId = crypto.randomUUID();
  lastUserText = '';
  setChatUrl(chatId);
  transcript.reset();
  setWelcomeMode(auth?.can_execute ? 'normal' : 'permission');
  welcome.hidden = false;
  clearNotice();
  setBusy(false);
  sidebar.setActive(chatId);
  syncHeader();
  if (focus) requestAnimationFrame(() => { prompt.focus(); prompt.setSelectionRange(prompt.value.length, prompt.value.length); });
  announce('新对话');
}

async function selectChat(id, { initial = false } = {}) {
  if (busy) { toast('任务正在运行，请先停止或等待完成后切换对话。', { tone: 'warning' }); return; }
  closeMenu();
  closeDrawer({ restore: false });
  chatId = id;
  setChatUrl(id);
  sidebar.setActive(id);
  if (!initial) prompt.blur();
  messageState('正在读取对话…', { spinner: true });
  clearNotice();
  syncHeader();
  try {
    const value = await get('/api/session?chat=' + encodeURIComponent(id));
    transcript.reset();
    const count = transcript.renderSession(value.messages || []);
    lastUserText = lastUser(value.messages || []);
    transcript.setWelcome(count === 0);
    if (value.busy) {
      transcript.setWelcome(false);
      setBusy(true);
      showNotice('此对话中的任务仍在运行。刷新页面不会接管实时输出；可停止任务或完成后再刷新。', {
        tone: 'warning', actionLabel: '刷新对话', action: () => void selectChat(id),
      });
    } else setBusy(false);
    if (count === 0) setWelcomeMode(auth?.can_execute ? 'normal' : 'permission');
    syncHeader();
    followBottom(true, 'auto');
    announce('已打开对话：' + (sidebar.chats.find(chat => chat.id === id)?.title || '对话'));
  } catch (error) {
    messageState(error.message || '无法读取对话。', {
      tone: 'error', actionLabel: '重试', action: () => void selectChat(id),
    });
    if (error.status === 401) showNotice('登录已过期，请重新登录。', { tone: 'error', actionLabel: '重新登录', action: () => location.assign('/auth/login') });
  }
}
function lastUser(items) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.role === 'user') return textContent(items[index].content);
  }
  return '';
}

function handleEvent(event, view) {
  if (!event || typeof event !== 'object') return;
  if (event.type === 'message_start' && event.message?.role === 'assistant') {
    view.beginMessage();
    view.setTime(event.message.timestamp);
    return;
  }
  if (event.type === 'message_update') {
    const update = event.assistantMessageEvent;
    if (!update) return;
    const partial = Array.isArray(update.partial?.content) ? update.partial.content[update.contentIndex] : null;
    switch (update.type) {
      case 'text_start': view.startText(update.contentIndex); break;
      case 'text_delta': view.appendText(update.contentIndex, update.delta); break;
      case 'text_end': view.endText(update.contentIndex, update.content); break;
      case 'thinking_start': view.startThinking(update.contentIndex); break;
      case 'thinking_delta': view.appendThinking(update.contentIndex, update.delta); break;
      case 'thinking_end': view.endThinking(update.contentIndex, update.content); break;
      case 'toolcall_start': {
        const card = view.toolStart(update.contentIndex, partial?.id || update.id || update.toolCall?.id,
          partial?.name || update.toolName || update.toolCall?.name);
        card.setStatus('pending');
        view.setStatus('正在准备工具…', { spinner: true });
        break;
      }
      case 'toolcall_delta':
        view.toolArgs(update.contentIndex, update.delta, partial?.id || update.id);
        break;
      case 'toolcall_end':
        view.finishToolCall(update.contentIndex, update.toolCall || partial);
        break;
      default: break;
    }
    return;
  }
  if (event.type === 'message_end' && event.message?.role === 'assistant') {
    view.applyMessage(event.message, { finish: false });
    return;
  }
  if (event.type === 'tool_execution_start') {
    const card = view.toolStart(undefined, event.toolCallId, event.toolName, event.args);
    card.setStatus('running');
    view.setStatus('正在执行工具 · ' + event.toolName, { spinner: true });
    return;
  }
  if (event.type === 'tool_execution_update') {
    const card = transcript.ensureCard(event.toolCallId, event.toolName);
    card.setPartial(event.partialResult);
    return;
  }
  if (event.type === 'tool_execution_end') {
    view.toolEnd(event.toolCallId, event.result, event.isError === true, event.durationMs);
    view.setStatus('正在整理结果…', { spinner: true });
    return;
  }
  if (event.type === 'auto_retry_start') {
    view.setStatus('模型繁忙，正在自动重试（' + event.attempt + '/' + event.maxAttempts + '）…', { spinner: true });
    return;
  }
  if (event.type === 'auto_retry_end' && event.success === false) {
    view.setError(event.finalError || '模型调用失败，已停止自动重试。', { retry: true });
    return;
  }
  if (event.type === 'compaction_start') { view.setStatus('正在压缩对话上下文…', { spinner: true }); return; }
  if (event.type === 'compaction_end') {
    if (event.errorMessage) view.setError('压缩对话上下文失败：' + event.errorMessage, { retry: true });
    else view.setStatus('上下文已压缩，继续生成…', { spinner: true });
    return;
  }
  if (event.type === 'gateway_error') throw new ApiError(event.error || '任务中断，请重试', 0);
  if (event.type === 'agent_settled') {
    if (event.aborted) view.setStopped();
    else if (!view.finished) { view.setStatus(''); view.finish(); }
  }
}

async function sendPrompt(value, { retry = false, continuation = false } = {}) {
  if (!auth?.can_execute) { showNotice('此账户尚未获得执行权限。', { tone: 'warning' }); return; }
  if (busy) { toast('当前任务尚未结束，请先停止或等待完成。', { tone: 'warning' }); return; }
  const message = String(value || '').trim();
  if (!message) return;
  if (!chatId) startNew({ focus: false });
  const thread = chatId;
  const userArticle = transcript.addUser(message);
  lastUserText = message;
  prompt.value = '';
  stopping = false;
  updateComposer();
  clearNotice();
  followBottom(true, 'auto');
  const controller = new AbortController();
  streamController = controller;
  setBusy(true);
  const view = transcript.beginAssistant();
  view.setStatus('正在连接模型…', { spinner: true });
  let received = false;
  let completed = false;
  let failure = null;
  try {
    const result = await streamPrompt({
      thread, message, signal: controller.signal,
      onEvent: event => { received = true; handleEvent(event, view); },
    });
    if (!result.settled && !stopping) throw new ApiError('连接在任务完成前关闭，请刷新对话查看实际结果。', 0);
    completed = result.settled || view.finished;
    if (!view.finished && !view.element.classList.contains('is-stopped')) {
      if (!completed) view.setStatus('');
      view.finish();
    }
  } catch (error) {
    failure = error;
    if (error.name === 'AbortError') {
      if (stopping) { view.setStopped(); announce('已停止生成'); }
      else { view.setError('与服务器的流式连接中断，请刷新对话后重试。', { retry: true }); }
    } else {
      if (!received) { userArticle.remove(); prompt.value = message; updateComposer(); }
      view.setError(error.message || '任务启动失败，请重试。', { retry: true });
      if (error.status === 401) showNotice('登录已过期，请重新登录。', { tone: 'error', actionLabel: '重新登录', action: () => location.assign('/auth/login') });
      else if (error.status === 403) showNotice(error.message, { tone: 'error' });
      else showNotice(error.message || '任务中断，请重试。', { tone: 'error' });
    }
  } finally {
    streamController = null;
    stopping = false;
    setBusy(false);
    await refreshIdentity();
    if (auth?.can_execute) {
      try { await sidebar.load(); sidebar.setActive(chatId); } catch {}
      syncHeader();
    }
    if (!failure) {
      if (retry) toast('已重新发送上一条任务', { tone: 'success' });
      else if (continuation) toast('已追加继续指令', { tone: 'success' });
      announce('回复已完成');
      followBottom(false);
    }
    requestAnimationFrame(() => prompt.focus());
  }
}

async function stopGeneration() {
  if (!busy || stopping) return;
  stopping = true;
  stop.disabled = true;
  updateComposer();
  const hadStream = !!streamController;
  try { await post('/api/abort', { thread: chatId }); }
  catch (error) { showNotice(error.message, { tone: 'error' }); }
  streamController?.abort();
  if (!hadStream) {
    toast('已请求停止任务', { tone: 'success' });
    setTimeout(() => void selectChat(chatId), 700);
  }
}

function followBottom(force = false, behavior = scrollBehavior()) {
  if (force) conversation.scrollTo({ top: conversation.scrollHeight, behavior });
}
function nearBottom() {
  return conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 96;
}
function updateJump() {
  jumpLatest.hidden = nearBottom() || messages.children.length === 0;
}
conversation.addEventListener('scroll', updateJump, { passive: true });
jumpLatest.addEventListener('click', () => { conversation.scrollTo({ top: conversation.scrollHeight, behavior: scrollBehavior() }); updateJump(); });
let follow = true;
const observer = new MutationObserver(() => {
  if (follow) requestAnimationFrame(() => { conversation.scrollTop = conversation.scrollHeight; });
  requestAnimationFrame(updateJump);
});
observer.observe(messages, { childList: true, subtree: true, characterData: true });
conversation.addEventListener('scroll', () => { follow = nearBottom(); }, { passive: true });

function openDrawer(type, trigger) {
  closeMenu();
  if (drawer) closeDrawer({ restore: false });
  if (workspaceRestoreTimer) { clearTimeout(workspaceRestoreTimer); workspaceRestoreTimer = null; }
  if (type === 'sidebar') {
    sidebarEl.inert = false;
    mainEl.inert = true;
    $('#workspace').inert = true;
    $('#workspace').hidden = true;
    app.classList.add('drawer-sidebar');
  } else {
    const panel = $('#workspace');
    panel.hidden = false; panel.inert = false;
    mainEl.inert = true; sidebarEl.inert = true;
    app.classList.add('drawer-workspace');
    workspace.open();
  }
  scrim.hidden = false;
  drawer = { type, trigger: trigger || document.activeElement };
  updateToggles();
  requestAnimationFrame(() => {
    if (type === 'sidebar') {
      ($('#chat-list .chat-item.is-active .chat-select') || $('#new-chat') || $('#chat-search')).focus();
    } else $('#workspace-close').focus();
  });
}
function closeDrawer({ restore = true, immediate = false } = {}) {
  if (!drawer) return;
  const current = drawer;
  drawer = null;
  app.classList.remove('drawer-sidebar', 'drawer-workspace');
  scrim.hidden = true;
  mainEl.inert = false;
  sidebarEl.inert = isMobile() ? true : document.documentElement.dataset.sidebar === 'closed';
  const panel = $('#workspace');
  panel.inert = true;
  if (current.type === 'workspace') {
    if (immediate || !isNarrowPanel()) {
      if (workspaceRestoreTimer) { clearTimeout(workspaceRestoreTimer); workspaceRestoreTimer = null; }
      panel.hidden = true;
    } else {
      if (workspaceRestoreTimer) clearTimeout(workspaceRestoreTimer);
      // Let the overlay slide out before display:none removes it.
      workspaceRestoreTimer = setTimeout(() => {
        workspaceRestoreTimer = null;
        if (!drawer) syncWorkspaceState();
      }, reduced.matches ? 0 : 270);
    }
  }
  updateToggles();
  if (restore && current.trigger?.isConnected) current.trigger.focus();
}
function updateToggles() {
  menuToggle.setAttribute('aria-expanded', String(drawer?.type === 'sidebar' || (!isMobile() && document.documentElement.dataset.sidebar !== 'closed')));
  workspaceToggle.setAttribute('aria-expanded', String(drawer?.type === 'workspace' || (!isNarrowPanel() && !$('#workspace').hidden)));
  menuToggle.setAttribute('aria-label', drawer?.type === 'sidebar' ? '关闭导航' : '显示导航');
}
function syncWorkspaceState() {
  const panel = $('#workspace');
  if (drawer?.type === 'workspace') {
    panel.hidden = false;
    panel.inert = false;
    return;
  }
  if (!auth?.can_execute) {
    panel.hidden = true;
    panel.inert = true;
    return;
  }
  if (!isNarrowPanel()) {
    const open = localStorage.getItem('agent-workspace') === 'open';
    panel.hidden = !open;
    panel.inert = !open;
    if (open && !workspace.entries.length && !workspace.loading) void workspace.open();
    return;
  }
  panel.hidden = true;
  panel.inert = true;
}
function syncLayout() {
  if (drawer && ((drawer.type === 'sidebar' && !isMobile()) || (drawer.type === 'workspace' && !isNarrowPanel()))) {
    closeDrawer({ restore: false, immediate: true });
  }
  sidebarEl.inert = isMobile() ? drawer?.type !== 'sidebar' : document.documentElement.dataset.sidebar === 'closed';
  mainEl.inert = !!drawer;
  if (isMobile() && !drawer) sidebarEl.inert = true;
  syncWorkspaceState();
  updateToggles();
}
function toggleSidebar(trigger) {
  if (isMobile()) {
    if (drawer?.type === 'sidebar') closeDrawer();
    else openDrawer('sidebar', trigger);
    return;
  }
  const closed = document.documentElement.dataset.sidebar === 'closed';
  document.documentElement.dataset.sidebar = closed ? 'open' : 'closed';
  localStorage.setItem('agent-sidebar', closed ? 'open' : 'closed');
  sidebarEl.inert = !closed ? true : false;
  updateToggles();
  if (!closed) menuToggle.focus();
}
function toggleWorkspace(trigger) {
  if (!auth?.can_execute) return;
  if (isNarrowPanel()) {
    if (drawer?.type === 'workspace') closeDrawer();
    else openDrawer('workspace', trigger);
    return;
  }
  const panel = $('#workspace');
  const opening = panel.hidden;
  if (workspaceRestoreTimer) { clearTimeout(workspaceRestoreTimer); workspaceRestoreTimer = null; }
  panel.hidden = !opening;
  panel.inert = !opening;
  localStorage.setItem('agent-workspace', opening ? 'open' : 'closed');
  if (opening) void workspace.open();
  updateToggles();
}
function syncTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  themeToggle.replaceChildren(icon(dark ? 'sun' : 'moon', 18));
  themeToggle.setAttribute('aria-label', dark ? '切换到浅色主题' : '切换到深色主题');
  themeToggle.setAttribute('title', dark ? '切换到浅色主题' : '切换到深色主题');
}

function setArchived(chat, archived) {
  return post('/api/chats/archive', { thread: chat.id, archived })
    .then(async () => {
      await sidebar.load();
      sidebar.setActive(chatId);
      if (chat.id === chatId) syncHeader();
      toast(archived ? '已归档对话' : '已恢复对话', { tone: 'success' });
    })
    .catch(error => toast(error.message, { tone: 'error' }));
}

function exportCurrent(format = 'md') {
  const chat = sidebar.chats.find(item => item.id === chatId);
  if (!chat) { toast('发送第一条消息后才能导出对话。', { tone: 'warning' }); return; }
  sidebar.exportChat(chat, format);
}
function insertWorkspacePath(path) {
  const quoted = workspaceReference(path);
  if (!quoted) { toast('请先选择工作区中的文件。', { tone: 'warning' }); return; }
  const value = prompt.value;
  const start = prompt.selectionStart ?? value.length;
  const end = prompt.selectionEnd ?? start;
  const before = value.slice(0, start);
  const after = value.slice(end);
  const prefix = before && !/\s$/.test(before) ? ' ' : '';
  const suffix = after && !/^\s/.test(after) ? ' ' : '';
  const inserted = prefix + quoted + suffix;
  prompt.value = before + inserted + after;
  const caret = before.length + inserted.length;
  prompt.focus();
  prompt.setSelectionRange(caret, caret);
  prompt.dispatchEvent(new Event('input', { bubbles: true }));
  announce('已插入文件路径');
}
function currentChat() { return sidebar.chats.find(item => item.id === chatId) || null; }
function openChatMenu() {
  const chat = currentChat();
  if (!chat) return;
  openMenu({
    anchor: chatMenuButton,
    label: '对话操作',
    items: [
      { icon: 'edit', label: '重命名', action: () => dialogs.openRename(chat, async title => {
        await sidebar.rename(chat, title);
        if (chat.id === chatId) syncHeader();
        sidebar.focusChat(chat.id);
      }) },
      { icon: 'pin', label: chat.pinned ? '取消置顶' : '置顶对话', action: () => sidebar.togglePin(chat) },
      { icon: 'download', label: '导出 Markdown', action: () => sidebar.exportChat(chat, 'md') },
      { icon: 'download', label: '导出 JSON', action: () => sidebar.exportChat(chat, 'json') },
      { icon: 'archive', label: chat.archived ? '取消归档' : '归档对话', action: () => sidebar.toggleArchive(chat) },
    ],
  });
}

function bind() {
  hydrateIcons();
  syncTheme();
  $('#model-chip')?.setAttribute('aria-label', '当前模型');
  menuToggle.addEventListener('click', () => toggleSidebar(menuToggle));
  $('#sidebar-collapse').addEventListener('click', () => {
    if (isMobile()) closeDrawer();
    else { document.documentElement.dataset.sidebar = 'closed'; localStorage.setItem('agent-sidebar', 'closed'); sidebarEl.inert = true; updateToggles(); menuToggle.focus(); }
  });
  scrim.addEventListener('click', () => closeDrawer());
  workspaceToggle.addEventListener('click', () => toggleWorkspace(workspaceToggle));
  $('#workspace-close').addEventListener('click', () => {
    if (isNarrowPanel()) closeDrawer();
    else {
      if (workspaceRestoreTimer) { clearTimeout(workspaceRestoreTimer); workspaceRestoreTimer = null; }
      $('#workspace').hidden = true;
      $('#workspace').inert = true;
      localStorage.setItem('agent-workspace', 'closed');
      updateToggles();
      workspaceToggle.focus();
    }
  });
  chatMenuButton.addEventListener('click', openChatMenu);
  themeToggle.addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    localStorage.setItem('agent-theme', dark ? 'light' : 'dark');
    syncTheme();
    announce(dark ? '已切换到浅色主题' : '已切换到深色主题');
  });
  $('#new-chat').addEventListener('click', () => startNew());
  promptForm.addEventListener('submit', event => { event.preventDefault(); void sendPrompt(prompt.value); });
  prompt.addEventListener('input', updateComposer);
  prompt.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      if (!send.disabled) void sendPrompt(prompt.value);
    }
  });
  stop.addEventListener('click', () => void stopGeneration());
  $$('#starters [data-prompt]').forEach(button => button.addEventListener('click', () => void sendPrompt(button.dataset.prompt)));
  $('#logout').addEventListener('click', async () => {
    try { await post('/auth/logout', {}); location.assign('/auth/login'); }
    catch (error) { toast(error.message, { tone: 'error' }); }
  });
  $('#settings-button').addEventListener('click', () => void dialogs.openSettings());
  $('#grants-button').addEventListener('click', () => void dialogs.openGrants());
  $('#shortcuts-button').addEventListener('click', () => dialogs.openShortcuts());
  noticeAction.addEventListener('click', () => noticeHandler?.());
  $('#notice-close').addEventListener('click', () => clearNotice());
  window.addEventListener('online', () => { connection.hidden = true; toast('网络连接已恢复', { tone: 'success' }); });
  window.addEventListener('offline', () => { connection.hidden = false; toast('网络连接已断开', { tone: 'warning' }); });
  if (navigator.onLine === false) connection.hidden = false;
  mobile.addEventListener('change', syncLayout);
  narrowPanel.addEventListener('change', syncLayout);
  window.addEventListener('resize', () => { updateJump(); updateToggles(); }, { passive: true });
  document.addEventListener('keydown', event => {
    const dialogOpen = !!document.querySelector('dialog[open]');
    if (dialogOpen) return;
    if (event.key === 'Escape' && drawer) {
      event.preventDefault();
      closeDrawer();
      return;
    }
    if (event.key === 'Tab' && drawer) {
      const container = drawer.type === 'sidebar' ? sidebarEl : $('#workspace');
      trapTab(container, event);
      return;
    }
    const mod = event.metaKey || event.ctrlKey;
    if (!mod) return;
    const key = event.key.toLowerCase();
    if (key === 'k') {
      event.preventDefault();
      if (isMobile()) {
        if (drawer?.type !== 'sidebar') openDrawer('sidebar', menuToggle);
        sidebar.focusSearch();
      } else {
        if (document.documentElement.dataset.sidebar === 'closed') toggleSidebar(menuToggle);
        requestAnimationFrame(() => sidebar.focusSearch());
      }
    } else if (key === 'o' && event.shiftKey) {
      event.preventDefault(); startNew();
    } else if (key === 'e' && event.shiftKey) {
      event.preventDefault(); exportCurrent('md');
    } else if (key === '/') {
      event.preventDefault(); dialogs.openShortcuts();
    }
  });
  syncLayout();
  updateComposer();
}
bind();
syncLayout();
updateToggles();

(async function boot() {
  messageState('正在读取账户…', { spinner: true });
  try {
    const me = await get('/api/me');
    applyIdentity(me);
    if (!me.can_execute) {
      setWelcomeMode('permission');
      transcript.reset();
      welcome.hidden = false;
      sidebar.load = async () => { sidebar.loading = false; sidebar.render = () => {}; };
      $('#chat-list').replaceChildren(el('p', { class: 'list-empty', text: '此账户暂无可用对话。' }));
      syncLayout();
      syncHeader();
      return;
    }
    await sidebar.load();
    const id = new URLSearchParams(location.search).get('chat');
    if (id && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) await selectChat(id, { initial: true });
    else startNew({ focus: false });
    syncLayout();
    requestAnimationFrame(() => { if (messages.children.length) followBottom(true, 'auto'); });
  } catch (error) {
    messageState(error.message || '无法读取账户，请刷新重试。', {
      tone: 'error', actionLabel: '重新加载', action: () => location.reload(),
    });
    showNotice(error.message || '无法读取账户，请刷新重试。', { tone: 'error', actionLabel: '重新加载', action: () => location.reload() });
  }
})();

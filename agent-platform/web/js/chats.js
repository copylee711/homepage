import { el, icon, iconButton } from './dom.js';
import { get, post } from './api.js';
import { formatShort, groupChats } from './format.js';
import { openMenu } from './menu.js';

export class ChatSidebar {
  constructor({ list, search, clear, activeTab, archivedTab, empty, onSelect, onRename, onArchive, onNotice, onMutated }) {
    this.list = list;
    this.search = search;
    this.clear = clear;
    this.activeTab = activeTab;
    this.archivedTab = archivedTab;
    this.onSelect = onSelect;
    this.onRename = onRename;
    this.onArchive = onArchive;
    this.onNotice = onNotice;
    this.onMutated = onMutated;
    this.chats = [];
    this.query = '';
    this.view = 'active';
    this.activeId = null;
    this.loading = true;
    this.error = '';
    this.bind();
  }
  bind() {
    this.search.addEventListener('input', () => {
      this.query = this.search.value.trim();
      this.clear.hidden = !this.search.value;
      this.render();
    });
    this.search.addEventListener('keydown', event => {
      if (event.key === 'Escape' && this.search.value) {
        event.preventDefault();
        this.clearSearch();
      }
    });
    this.clear.addEventListener('click', () => this.clearSearch());
    this.activeTab.addEventListener('click', () => this.setView('active'));
    this.archivedTab.addEventListener('click', () => this.setView('archived'));
  }
  clearSearch() {
    this.search.value = '';
    this.query = '';
    this.clear.hidden = true;
    this.render();
    this.search.focus();
  }
  focusSearch() {
    this.search.focus();
    this.search.select();
  }
  setView(view) {
    if (this.view === view) return;
    this.view = view;
    this.activeTab.setAttribute('aria-pressed', String(view === 'active'));
    this.archivedTab.setAttribute('aria-pressed', String(view === 'archived'));
    this.render();
  }
  setActive(id) {
    this.activeId = id;
    for (const item of this.list.querySelectorAll('[data-chat-id]')) {
      const active = item.dataset.chatId === id;
      item.classList.toggle('is-active', active);
      const button = item.querySelector('.chat-select');
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
  }
  focusChat(id) {
    requestAnimationFrame(() => {
      const row = id ? this.list.querySelector('[data-chat-id="' + (window.CSS?.escape ? CSS.escape(id) : id) + '"] .chat-select') : null;
      (row || this.search).focus();
    });
  }
  async load() {
    this.loading = true; this.error = ''; this.render();
    try { this.chats = (await get('/api/chats')).chats || []; }
    catch (error) { this.error = error.message || '无法读取对话'; }
    finally { this.loading = false; this.render(); }
    return this.chats;
  }
  setBusy(value) { this.busy = value; }
  filtered() {
    const wanted = this.view === 'archived';
    const query = this.query.toLocaleLowerCase();
    return this.chats.filter(chat => (chat.archived === true) === wanted)
      .filter(chat => !query || (chat.title || '').toLocaleLowerCase().includes(query));
  }
  render() {
    this.clear.hidden = !this.search.value;
    this.list.replaceChildren();
    if (this.loading) {
      this.list.append(el('div', { class: 'list-state' }, el('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } }), el('span', { text: '正在读取对话…' })));
      return;
    }
    if (this.error) {
      const retry = el('button', { type: 'button', class: 'text-button', text: '重试' });
      retry.addEventListener('click', () => this.load());
      this.list.append(el('div', { class: 'list-state is-error' }, el('span', { text: this.error }), retry));
      return;
    }
    const chats = this.filtered();
    if (!chats.length) {
      const text = this.query ? '没有匹配的对话。'
        : this.view === 'archived' ? '没有已归档的对话。归档的对话会保留在这里。'
          : '还没有对话。发送第一条任务后会出现在这里。';
      this.list.append(el('p', { class: 'list-empty', text }));
      return;
    }
    for (const group of groupChats(chats)) {
      const section = el('section', { class: 'chat-group', attrs: { 'aria-label': group.label } });
      section.append(el('h2', { class: 'chat-group-title', text: group.label }));
      const items = el('ul', { class: 'chat-items' });
      for (const chat of group.chats) items.append(this.row(chat));
      section.append(items);
      this.list.append(section);
    }
  }
  row(chat) {
    const item = el('li', { class: 'chat-item' + (chat.id === this.activeId ? ' is-active' : ''), dataset: { chatId: chat.id } });
    const select = el('button', {
      type: 'button',
      class: 'chat-select',
      attrs: { 'aria-label': '打开对话：' + chat.title, 'aria-current': chat.id === this.activeId ? 'page' : null, title: chat.title },
    });
    const title = el('span', { class: 'chat-title', text: chat.title || '新对话' });
    const meta = el('span', { class: 'chat-meta' }, el('span', { class: 'chat-time', text: formatShort(chat.updated) }));
    if (chat.pinned) meta.append(icon('pin', 12));
    if (chat.archived) meta.append(icon('archive', 12));
    select.append(title, meta);
    select.addEventListener('click', () => this.onSelect?.(chat));
    const more = iconButton('more-horizontal', '对话操作：' + chat.title, 'icon-button chat-more', { attrs: { 'aria-haspopup': 'menu', 'aria-expanded': 'false' } });
    more.addEventListener('click', () => {
      openMenu({
        anchor: more,
        label: '对话操作',
        items: [
          { icon: 'edit', label: '重命名', action: () => this.onRename?.(chat) },
          { icon: 'pin', label: chat.pinned ? '取消置顶' : '置顶对话', action: () => this.togglePin(chat) },
          { icon: 'download', label: '导出 Markdown', action: () => this.exportChat(chat, 'md') },
          { icon: 'download', label: '导出 JSON', action: () => this.exportChat(chat, 'json') },
          { icon: 'archive', label: chat.archived ? '取消归档' : '归档对话', action: () => this.toggleArchive(chat) },
        ],
      });
    });
    item.append(select, more);
    return item;
  }
  exportChat(chat, format) {
    const link = document.createElement('a');
    link.href = '/api/chats/export?chat=' + encodeURIComponent(chat.id) + '&format=' + format;
    link.click();
    this.onNotice?.('已开始导出 ' + (format === 'json' ? 'JSON' : 'Markdown'), { tone: 'success' });
  }
  async togglePin(chat) {
    try {
      await post('/api/chats/pin', { thread: chat.id, pinned: !chat.pinned });
      await this.load();
      this.focusChat(chat.id);
      this.onMutated?.({ type: 'pin', chat });
      this.onNotice?.(chat.pinned ? '已取消置顶' : '已置顶', { tone: 'success' });
    } catch (error) { this.onNotice?.(error.message, { tone: 'error' }); }
  }
  async toggleArchive(chat) {
    try {
      await post('/api/chats/archive', { thread: chat.id, archived: !chat.archived });
      await this.load();
      this.focusChat(chat.id);
      this.onMutated?.({ type: 'archive', chat: { ...chat, archived: !chat.archived } });
      this.onArchive?.(chat, !chat.archived);
    } catch (error) { this.onNotice?.(error.message, { tone: 'error' }); }
  }
  async rename(chat, title) {
    await post('/api/chats/rename', { thread: chat.id, title });
    await this.load();
    this.onMutated?.({ type: 'rename', chat: { ...chat, title } });
  }
  currentTitle() {
    return this.chats.find(chat => chat.id === this.activeId)?.title || '';
  }
  currentArchived() {
    return this.chats.find(chat => chat.id === this.activeId)?.archived === true;
  }
}

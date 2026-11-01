import { el, icon, iconButton, triggerDownload } from './dom.js';
import { get, post, ApiError } from './api.js';
import { formatBytes, formatDateTime, normalizeWorkspacePath } from './format.js';
import { openMenu } from './menu.js';
import { askPath, editFile } from './file-editor.js';

const MAX_UPLOAD = 256 * 1024;
const PREVIEW_LIMIT = 64 * 1024;

export function decodePreview(value) {
  try {
    const bytes = Uint8Array.from(atob(value.data || ''), character => character.charCodeAt(0));
    // A bounded preview may end mid-character; retain complete UTF-8 characters.
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: value.truncated === true });
    return { text, binary: text.includes('\u0000') };
  } catch { return { text: '', binary: true }; }
}

export class WorkspacePanel {
  constructor({ panel, crumb, list, status, preview, previewTitle, previewMeta, previewBody, previewNote,
    up, refresh, upload, fileInput, closePreview, download, insert, onInsert, notice, confirmOverwrite, confirm, request = get }) {
    this.request = request;
    this.panel = panel;
    this.crumb = crumb;
    this.list = list;
    this.status = status;
    this.preview = preview;
    this.previewTitle = previewTitle;
    this.previewMeta = previewMeta;
    this.previewBody = previewBody;
    this.previewNote = previewNote;
    this.up = up;
    this.refresh = refresh;
    this.upload = upload;
    this.fileInput = fileInput;
    this.closePreview = closePreview;
    this.download = download;
    this.insert = insert;
    this.onInsert = onInsert;
    this.notice = notice;
    this.confirmOverwrite = confirmOverwrite;
    this.confirm = confirm;
    this.snapshots = new Map();
    this.path = '';
    this.entries = [];
    this.selected = null;
    this.loading = false;
    this.error = '';
    this.busy = false;
    this.previewRequest = 0;
    this.bind();
  }
  bind() {
    this.up.addEventListener('click', () => {
      if (this.crumbPath !== null && this.crumbPath !== undefined) this.navigate(this.crumbPath);
    });
    this.refresh.addEventListener('click', () => this.load(this.path, true));
    this.upload.addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', () => { const file = this.fileInput.files?.[0]; this.fileInput.value = ''; if (file) void this.uploadFile(file); });
    this.closePreview.addEventListener('click', () => this.clearPreview());
    this.download.addEventListener('click', () => { if (this.selected) triggerDownload('/api/files/download?path=' + encodeURIComponent(this.selected)); });
    this.insert.addEventListener('click', () => { if (this.selected) this.onInsert?.(this.selected); });
    this.list.addEventListener('click', event => {
      const row = event.target.closest('[data-path]');
      if (!row) return;
      const entry = this.entries.find(item => item.path === row.dataset.path);
      if (!entry) return;
      if (entry.type === 'dir') this.navigate(entry.path);
      else void this.previewFile(entry.path);
    });
    this.list.addEventListener('contextmenu', event => {
      event.preventDefault();
      this.context(event.target.closest('[data-path]') || this.list, { x: event.clientX, y: event.clientY });
    });
    this.list.addEventListener('keydown', event => {
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault(); this.context(event.target.closest('[data-path]') || this.list);
      }
    });
    // A visible menu also makes file management discoverable on touch devices.
    const actions = iconButton('more-horizontal', '工作区文件操作', 'icon-button');
    this.refresh.after(actions);
    actions.addEventListener('click', () => this.context(actions));
  }
  open() { this.panel.hidden = false; if (!this.loading) void this.load(this.path); }
  close() { this.panel.hidden = true; }
  clearPreview() { this.previewRequest += 1; this.selected = null; this.preview.hidden = true; }
  async load(path = '', fresh = false) {
    if (this.loading) return;
    this.loading = true;
    this.error = '';
    const cached = this.snapshots.get(path);
    if (cached) { this.applyListing(cached); this.loading = false; this.render(); this.loading = true; }
    this.renderStatus('正在读取工作区…', true);
    try {
      const value = await this.request('/api/files?path=' + encodeURIComponent(normalizeWorkspacePath(path)) + (fresh ? '&fresh=1' : ''));
      this.snapshots.set(path, value);
      while (this.snapshots.size > 20) this.snapshots.delete(this.snapshots.keys().next().value);
      this.applyListing(value);
    } catch (error) {
      this.error = error.message;
    } finally {
      this.loading = false;
      this.render();
    }
  }
  applyListing(value) {
    this.path = normalizeWorkspacePath(value.path);
    this.crumbPath = value.parent == null ? null : normalizeWorkspacePath(value.parent);
    this.entries = (Array.isArray(value.entries) ? value.entries : []).map(entry => ({ ...entry, path: normalizeWorkspacePath(entry.path) })).filter(entry => entry.path !== '');
    this.truncated = value.truncated === true;
  }
  context(anchor, point) {
    const entry = this.entries.find(item => item.path === anchor.dataset.path);
    const run = async fn => { try { await fn(); } catch (error) { this.notice?.(error.message, { tone: 'error' }); } };
    const mutate = async input => { await post('/api/files/manage', input); this.snapshots.clear(); this.clearPreview(); await this.load(this.path); };
    const prefix = this.path ? this.path + '/' : '';
    openMenu({ anchor, point, label: '工作区文件操作', items: [
      entry?.type === 'file' && { icon: 'edit', label: '编辑文本', action: () => void run(() => editFile(entry.path, { confirm: this.confirm, saved: () => { this.snapshots.clear(); void this.load(this.path); } })) },
      entry?.type === 'file' && { icon: 'download', label: '下载文件', action: () => triggerDownload('/api/files/download?path=' + encodeURIComponent(entry.path)) },
      entry && { icon: 'copy', label: '引用路径到对话', action: () => this.onInsert?.(entry.path) },
      { icon: 'file', label: '新建文本文件', action: () => void run(async () => {
        const path = await askPath('新建文本文件', prefix);
        if (path) { await post('/api/files/upload', { path, content: '', overwrite: false }); this.snapshots.clear(); await this.load(this.path); await editFile(path, { confirm: this.confirm, saved: () => void this.load(this.path) }); }
      }) },
      { icon: 'folder', label: '新建文件夹', action: () => void run(async () => { const path = await askPath('新建文件夹', prefix); if (path) await mutate({ action: 'mkdir', path }); }) },
      entry && { icon: 'edit', label: '重命名 / 移动', action: () => void run(async () => { const destination = await askPath('重命名 / 移动', entry.path); if (destination && destination !== entry.path) await mutate({ action: 'move', path: entry.path, destination }); }) },
      entry && { icon: 'trash', label: '删除' + (entry.type === 'dir' ? '空文件夹' : '文件'), danger: true, action: () => void run(async () => {
        if (await this.confirm?.({ title: '删除“' + entry.name + '”？', body: '删除后无法撤销。文件夹必须为空。', confirmLabel: '删除', tone: 'danger' })) await mutate({ action: 'delete', path: entry.path });
      }) },
    ] });
  }
  navigate(path) { this.clearPreview(); void this.load(normalizeWorkspacePath(path)); }
  renderStatus(text, spinner = false) {
    this.status.replaceChildren();
    this.status.hidden = !text;
    if (spinner) this.status.append(el('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } }));
    this.status.append(el('span', { text }));
  }
  render() {
    this.crumb.replaceChildren();
    const root = el('button', { type: 'button', class: 'crumb', text: '工作区' });
    root.addEventListener('click', () => this.navigate(''));
    this.crumb.append(root);
    if (this.path) {
      const pieces = this.path.split('/').filter(Boolean);
      let built = '';
      for (const piece of pieces) {
        built = built ? built + '/' + piece : piece;
        const target = built;
        this.crumb.append(el('span', { class: 'crumb-sep', text: '/' }));
        const button = el('button', { type: 'button', class: 'crumb', text: piece });
        button.addEventListener('click', () => this.navigate(target));
        this.crumb.append(button);
      }
    }
    this.up.disabled = this.path === '' || this.loading;
    this.refresh.disabled = this.loading;
    this.list.replaceChildren();
    if (this.loading) {
      this.renderStatus('正在读取工作区…', true);
      return;
    }
    if (this.error) {
      this.renderStatus(this.error);
      const retry = el('button', { type: 'button', class: 'text-button', text: '重试' });
      retry.addEventListener('click', () => this.load(this.path));
      this.status.append(retry);
      return;
    }
    this.renderStatus(this.truncated ? '仅显示前 500 项。' : '');
    if (!this.entries.length) {
      this.list.append(el('p', { class: 'list-empty', text: '此文件夹为空。可以用 Pi 或上传创建文件。' }));
      return;
    }
    for (const entry of this.entries) {
      const button = el('button', { type: 'button', class: 'file-row', dataset: { path: entry.path } });
      const kind = entry.type === 'dir' ? 'folder' : entry.type === 'symlink' ? 'link' : 'file';
      button.append(
        el('span', { class: 'file-icon' }, icon(entry.type === 'dir' ? 'folder' : entry.type === 'symlink' ? 'link' : 'file', 16)),
        el('span', { class: 'file-name', text: entry.name }),
        el('span', { class: 'file-size', text: entry.type === 'dir' ? '' : formatBytes(entry.size) }),
        el('span', { class: 'file-kind', text: entry.type === 'symlink' ? '链接' : '' }),
      );
      button.title = entry.name;
      this.list.append(button);
    }
  }
  async previewFile(path) {
    const request = ++this.previewRequest;
    path = normalizeWorkspacePath(path);
    this.selected = path;
    this.preview.hidden = false;
    this.previewTitle.textContent = path.split('/').pop() || path;
    this.previewMeta.textContent = '正在读取…';
    this.previewBody.replaceChildren();
    this.previewNote.hidden = true;
    this.download.disabled = true;
    this.insert.disabled = true;
    try {
      const value = await this.request('/api/files/preview?path=' + encodeURIComponent(path) + '&limit=' + PREVIEW_LIMIT);
      if (request !== this.previewRequest) return;
      const { text, binary } = decodePreview(value);
      this.previewMeta.textContent = formatBytes(value.size) + (value.truncated ? ' · 预览已截断' : '');
      if (binary) {
        this.previewBody.append(el('p', { class: 'list-empty', text: '这是二进制或非 UTF-8 文件，无法在浏览器中预览。' }));
        this.previewNote.hidden = false;
        this.previewNote.textContent = value.size > 1024 * 1024 ? '文件超过 1 MiB 下载上限。' : '可以下载原文件。';
        this.download.disabled = value.size > 1024 * 1024;
      } else {
        this.previewBody.textContent = text;
        this.previewNote.hidden = !value.truncated;
        this.previewNote.textContent = value.truncated ? '仅预览前 64 KiB。' : '';
        this.download.disabled = value.size > 1024 * 1024;
      }
      this.insert.disabled = false;
    } catch (error) {
      if (request !== this.previewRequest) return;
      this.previewMeta.textContent = error.message;
      this.previewBody.append(el('p', { class: 'list-empty', text: '无法预览此文件。' }));
      this.download.disabled = false;
      this.insert.disabled = false;
    }
  }
  async uploadFile(file) {
    if (this.busy) return;
    if (file.size > MAX_UPLOAD) { this.notice?.('上传文件不能超过 256 KiB', { tone: 'error' }); return; }
    if (!file.name) { this.notice?.('请选择文本文件', { tone: 'error' }); return; }
    this.busy = true; this.upload.disabled = true;
    const target = (this.path ? this.path + '/' : '') + file.name.replace(/[\\/\u0000-\u001f\u007f]/g, '-');
    try {
      const content = await file.text();
      if (content.includes('\u0000')) throw new Error('暂不支持上传二进制文件');
      await this.sendUpload(target, content, false);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        const ok = await this.confirmOverwrite?.(target);
        if (ok) {
          try { await this.sendUpload(target, await file.text(), true); }
          catch (retryError) { this.notice?.(retryError.message, { tone: 'error' }); }
        }
      } else this.notice?.(error.message, { tone: 'error' });
    } finally { this.busy = false; this.upload.disabled = false; }
  }
  async sendUpload(path, content, overwrite) {
    await post('/api/files/upload', { path, content, overwrite });
    this.notice?.('已上传 ' + path.split('/').pop(), { tone: 'success' });
    await this.load(this.path);
    await this.previewFile(path).catch(() => {});
  }
}

import { el } from './dom.js';
import { get, post } from './api.js';
import { decodePreview } from './workspace.js';

// Native dialogs share focus trapping, Escape and button styling with settings.
export function askPath(title, initial = '') {
  return new Promise(resolve => {
    const dialog = el('dialog', { class: 'dialog file-dialog' });
    const heading = el('h2', { text: title, id: 'file-action-title' });
    dialog.setAttribute('aria-labelledby', heading.id);
    const input = el('input', { value: initial, attrs: { 'aria-label': '工作区相对路径', maxlength: '1024', required: '' } });
    const hint = el('p', { class: 'field-help', text: '相对于工作区的路径，例如 notes/readme.md。目标目录需已存在。' });
    const form = el('form', {}, heading, input, hint);
    const cancel = el('button', { type: 'button', class: 'btn btn-ghost', text: '取消' });
    const submit = el('button', { type: 'submit', class: 'btn btn-solid', text: '确定' });
    form.append(el('div', { class: 'dialog-actions' }, cancel, submit));
    dialog.append(form); document.body.append(dialog);
    let result = null;
    form.addEventListener('submit', event => { event.preventDefault(); if (input.value.trim()) { result = input.value.trim(); dialog.close(); } });
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { dialog.remove(); resolve(result); }, { once: true });
    dialog.showModal(); input.focus(); input.select();
  });
}

export async function editFile(path, { confirm, saved }) {
  const file = await get('/api/files/preview?path=' + encodeURIComponent(path) + '&limit=262144');
  const decoded = decodePreview(file);
  if (decoded.binary || file.truncated || !file.revision) throw new Error('仅能编辑完整的 UTF-8 文本文件，大小不超过 256 KiB');
  const dialog = el('dialog', { class: 'dialog file-editor' });
  const title = el('h2', { text: path, id: 'file-editor-title' });
  dialog.setAttribute('aria-labelledby', title.id);
  const editor = el('textarea', { class: 'file-editor-input', value: decoded.text, attrs: { 'aria-label': '文件内容', spellcheck: 'false' } });
  const status = el('p', { class: 'field-help', attrs: { role: 'status' } });
  const close = el('button', { type: 'button', class: 'btn btn-ghost', text: '关闭' });
  const save = el('button', { type: 'button', class: 'btn btn-solid', text: '保存' });
  dialog.append(title, editor, status, el('div', { class: 'dialog-actions' }, close, save));
  document.body.append(dialog);
  let original = decoded.text, revision = file.revision, saving = false;
  const update = () => { const dirty = editor.value !== original; save.disabled = saving || !dirty; status.textContent = dirty ? '有未保存的更改 · Ctrl/Cmd+S 保存' : '已与服务器同步'; };
  async function dismiss() {
    if (saving) return;
    if (editor.value !== original && !await confirm({ title: '放弃未保存的更改？', body: path, confirmLabel: '放弃更改', tone: 'danger' })) return;
    dialog.close();
  }
  async function persist() {
    if (saving || editor.value === original) return;
    saving = true; update(); close.disabled = true;
    try {
      const content = editor.value;
      const next = await post('/api/files/upload', { path, content, overwrite: true, revision });
      original = content;
      revision = next.revision;
      saved?.();
      saving = false; update();
    } catch (error) { saving = false; update(); status.textContent = error.status === 409 ? '文件已被修改。请复制当前内容，关闭并重新打开后合并更改。' : error.message; }
    finally { saving = false; close.disabled = false; save.disabled = editor.value === original; }
  }
  editor.addEventListener('input', update);
  editor.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void persist(); }
    if (event.key === 'Tab') { event.preventDefault(); editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end'); update(); }
  });
  save.addEventListener('click', () => void persist()); close.addEventListener('click', () => void dismiss());
  dialog.addEventListener('cancel', event => { event.preventDefault(); void dismiss(); });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.showModal(); update(); editor.focus();
}

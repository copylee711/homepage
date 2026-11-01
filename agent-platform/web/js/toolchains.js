import { el, iconButton } from './dom.js';
import { get, post } from './api.js';

export function openToolchains({ confirm }) {
  const dialog = el('dialog', { class: 'dialog package-dialog', attrs: { 'aria-labelledby': 'toolchains-title' } });
  const close = iconButton('x', '关闭工具链', 'icon-button');
  const status = el('p', { class: 'field-help', attrs: { role: 'status' } });
  const list = el('div', { class: 'package-list' });
  const output = el('pre', { class: 'toolchain-output' });
  dialog.append(el('div', { class: 'dialog-heading' }, el('h2', { text: '工作区工具链', id: 'toolchains-title' }), close),
    el('div', { class: 'dialog-body' }, el('p', { class: 'hint', text: '仅为你安装到工作区 .tools，不需要重建镜像。基础镜像保留 Node、Python、pip/venv、Git 和 C/C++。Agent 也能在配额内自行安装其他缺失依赖。' }), status, list, output));
  document.body.append(dialog);
  let timer, running = false, pending = false;
  async function load() {
    clearTimeout(timer);
    try {
      const data = await get('/api/toolchains');
      if (!dialog.open) return;
      running = data.job?.state === 'running';
      status.textContent = running ? '正在安装 · 保持面板打开以续期授权' : '安装的工具在后续命令中可直接使用；占用你的磁盘配额。';
      output.textContent = data.job?.output || ''; output.hidden = !output.textContent;
      if (running) { for (const button of list.querySelectorAll('button')) button.disabled = true; timer = setTimeout(load, 2000); return; }
      list.replaceChildren();
      const installed = new Map((data.installed || []).map(item => [item.id, item.version]));
      for (const item of data.catalog || []) {
        const version = el('input', { value: installed.get(item.id) || item.version, class: 'tool-version', attrs: { 'aria-label': item.name + ' 固定版本号', maxlength: '40' } });
        const install = el('button', { type: 'button', class: 'btn btn-outline', text: installed.has(item.id) ? '更新 / 重装' : '安装' });
        const remove = installed.has(item.id) ? el('button', { type: 'button', class: 'btn btn-ghost', text: '移除' }) : null;
        const change = async action => {
          if (pending || running) return;
          if (action === 'remove' && !await confirm({ title: '移除 ' + item.name + '？', body: '只删除这个工具的托管环境，项目文件和其他工具会保留。', confirmLabel: '移除', tone: 'danger' })) return;
          pending = true; install.disabled = true; if (remove) remove.disabled = true;
          try { await post('/api/toolchains/change', { id: item.id, version: version.value.trim(), action }); await load(); }
          catch (error) { status.textContent = error.message; }
          finally { pending = false; install.disabled = running; if (remove) remove.disabled = running; }
        };
        install.addEventListener('click', () => void change('install')); remove?.addEventListener('click', () => void change('remove'));
        list.append(el('article', { class: 'package-row' }, el('div', {}, el('h3', { text: item.name }), el('p', { text: item.description }), el('p', { class: 'package-meta', text: installed.has(item.id) ? '已安装 v' + installed.get(item.id) : '尚未安装' })), el('div', { class: 'toolchain-actions' }, version, install, remove)));
      }
    } catch (error) { status.textContent = error.message + '。可关闭后重试；授权失联会自动停止安装。'; }
  }
  async function dismiss() {
    if (pending) return;
    if (running) {
      if (!await confirm({ title: '停止安装并关闭？', body: '已下载的工作区文件会保留，可重新安装。', confirmLabel: '停止并关闭', tone: 'danger' })) return;
      await post('/api/toolchains/cancel', {}).catch(() => {});
    }
    dialog.close();
  }
  close.addEventListener('click', () => void dismiss());
  dialog.addEventListener('cancel', event => { event.preventDefault(); void dismiss(); });
  dialog.addEventListener('close', () => { clearTimeout(timer); dialog.remove(); }, { once: true });
  dialog.showModal(); void load();
}

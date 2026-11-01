import { el, iconButton } from './dom.js';
import { get, post } from './api.js';

export function openPackages({ confirm }) {
  const dialog = el('dialog', { class: 'dialog package-dialog', attrs: { 'aria-labelledby': 'package-title' } });
  const close = iconButton('x', '关闭扩展市场', 'icon-button');
  const title = el('h2', { text: 'Pi 扩展市场', id: 'package-title' });
  const catalog = el('a', { text: '浏览 Pi 官方目录 ↗', href: 'https://pi.dev/packages', target: '_blank', rel: 'noopener noreferrer' });
  const search = el('input', { type: 'search', placeholder: '搜索技能、提示词和扩展', attrs: { 'aria-label': '搜索 npm Pi 包', maxlength: '100' } });
  const submit = el('button', { type: 'submit', class: 'btn btn-solid', text: '搜索' });
  const form = el('form', { class: 'package-search' }, search, submit);
  const status = el('p', { class: 'field-help', attrs: { role: 'status' } });
  const list = el('div', { class: 'package-list' });
  dialog.append(el('div', { class: 'dialog-heading' }, el('div', {}, title, catalog), close),
    el('div', { class: 'dialog-body' }, el('p', { class: 'hint', text: '固定版本安装文本技能与提示词，对所有用户的后续任务生效。包代码、依赖脚本和 JavaScript 扩展不会执行；需要代码扩展的包会提示审查。' }), form, status, list));
  document.body.append(dialog);
  let pending = false, sequence = 0;
  async function load() {
    const current = ++sequence;
    submit.disabled = true; status.textContent = '正在读取 npm 包目录…';
    try {
      const data = await get('/api/packages?q=' + encodeURIComponent(search.value.trim()));
      if (current !== sequence || !dialog.open) return;
      list.replaceChildren();
      const installed = new Map((data.installed || []).map(item => [item.name, item]));
      const packages = [...(data.installed || []), ...(data.packages || []).filter(item => !installed.has(item.name))];
      status.textContent = `${installed.size} 个已安装 · ${data.packages?.length || 0} 个搜索结果`;
      for (const item of packages) {
        const saved = installed.get(item.name);
        const heading = el('h3', { text: item.name });
        const action = el('button', { type: 'button', class: saved ? 'btn btn-quiet' : 'btn btn-quiet', text: saved ? '移除' : '安装文本资源' });
        const info = el('p', { class: 'package-meta', text: 'v' + item.version + (saved ? ' · 已安装 ' + saved.resources.length + ' 个文本资源' : '') });
        const description = el('p', { text: item.description || (saved ? '已校验 SHA-512，扩展代码未加载。' : '暂无说明。') });
        action.addEventListener('click', async () => {
          if (pending) return;
          const ok = await confirm({ title: saved ? '移除此包？' : '安装固定版本文本资源？', body: item.name + '@' + item.version + '。技能和提示词会影响模型行为，请仅安装你信任的包。', confirmLabel: saved ? '移除' : '安装', tone: saved ? 'danger' : 'normal' });
          if (!ok) return;
          pending = true; action.disabled = true; close.disabled = true; status.textContent = '正在校验并处理包…';
          try { await post('/api/packages/change', { name: item.name, version: item.version, action: saved ? 'remove' : 'install' }); await load(); }
          catch (error) { status.textContent = error.message; }
          finally { pending = false; action.disabled = false; close.disabled = false; }
        });
        list.append(el('article', { class: 'package-row' }, el('div', {}, heading, info, description), action));
      }
    } catch (error) { if (current === sequence) status.textContent = error.message; }
    finally { if (current === sequence) submit.disabled = false; }
  }
  form.addEventListener('submit', event => { event.preventDefault(); if (!pending) void load(); });
  close.addEventListener('click', () => { if (!pending) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (pending) event.preventDefault(); });
  dialog.addEventListener('close', () => { sequence++; dialog.remove(); }, { once: true });
  dialog.showModal(); search.focus(); void load();
}

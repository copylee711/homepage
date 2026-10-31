import { $, el, platformKey } from './dom.js';
import { get, post } from './api.js';
import { grantDate } from './format.js';

function show(dialog) {
  if (!dialog.open) dialog.showModal();
}
function setFieldError(input, target, message) {
  if (input) input.setAttribute('aria-invalid', message ? 'true' : 'false');
  if (target) { target.textContent = message || ''; target.hidden = !message; }
}
function focusFirstError(form) {
  const input = form.querySelector('[aria-invalid="true"]');
  input?.focus();
}

export function setupDialogs({ notice, onModelChange }) {
  const provider = setupProvider({ notice, onModelChange });
  const grants = setupGrants({ notice });
  const rename = setupRename({ notice });
  return {
    openSettings: provider.open,
    openGrants: grants.open,
    openRename: rename.open,
    confirm: confirmDialog,
    openShortcuts,
  };
}

function setupProvider({ notice, onModelChange }) {
  const dialog = $('#settings-dialog'), form = $('#provider-form'), select = $('#provider-select');
  const close = $('#close-settings'), testButton = $('#test-provider'), saveButton = $('#save-provider');
  const keyInput = $('#provider-key'), showKey = $('#show-key'), keyHelp = $('#key-help');
  const status = $('#provider-status');
  const fields = {
    id: $('#provider-id'), name: $('#provider-name'), api: $('#provider-api'), url: $('#provider-url'), model: $('#provider-model'),
  };
  const errors = {
    id: $('#provider-id-error'), name: $('#provider-name-error'), url: $('#provider-url-error'), model: $('#provider-model-error'), key: $('#provider-key-error'),
  };
  let configs = null, current = null, busy = false, reasoning = false;

  select.addEventListener('change', () => {
    const value = configs?.providers.find(item => item.id === select.value)
      || configs?.presets.find(item => item.id === select.value)
      || { id: 'custom', name: '自定义供应商', baseUrl: '', api: 'openai-completions', model: '', proxy: false };
    fill(value);
  });
  showKey.addEventListener('click', () => {
    const visible = keyInput.type === 'password';
    keyInput.type = visible ? 'text' : 'password';
    showKey.textContent = visible ? '隐藏密钥' : '显示密钥';
    showKey.setAttribute('aria-pressed', String(visible));
  });
  close.addEventListener('click', () => { if (!busy) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { keyInput.value = ''; keyInput.type = 'password'; showKey.textContent = '显示密钥'; showKey.setAttribute('aria-pressed', 'false'); setStatus(''); clearErrors(); });

  function fill(value) {
    current = value || {};
    reasoning = current.reasoning === true;
    fields.id.value = current.id === 'custom' ? '' : (current.id || '');
    fields.name.value = current.name || '';
    fields.api.value = current.api || 'openai-completions';
    fields.url.value = current.baseUrl || '';
    fields.model.value = current.model || '';
    $('#provider-proxy').checked = current.proxy === true;
    keyInput.value = ''; keyInput.type = 'password';
    showKey.textContent = '显示密钥'; showKey.setAttribute('aria-pressed', 'false');
    keyHelp.textContent = current.hasKey
      ? '已保存密钥。留空保留原值；修改 API 地址时需重新填写。'
      : '密钥仅保存在服务端，不会回显，也不会写入浏览器存储。';
    clearErrors(); setStatus('');
  }
  function clearErrors() { for (const [id, target] of Object.entries(errors)) setFieldError(id === 'id' ? fields.id : id === 'name' ? fields.name : id === 'url' ? fields.url : id === 'model' ? fields.model : keyInput, target, ''); }
  function setStatus(text, tone = '') {
    status.textContent = text;
    status.className = 'provider-status' + (tone ? ' is-' + tone : '');
  }
  function input() {
    return { id: fields.id.value.trim(), name: fields.name.value.trim(), api: fields.api.value,
      baseUrl: fields.url.value.trim(), model: fields.model.value.trim(), proxy: $('#provider-proxy').checked,
      reasoning, apiKey: keyInput.value.trim() };
  }
  function validate(value) {
    clearErrors();
    let valid = true;
    const mark = (inputElement, target, condition, message) => {
      if (condition) { setFieldError(inputElement, target, message); valid = false; }
    };
    mark(fields.id, errors.id, !/^[a-z][a-z0-9-]{0,39}$/.test(value.id), '配置标识需为 1–40 位小写字母、数字或短横线。');
    mark(fields.name, errors.name, !value.name || value.name.length > 60, '请填写名称（最多 60 个字符）。');
    let url = null;
    try { url = new URL(value.baseUrl); } catch {}
    mark(fields.url, errors.url, !url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port,
      '请填写不含账号、查询参数或端口的 HTTPS 地址。');
    mark(fields.model, errors.model, !/^[A-Za-z0-9_.:/-]{1,160}$/.test(value.model), '请填写供应商提供的模型 ID。');
    const saved = configs?.providers.find(item => item.id === value.id);
    const needsKey = !saved?.hasKey || saved.baseUrl !== value.baseUrl.replace(/\/$/, '');
    mark(keyInput, errors.key, (needsKey && !value.apiKey) || value.apiKey.length > 1024 || /[\r\n]/.test(value.apiKey),
      needsKey ? '请填写 API 密钥。' : '密钥格式无效。');
    if (!valid) focusFirstError(form);
    return valid;
  }
  async function action(save) {
    if (busy) return;
    const value = input();
    if (!validate(value)) return;
    busy = true;
    testButton.disabled = saveButton.disabled = close.disabled = true;
    setStatus(save ? '正在保存…' : '正在测试模型调用…', 'pending');
    try {
      const result = await post(save ? '/api/providers/save' : '/api/providers/test', { config: value });
      if (save) {
        configs = result;
        populate();
        const active = result.providers.find(item => item.id === result.active);
        if (active) fill(active);
        setStatus('已保存，后续任务使用此配置。', 'success');
        onModelChange?.();
      } else {
        setStatus((result.detail || '测试完成') + ' · ' + (result.route || '') + (result.latency ? ' · ' + result.latency + ' ms' : ''),
          result.ok ? 'success' : 'error');
      }
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      busy = false; testButton.disabled = saveButton.disabled = close.disabled = false;
    }
  }
  form.addEventListener('submit', event => { event.preventDefault(); void action(true); });
  testButton.addEventListener('click', () => void action(false));
  function populate() {
    select.replaceChildren();
    const values = [...configs.providers, ...configs.presets.filter(value => !configs.providers.some(saved => saved.id === value.id)), { id: 'custom', name: '自定义供应商' }];
    for (const value of values) {
      const option = el('option', { value: value.id, text: value.name + (value.id === configs.active ? ' · 使用中' : '') });
      select.append(option);
    }
    select.value = configs.active;
  }
  async function open() {
    try {
      status.textContent = '正在读取供应商配置…';
      configs = await get('/api/providers');
      populate();
      fill(configs.providers.find(value => value.id === configs.active) || { id: 'custom', name: '自定义供应商', api: 'openai-completions', baseUrl: '', model: '', proxy: false });
      show(dialog);
      requestAnimationFrame(() => fields.id.focus());
    } catch (error) { notice(error.message, { tone: 'error' }); }
  }
  return { open };
}

function setupGrants({ notice }) {
  const dialog = $('#grants-dialog'), close = $('#close-grants'), search = $('#grant-search'), clear = $('#clear-grant-search');
  const status = $('#grant-status'), list = $('#grant-users'), reload = $('#reload-grants');
  let users = [], enabled = false, busy = false;
  search.addEventListener('input', () => { clear.hidden = !search.value; render(); });
  search.addEventListener('keydown', event => { if (event.key === 'Escape' && search.value) { event.preventDefault(); search.value = ''; clear.hidden = true; render(); } });
  clear.addEventListener('click', () => { search.value = ''; clear.hidden = true; render(); search.focus(); });
  close.addEventListener('click', () => { if (!busy) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  reload.addEventListener('click', () => void load());
  async function load() {
    status.textContent = '正在读取账户…'; reload.disabled = true;
    try {
      const result = await get('/api/grants');
      users = result.users || []; enabled = result.enabled === true;
      render();
      status.textContent = enabled ? '独立沙箱已启用；普通用户仍需逐个授权。' : '权限测试尚未放行，新增授权已关闭。';
    } catch (error) { status.textContent = error.message; }
    finally { reload.disabled = false; }
  }
  function render() {
    clear.hidden = !search.value;
    const query = search.value.trim().toLocaleLowerCase();
    const visible = users.filter(user => (user.name + ' ' + user.email).toLocaleLowerCase().includes(query));
    list.replaceChildren();
    status.setAttribute('aria-live', 'polite');
    if (!visible.length) { list.append(el('p', { class: 'list-empty', text: query ? '没有符合条件的账户。' : '没有可用账户。' })); return; }
    for (const user of visible) list.append(row(user));
  }
  function row(user) {
    const section = el('section', { class: 'grant-user' });
    section.append(el('strong', { text: user.name }), el('small', { text: user.email }));
    const now = Date.now() / 1000;
    const active = user.expires_at > now;
    const state = user.disabled ? '账户已停用' : user.admin ? '管理员 · 已有执行权限'
      : active ? '已授权至 ' + grantDate(user.expires_at) : user.expires_at ? '授权已过期' : '未授权';
    section.append(el('p', { class: 'hint', text: state }));
    if (!user.admin && !user.disabled) {
      const actions = el('div', { class: 'grant-actions' });
      const duration = el('select', { attrs: { 'aria-label': '为 ' + user.name + ' 选择授权期限' } });
      for (const days of [1, 7, 30]) duration.append(el('option', { value: String(days), text: days + ' 天' }));
      duration.value = '7';
      const save = el('button', { type: 'button', class: 'btn btn-solid', text: active ? '续期' : '授予' });
      save.disabled = busy || !enabled;
      save.addEventListener('click', () => void change(user, Number(duration.value)));
      actions.append(el('label', { class: 'grant-duration' }, el('span', { text: '期限' }), duration), save);
      if (active) {
        const revoke = el('button', { type: 'button', class: 'btn btn-quiet is-danger', text: '撤销' });
        revoke.disabled = busy;
        revoke.addEventListener('click', async () => {
          const ok = await confirmDialog({
            title: '撤销执行权限',
            body: '将停止 ' + user.name + ' 正在运行的任务，并关闭其执行权限。对话和工作区文件会保留，可随时重新授权。',
            confirmLabel: '撤销授权', tone: 'danger',
          });
          if (ok) void change(user, 0);
        });
        actions.append(revoke);
      }
      section.append(actions);
    }
    return section;
  }
  async function change(user, days) {
    if (busy) return;
    busy = true;
    list.querySelectorAll('button, select').forEach(control => { control.disabled = true; });
    close.disabled = reload.disabled = true;
    status.textContent = days ? '正在授予执行权限…' : '正在撤销授权并停止任务…';
    try {
      await post('/api/grants/save', { user_id: user.id, days });
      await load();
      status.textContent = days ? user.name + ' 已获得 ' + days + ' 天执行权限。' : user.name + ' 的执行授权已撤销。';
      notice(days ? '已授予执行权限' : '已撤销执行权限', { tone: 'success' });
    } catch (error) { status.textContent = error.message; notice(error.message, { tone: 'error' }); }
    finally { busy = false; close.disabled = reload.disabled = false; render(); search.focus(); }
  }
  async function open() {
    show(dialog);
    await load();
    requestAnimationFrame(() => search.focus());
  }
  return { open };
}

function setupRename({ notice }) {
  const dialog = $('#rename-dialog'), form = $('#rename-form'), input = $('#rename-input'), error = $('#rename-error');
  const close = $('#close-rename'), cancel = $('#cancel-rename'), save = $('#save-rename');
  let target = null, handler = null, busy = false, trigger = null;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    const title = input.value.replace(/\s+/g, ' ').trim();
    error.hidden = true;
    if (!title || title.length > 80) { error.textContent = '标题需为 1–80 个字符。'; error.hidden = false; input.focus(); return; }
    busy = true; save.disabled = cancel.disabled = close.disabled = true;
    try {
      await handler?.(title);
      dialog.close();
      notice('已重命名对话', { tone: 'success' });
    } catch (reason) {
      error.textContent = reason.message; error.hidden = false;
    } finally { busy = false; save.disabled = cancel.disabled = close.disabled = false; }
  });
  close.addEventListener('click', () => { if (!busy) dialog.close(); });
  cancel.addEventListener('click', () => { if (!busy) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { trigger?.focus?.(); trigger = null; target = null; handler = null; });
  function open(chat, onSave) {
    target = chat; handler = onSave; trigger = document.activeElement;
    input.value = chat.title || '';
    error.hidden = true;
    show(dialog);
    requestAnimationFrame(() => { input.focus(); input.select(); });
  }
  return { open };
}

let confirmResolve = null;
export function confirmDialog({ title, body, confirmLabel = '确认', tone = 'danger' }) {
  const dialog = $('#confirm-dialog'), heading = $('#confirm-title'), text = $('#confirm-body');
  const action = $('#confirm-action'), cancel = $('#confirm-cancel');
  heading.textContent = title;
  text.textContent = body;
  action.textContent = confirmLabel;
  action.className = 'btn ' + (tone === 'danger' ? 'btn-danger' : 'btn-solid');
  return new Promise(resolve => {
    confirmResolve = resolve;
    show(dialog);
    requestAnimationFrame(() => cancel.focus());
  });
}
export function bindConfirmDialog() {
  const dialog = $('#confirm-dialog'), action = $('#confirm-action'), cancel = $('#confirm-cancel');
  const finish = value => { confirmResolve?.(value); confirmResolve = null; if (dialog.open) dialog.close(); };
  action.addEventListener('click', () => finish(true));
  cancel.addEventListener('click', () => finish(false));
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
  dialog.addEventListener('close', () => { if (confirmResolve) { confirmResolve(false); confirmResolve = null; } });
}

export function openShortcuts() {
  const dialog = $('#shortcuts-dialog'), list = $('#shortcut-list');
  const items = [
    [platformKey('K'), '搜索对话'],
    [platformKey('Shift+O'), '新建对话'],
    [platformKey('Shift+E'), '导出当前对话'],
    ['Enter', '发送任务'],
    ['Shift+Enter', '换行'],
    ['Esc', '关闭菜单、对话框或抽屉'],
  ];
  list.replaceChildren();
  for (const [key, label] of items) list.append(el('div', { class: 'shortcut-row' }, el('span', { text: label }), el('kbd', { text: key })));
  const close = $('#close-shortcuts');
  close.onclick = () => dialog.close();
  show(dialog);
  requestAnimationFrame(() => close.focus());
}

const $ = id => document.getElementById(id);
let auth, chat, busy = false, configs, streamController, providerReasoning = false;
const tools = new Map();
document.documentElement.dataset.theme = localStorage.getItem('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
$('theme').onclick = () => { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = theme; localStorage.setItem('theme', theme); };
function notice(text, error = false) { $('notice').hidden = !text; $('notice').textContent = text; $('notice').setAttribute('role', error ? 'alert' : 'status'); }
async function api(path, data) {
  const response = await fetch(path, { method: data ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': auth?.csrf || '' }, body: data ? JSON.stringify(data) : undefined });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败，请刷新页面重试');
  return result;
}
function setBusy(value) {
  busy = value; $('send').hidden = value; $('stop').hidden = !value;
  $('new-chat').disabled = value || !auth?.can_execute; $('settings-button').disabled = value;
  $('task-state').textContent = value ? 'Pi 正在处理任务…' : auth?.can_execute ? '独立沙箱 · 无网络' : '尚未开通执行权限';
  $('chats').querySelectorAll('button').forEach(button => { button.disabled = value; });
}
function applyIdentity(value) {
  auth = value; $('user-name').textContent = auth.user.name; $('avatar').textContent = auth.user.name.slice(0, 1);
  $('settings-button').hidden = !auth.admin; $('grants-button').hidden = !auth.admin;
  $('role-label').textContent = auth.admin ? '管理员 · 独立沙箱' : auth.can_execute ? '已授权 · ' + new Date(auth.grant_expires_at * 1000).toLocaleDateString('zh-CN') + ' 到期' : '已登录 · 暂无执行权限';
  $('prompt').disabled = $('send').disabled = !auth.can_execute;
  document.querySelectorAll('[data-prompt]').forEach(button => { button.disabled = !auth.can_execute; });
  setBusy(busy);
}
function mobile(open) { document.querySelector('.shell').classList.toggle('sidebar-open', open); $('sidebar-shade').hidden = !open; $('menu-toggle').setAttribute('aria-expanded', String(open)); $('sidebar').inert = matchMedia('(max-width:680px)').matches && !open; }
matchMedia('(max-width:680px)').addEventListener('change', () => mobile(false));
mobile(false);
$('menu-toggle').onclick = () => mobile($('menu-toggle').getAttribute('aria-expanded') !== 'true');
$('sidebar-shade').onclick = () => mobile(false);
document.addEventListener('keydown', event => { if (event.key === 'Escape' && $('menu-toggle').getAttribute('aria-expanded') === 'true') { mobile(false); $('menu-toggle').focus(); } });
function textBlocks(target, text) {
  target.replaceChildren();
  text.split(/```/).forEach((part, index) => {
    const element = document.createElement(index % 2 ? 'pre' : 'p'); element.textContent = index % 2 ? part.replace(/^[^\n]*\n/, '') : part;
    if (element.textContent.trim()) target.append(element);
  });
}
function message(role, text = '') {
  const article = document.createElement('article'); article.className = 'message ' + role;
  const label = document.createElement('div'); label.className = 'message-label'; label.textContent = role === 'assistant' ? 'Pi' : '你';
  const content = document.createElement('div'); textBlocks(content, text); article.append(label, content); $('messages').append(article); $('welcome').hidden = true;
  return { content, text };
}
function scrollBottom() { const area = $('conversation'); area.scrollTop = area.scrollHeight; }
function contentText(item) { return typeof item?.content === 'string' ? item.content : (item?.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n'); }
async function listChats() {
  const result = await api('/api/chats'); $('chats').replaceChildren();
  if (!result.chats.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = '新想法从这里开始。'; $('chats').append(p); }
  for (const item of result.chats) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = item.title || '新对话'; button.title = item.title; button.classList.toggle('active', item.id === chat); button.disabled = busy;
    button.onclick = () => selectChat(item.id).catch(error => notice(error.message, true)); $('chats').append(button);
  }
}
async function selectChat(id) {
  if (busy) return;
  chat = id; history.replaceState(null, '', '/?chat=' + chat); mobile(false); notice('正在读取对话…');
  $('messages').replaceChildren(); $('welcome').hidden = false; tools.clear();
  const result = await api('/api/session?chat=' + encodeURIComponent(chat));
  for (const item of result.messages) {
    if (['user', 'assistant'].includes(item.role) && contentText(item)) message(item.role, contentText(item));
    if (item.role === 'toolResult') toolResult(item.toolCallId, item.toolName || '工具', contentText(item), item.isError);
  }
  setBusy(result.busy); notice(''); await listChats(); scrollBottom();
}
function newChat() {
  if (busy) return;
  chat = crypto.randomUUID(); history.replaceState(null, '', '/?chat=' + chat); mobile(false);
  $('messages').replaceChildren(); $('welcome').hidden = false; tools.clear(); $('prompt').focus(); notice('');
  $('chats').querySelectorAll('.active').forEach(item => item.classList.remove('active'));
}
$('new-chat').onclick = newChat;
document.querySelectorAll('[data-prompt]').forEach(button => { button.onclick = () => { $('prompt').value = button.dataset.prompt; $('prompt').focus(); }; });
function toolResult(id, name, text, error = false) {
  let item = tools.get(id);
  if (!item) { item = document.createElement('details'); item.className = 'tool'; item.append(document.createElement('summary'), document.createElement('pre')); $('messages').append(item); tools.set(id, item); }
  item.querySelector('summary').textContent = `${name} · ${error ? '执行失败' : text ? '已完成' : '执行中'}`; item.querySelector('pre').textContent = text || '正在执行…';
}
$('prompt-form').onsubmit = async event => {
  event.preventDefault(); if (busy || !auth?.can_execute) return;
  const input = $('prompt').value.trim(); if (!input) return;
  if (!chat) newChat(); message('user', input); $('prompt').value = ''; setBusy(true); notice(''); scrollBottom();
  let current; streamController = new AbortController();
  try {
    const response = await fetch('/api/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': auth.csrf }, body: JSON.stringify({ thread: chat, message: input }), signal: streamController.signal });
    if (!response.ok) throw new Error((await response.json()).error || '任务启动失败');
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break; buffer += decoder.decode(chunk.value, { stream: true }); let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line) continue; const item = JSON.parse(line);
        if (item.type === 'message_start' && item.message?.role === 'assistant') current = undefined;
        if (item.type === 'message_update' && item.assistantMessageEvent?.type === 'text_delta') { current ||= message('assistant'); current.text += item.assistantMessageEvent.delta; textBlocks(current.content, current.text); }
        if (item.type === 'message_end' && item.message?.role === 'assistant') {
          const text = contentText(item.message); if (text) { current ||= message('assistant'); textBlocks(current.content, text); }
          if (item.message.errorMessage) notice(item.message.errorMessage, true);
        }
        if (item.type === 'tool_execution_start') toolResult(item.toolCallId, item.toolName, '');
        if (item.type === 'tool_execution_end') toolResult(item.toolCallId, item.toolName, contentText(item.result), item.isError);
        if (item.type === 'gateway_error') throw new Error(item.error); scrollBottom();
      }
    }
  } catch (error) { if (error.name !== 'AbortError') notice(error.message || '连接中断，请重新读取对话。', true); }
  finally { setBusy(false); streamController = undefined; try { applyIdentity(await api('/api/me')); } catch { applyIdentity({ ...auth, can_execute: false }); } if (auth.can_execute) { await listChats().catch(() => {}); $('prompt').focus(); } else notice('执行权限已失效，任务已停止。请联系管理员或重新登录。', true); }
};
$('prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('prompt-form').requestSubmit(); } });
$('stop').onclick = async () => { try { await api('/api/abort', { thread: chat }); if (!streamController) { setBusy(false); await selectChat(chat); } } catch (error) { notice(error.message, true); } };
$('logout').onclick = async () => { try { await api('/auth/logout', {}); location.assign('/auth/login'); } catch (error) { notice(error.message, true); } };
function fillProvider(value) {
  providerReasoning = value.reasoning === true;
  $('provider-id').value = value.id; $('provider-name').value = value.name; $('provider-url').value = value.baseUrl; $('provider-api').value = value.api; $('provider-model').value = value.model; $('provider-proxy').checked = value.proxy;
  $('provider-key').value = ''; $('provider-key').type = 'password'; $('show-key').textContent = '显示密钥'; $('show-key').setAttribute('aria-pressed', 'false'); $('provider-status').textContent = '';
  $('key-help').textContent = value.hasKey ? '已保存密钥。留空保留原值；修改 API 地址时需重新填写。' : '密钥仅保存在服务端，不会回显，也不会保存到浏览器。';
}
function providerInput() { return { id: $('provider-id').value.trim(), name: $('provider-name').value.trim(), api: $('provider-api').value, baseUrl: $('provider-url').value.trim(), model: $('provider-model').value.trim(), proxy: $('provider-proxy').checked, reasoning: providerReasoning, apiKey: $('provider-key').value.trim() }; }
async function loadProviders() { configs = await api('/api/providers'); const active = configs.providers.find(value => value.id === configs.active); if (active) $('model-name').textContent = active.model; }
$('settings-button').onclick = async () => {
  try {
    await loadProviders(); $('provider-select').replaceChildren();
    const values = [...configs.providers, ...configs.presets.filter(value => !configs.providers.some(saved => saved.id === value.id)), { id: 'custom', name: '自定义供应商' }];
    for (const value of values) { const option = document.createElement('option'); option.value = value.id; option.textContent = value.name + (value.id === configs.active ? ' · 使用中' : ''); $('provider-select').append(option); }
    $('provider-select').value = configs.active; fillProvider(configs.providers.find(value => value.id === configs.active)); $('settings').showModal();
  } catch (error) { notice(error.message, true); }
};
$('provider-select').onchange = () => { const id = $('provider-select').value; fillProvider(configs.providers.find(value => value.id === id) || configs.presets.find(value => value.id === id) || { id: 'custom', name: '自定义供应商', baseUrl: '', api: 'openai-completions', model: '', proxy: false }); };
$('close-settings').onclick = () => $('settings').close();
$('settings').addEventListener('close', () => { $('provider-key').value = ''; });
$('show-key').onclick = () => { const show = $('provider-key').type === 'password'; $('provider-key').type = show ? 'text' : 'password'; $('show-key').textContent = show ? '隐藏密钥' : '显示密钥'; $('show-key').setAttribute('aria-pressed', String(show)); };
async function providerAction(save) {
  if (!$('provider-form').reportValidity()) return;
  const status = $('provider-status'); status.className = 'provider-status'; status.textContent = save ? '正在保存…' : '正在测试模型调用…';
  $('test-provider').disabled = $('save-provider').disabled = $('close-settings').disabled = true; const input = providerInput();
  try {
    const result = await api(save ? '/api/providers/save' : '/api/providers/test', { config: input });
    if (save) { configs = result; fillProvider(result.providers.find(value => value.id === result.active)); $('model-name').textContent = input.model; status.className = 'provider-status ok'; status.textContent = '已保存，后续任务使用此配置。'; }
    else { status.className = 'provider-status ' + (result.ok ? 'ok' : 'error'); status.textContent = `${result.detail} · ${result.route}${result.latency ? ` · ${result.latency} ms` : ''}`; }
  } catch (error) { status.className = 'provider-status error'; status.textContent = error.message; }
  finally { $('test-provider').disabled = $('save-provider').disabled = $('close-settings').disabled = false; }
}
$('test-provider').onclick = () => providerAction(false);
$('provider-form').onsubmit = event => { event.preventDefault(); void providerAction(true); };
(async () => {
  try {
    applyIdentity(await api('/api/me'));
    if (!auth.can_execute) { notice('此账户尚未获得执行授权，请联系管理员开通。已有授权可能已过期或被撤销。'); $('chats').replaceChildren(); return; }
    if (auth.admin) await loadProviders(); const id = new URLSearchParams(location.search).get('chat');
    if (id && /^[a-f0-9-]{36}$/.test(id)) await selectChat(id); else { newChat(); await listChats(); }
  } catch (error) { notice(error.message || '无法读取账户，请刷新重试。', true); }
})();

let grantUsers = [], grantsEnabled = false, grantsBusy = false;
function renderGrants() {
  const query = $('grant-search').value.trim().toLocaleLowerCase();
  const users = grantUsers.filter(user => (user.name + ' ' + user.email).toLocaleLowerCase().includes(query));
  $('grant-users').replaceChildren();
  if (!users.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = '没有符合条件的账户。'; $('grant-users').append(empty); }
  for (const user of users) {
    const row = document.createElement('section'); row.className = 'grant-user';
    const name = document.createElement('strong'); name.textContent = user.name;
    const email = document.createElement('small'); email.textContent = user.email;
    const state = document.createElement('p'); state.className = 'hint';
    const active = user.expires_at > Date.now() / 1000;
    state.textContent = user.disabled ? '账户已停用' : user.admin ? '管理员 · 已有执行权限' : active ? '已授权至 ' + new Date(user.expires_at * 1000).toLocaleString('zh-CN') : user.expires_at ? '授权已过期' : '未授权';
    row.append(name, email, state);
    if (!user.admin && !user.disabled) {
      const actions = document.createElement('div'); actions.className = 'dialog-actions';
      const label = document.createElement('label'); label.textContent = '授权期限';
      const duration = document.createElement('select');
      for (const days of [1, 7, 30]) { const option = document.createElement('option'); option.value = days; option.textContent = days + ' 天'; duration.append(option); }
      duration.value = '7'; label.append(duration);
      const save = document.createElement('button'); save.type = 'button'; save.className = 'primary'; save.textContent = active ? '续期授权' : '授予执行权限'; save.disabled = grantsBusy || !grantsEnabled;
      save.onclick = () => changeGrant(user, Number(duration.value)); actions.append(label, save);
      if (active) { const revoke = document.createElement('button'); revoke.type = 'button'; revoke.className = 'secondary'; revoke.textContent = '撤销授权'; revoke.disabled = grantsBusy; revoke.onclick = () => changeGrant(user, 0); actions.append(revoke); }
      row.append(actions);
    }
    $('grant-users').append(row);
  }
}
async function refreshGrants() {
  $('grant-status').textContent = '正在读取账户…'; $('reload-grants').disabled = true;
  try { const result = await api('/api/grants'); grantUsers = result.users; grantsEnabled = result.enabled; renderGrants(); $('grant-status').textContent = result.enabled ? '独立沙箱已启用；普通用户需要单独授权。' : '权限测试尚未放行，新增授权已关闭。'; }
  catch (error) { $('grant-status').textContent = error.message + '。可刷新重试。'; }
  finally { $('reload-grants').disabled = false; }
}
async function changeGrant(user, days) {
  if (grantsBusy) return; grantsBusy = true;
  // Keep the selected row/focus in place while the request is pending.
  $('grant-users').querySelectorAll('button, select').forEach(control => { control.disabled = true; });
  $('close-grants').disabled = $('reload-grants').disabled = true;
  $('grant-status').textContent = days ? '正在授予执行权限…' : '正在撤销授权并停止任务…';
  try { await api('/api/grants/save', { user_id: user.id, days }); await refreshGrants(); $('grant-status').textContent = days ? user.name + ' 已获得 ' + days + ' 天执行权限。' : user.name + ' 的执行授权已撤销。'; }
  catch (error) { $('grant-status').textContent = error.message + '。请刷新列表核对当前状态后重试。'; }
  finally { grantsBusy = false; $('close-grants').disabled = $('reload-grants').disabled = false; renderGrants(); $('grant-search').focus(); }
}
$('grants-button').onclick = () => { $('grants').showModal(); void refreshGrants(); };
$('close-grants').onclick = () => $('grants').close();
$('grants').addEventListener('cancel', event => { if (grantsBusy) event.preventDefault(); });
$('grant-search').oninput = renderGrants;
$('reload-grants').onclick = refreshGrants;

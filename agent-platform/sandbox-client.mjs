import { required, fail } from './shared.mjs';
const url = process.env.SANDBOX_URL || 'http://192.168.84.1:18082';
export async function sandbox(path, user, token, policy, extra, timeout = 15000) {
  const payload = { user, token, policy };
  if (extra && typeof extra === 'object') Object.assign(payload, extra);
  const response = await fetch(url + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + required('SANDBOX_SECRET') },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(timeout) });
  if (!response.ok) {
    if (path === '/files/operation') {
      const detail = await response.json().catch(() => ({}));
      const status = [400, 404, 409, 413, 422].includes(response.status) ? response.status : 503;
      fail(status, detail.error || '工作区操作失败，请稍后重试');
    }
    // Interactive controls surface the broker's reason when a session fails.
    if (path.startsWith('/pty/') || path.startsWith('/browser/')) {
      const detail = await response.json().catch(() => ({}));
      if (typeof detail.error === 'string' && detail.error) fail(response.status === 400 || response.status === 409 ? 409 : 503, detail.error);
    }
    fail(503, '独立沙箱不可用，执行已关闭');
  }
  return response.json();
}
// A long-lived frame stream: the broker keeps the response open and pushes
// newline-delimited JSON frames. The caller aborts it when the pane goes away.
export async function sandboxStream(path, user, extra) {
  const payload = { user, policy: null };
  if (extra && typeof extra === 'object') Object.assign(payload, extra);
  const controller = new AbortController();
  let response;
  try {
    response = await fetch(url + path, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + required('SANDBOX_SECRET') },
      body: JSON.stringify(payload), redirect: 'error', signal: controller.signal });
  } catch {
    fail(503, '独立沙箱暂时不可用，请稍后重试');
  }
  if (!response.ok && !(path === '/files/download' && response.status === 416)) {
    const detail = await response.json().catch(() => ({}));
    if (path === '/files/download' && [404, 422].includes(response.status)) fail(response.status, detail.error);
    fail(response.status === 404 ? 409 : 503, typeof detail.error === 'string' && detail.error ? detail.error : '浏览器画面不可用');
  }
  return { response, abort: () => controller.abort() };
}

// Tool requests use the short-lived per-user lease, never the host control secret.
export async function sandboxTool(token, value, timeout = 30000, signal) {
  let response;
  try {
    response = await fetch(url + '/tool', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(value), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout), redirect: 'error' });
  } catch { fail(503, '独立沙箱暂时不可用，请稍后重试'); }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 403) fail(409, '工作区授权已失效，请重试；任务不会被停止');
    if (response.status === 409) fail(409, typeof result.error === 'string' ? result.error : '文件已存在，请确认覆盖');
    fail(503, typeof result.error === 'string' ? result.error : '工作区操作失败，请稍后重试');
  }
  return result;
}

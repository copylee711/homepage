import { required, fail } from './shared.mjs';
const url = process.env.SANDBOX_URL || 'http://192.168.84.1:18082';
export async function sandbox(path, user, token, policy, extra) {
  const payload = { user, token, policy };
  if (extra && typeof extra === 'object') Object.assign(payload, extra);
  const response = await fetch(url + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + required('SANDBOX_SECRET') },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    // Terminal control is interactive: the broker's own reason (memory budget,
    // terminal gone after a restart) is what the user needs to see.
    if (path.startsWith('/pty/')) {
      const detail = await response.json().catch(() => ({}));
      if (typeof detail.error === 'string' && detail.error) fail(response.status === 400 || response.status === 409 ? 409 : 503, detail.error);
    }
    fail(503, '独立沙箱不可用，执行已关闭');
  }
  return response.json();
}
// Tool requests use the short-lived per-user lease, never the host control secret.
export async function sandboxTool(token, value, timeout = 30000) {
  let response;
  try {
    response = await fetch(url + '/tool', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(value), signal: AbortSignal.timeout(timeout), redirect: 'error' });
  } catch { fail(503, '独立沙箱暂时不可用，请稍后重试'); }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 403) fail(409, '工作区授权已失效，请重试；任务不会被停止');
    if (response.status === 409) fail(409, typeof result.error === 'string' ? result.error : '文件已存在，请确认覆盖');
    fail(503, typeof result.error === 'string' ? result.error : '工作区操作失败，请稍后重试');
  }
  return result;
}

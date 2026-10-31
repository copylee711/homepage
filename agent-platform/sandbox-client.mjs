import { required, fail } from './shared.mjs';
const url = process.env.SANDBOX_URL || 'http://192.168.84.1:18082';
export async function sandbox(path, user, token) {
  const response = await fetch(url + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + required('SANDBOX_SECRET') },
    body: JSON.stringify({ user, token }), signal: AbortSignal.timeout(15000) });
  if (!response.ok) fail(503, '独立沙箱不可用，执行已关闭');
  return response.json();
}
// Tool requests use the short-lived per-user lease, never the host control secret.
export async function sandboxTool(token, value) {
  let response;
  try {
    response = await fetch(url + '/tool', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(value), signal: AbortSignal.timeout(30000), redirect: 'error' });
  } catch { fail(503, '独立沙箱暂时不可用，请稍后重试'); }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 403) fail(409, '工作区授权已失效，请重试；任务不会被停止');
    if (response.status === 409) fail(409, typeof result.error === 'string' ? result.error : '文件已存在，请确认覆盖');
    fail(503, typeof result.error === 'string' ? result.error : '工作区操作失败，请稍后重试');
  }
  return result;
}

import { required, fail } from './shared.mjs';
const url = process.env.SANDBOX_URL || 'http://192.168.84.1:18082';
export async function sandbox(path, user, token) {
  const response = await fetch(url + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + required('SANDBOX_SECRET') },
    body: JSON.stringify({ user, token }), signal: AbortSignal.timeout(15000) });
  if (!response.ok) fail(503, '独立沙箱不可用，执行已关闭');
  return response.json();
}

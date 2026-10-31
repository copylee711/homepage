let csrfToken = '';
export class ApiError extends Error {
  constructor(message, status = 0, data = undefined) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}
export function setCsrf(value) { csrfToken = value || ''; }
export function getCsrf() { return csrfToken; }

async function read(response) {
  const type = response.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    try { return await response.json(); } catch { return {}; }
  }
  return {};
}
export async function request(path, { method = 'GET', body, signal } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      credentials: 'same-origin',
      redirect: 'error',
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new ApiError(navigator.onLine === false ? '网络已断开，请检查连接后重试' : '无法连接服务，请稍后重试', 0);
  }
  const data = await read(response);
  if (!response.ok) {
    throw new ApiError(typeof data.error === 'string' && data.error ? data.error : '请求失败，请稍后重试', response.status, data);
  }
  return data;
}
export function get(path, signal) { return request(path, { signal }); }
export function post(path, body, signal) { return request(path, { method: 'POST', body, signal }); }

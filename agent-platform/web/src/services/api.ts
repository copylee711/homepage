let csrfToken = '';
export function setCsrf(value: string) { csrfToken = value || ''; }
export function getCsrf() { return csrfToken; }

export class ApiError extends Error {
  status: number;
  data: unknown;
  constructor(message: string, status = 0, data: unknown = undefined) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

async function read(response: Response) {
  const type = response.headers.get('content-type') || '';
  if (type.includes('application/json')) { try { return await response.json(); } catch { return {}; } }
  return {};
}

export async function request(path: string, { method = 'GET', body, signal }: { method?: string; body?: unknown; signal?: AbortSignal } = {}) {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal, credentials: 'same-origin', redirect: 'error',
    });
  } catch (error: any) {
    if (error?.name === 'AbortError') throw error;
    throw new ApiError(navigator.onLine === false ? '网络已断开，请检查连接后重试' : '无法连接服务，请稍后重试', 0);
  }
  const data: any = await read(response);
  if (!response.ok) throw new ApiError(typeof data.error === 'string' && data.error ? data.error : '请求失败，请稍后重试', response.status, data);
  return data;
}

export function get(path: string, signal?: AbortSignal) { return request(path, { signal }); }
export function post(path: string, body?: unknown, signal?: AbortSignal) { return request(path, { method: 'POST', body, signal }); }

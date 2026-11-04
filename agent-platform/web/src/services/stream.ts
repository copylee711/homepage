import { ApiError, get, getCsrf } from './api';
import { eventBatch } from './event-batch.mjs';

// Parses the runner's NDJSON prompt stream. Handles UTF-8 split across chunks and
// records split across arbitrary network boundaries.
export async function streamPrompt({ thread, message, images, thinking, projectId, permission, signal, onEvent }: {
  thread: string; message: string; images?: Array<{ type: 'image'; data: string; mimeType: string }>; thinking?: string; projectId?: string; permission?: any; signal: AbortSignal; onEvent: (event: any) => void;
}): Promise<{ settled: boolean }> {
  let response: Response;
  try {
    response = await fetch('/api/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrf() },
      body: JSON.stringify({ thread, message, images, thinking, projectId, permission }),
      signal, credentials: 'same-origin', redirect: 'error',
    });
  } catch (error: any) {
    if (error?.name === 'AbortError') throw error;
    throw new ApiError(navigator.onLine === false ? '网络已断开，任务未发送。' : '无法连接服务，任务未发送。', 0);
  }
  if (!response.ok) {
    const data: any = await response.json().catch(() => ({}));
    throw new ApiError(typeof data.error === 'string' ? data.error : '任务启动失败，请重试', response.status, data);
  }
  return readTurn(response, { thread, signal, onEvent });
}

type Subscription = { thread: string; signal: AbortSignal; onEvent: (event: any) => void };

function subscribe(thread: string, cursor: number, signal: AbortSignal) {
  return fetch('/api/turns/subscribe', {
    method: 'POST', credentials: 'same-origin', signal,
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrf() },
    body: JSON.stringify({ thread, cursor }),
  });
}

function retryDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    function abort() { clearTimeout(timer); reject(signal.reason); }
    signal.addEventListener('abort', abort, { once: true });
  });
}

export function resumePrompt(options: Subscription) {
  return readTurn(null, options);
}

async function readTurn(initial: Response | null, { thread, signal, onEvent }: Subscription) {
  let response = initial;
  let settled = false;
  let cursor = 0;
  let failures = 0;
  const batch = eventBatch(onEvent);
  const dispatch = (line: string) => {
    if (!line.trim()) return;
    let event: any;
    try { event = JSON.parse(line); } catch { return; }
    if (event?.type === 'turn_gap') throw new ApiError('部分实时记录已过期，请重新载入对话。', 0);
    cursor++;
    failures = 0;
    if (event?.type === 'agent_settled') settled = true;
    batch.push(event);
  };
  while (!settled) {
    signal.throwIfAborted();
    if (!response) {
      if (failures) await retryDelay(Math.min(500 * 2 ** Math.min(failures - 1, 5), 10000), signal);
      try { response = await subscribe(thread, cursor, signal); }
      catch { signal.throwIfAborted(); failures++; continue; }
      if (response.status === 429 || response.status >= 500) {
        void response.body?.cancel();
        response = null;
        failures++;
        continue;
      }
      if (!response.ok) throw new ApiError('无法继续接收当前任务，请重新载入对话。', response.status);
    }
    if (!response.body) throw new ApiError('浏览器无法读取流式响应', 0);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (!settled) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try { chunk = await reader.read(); }
        catch { signal.throwIfAborted(); break; }
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          dispatch(line);
        }
      }
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
      batch.flush();
    }
    response = null;
    if (!settled) {
      failures++;
      if (failures > 1) {
        const status = await get('/api/turns/status?thread=' + encodeURIComponent(thread), signal).catch(() => null);
        if (status && !status.busy && cursor >= status.cursor) return { settled: status.settled === true };
      }
    }
  }
  return { settled };
}

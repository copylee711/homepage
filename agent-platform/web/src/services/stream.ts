import { ApiError, getCsrf } from './api';
import { eventBatch } from './event-batch.mjs';

// Parses the runner's NDJSON prompt stream. Handles UTF-8 split across chunks and
// records split across arbitrary network boundaries.
export async function streamPrompt({ thread, message, images, thinking, projectId, permission, goal, signal, onEvent }: {
  thread: string; message: string; images?: Array<{ type: 'image'; data: string; mimeType: string }>; thinking?: string; projectId?: string; permission?: any; goal?: boolean; signal: AbortSignal; onEvent: (event: any) => void;
}): Promise<{ settled: boolean }> {
  let response: Response;
  try {
    response = await fetch('/api/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrf() },
      body: JSON.stringify({ thread, message, images, thinking, projectId, permission, goal: goal || undefined }),
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
  if (!response.body) throw new ApiError('浏览器无法读取流式响应', 0);
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let settled = false;
  const batch = eventBatch(onEvent);
  const dispatch = (line: string) => {
    if (!line.trim()) return;
    let event: any;
    try { event = JSON.parse(line); } catch { return; }
    if (event?.type === 'agent_settled') settled = true;
    batch.push(event);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        dispatch(line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) dispatch(buffer);
  } finally {
    batch.flush();
    reader.releaseLock?.();
  }
  return { settled };
}

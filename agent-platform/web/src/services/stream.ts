import { ApiError, getCsrf } from './api';
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
  if (!response.body) throw new ApiError('浏览器无法读取流式响应', 0);
  let reader = response.body.getReader();
  let decoder = new TextDecoder('utf-8');
  let buffer = '';
  let settled = false;
  let cursor = 0;
  let reconnects = 0;
  const batch = eventBatch(onEvent);
  const dispatch = (line: string) => {
    if (!line.trim()) return;
    let event: any;
    try { event = JSON.parse(line); } catch { return; }
    if (event?.type === 'turn_gap') throw new ApiError('部分实时记录已过期，请刷新对话查看结果。', 0);
    cursor++;
    if (event?.type === 'agent_settled') settled = true;
    batch.push(event);
  };
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); }
      catch (error: any) {
        if (signal.aborted || error?.name === 'AbortError') throw error;
        chunk = { done: true, value: undefined };
      }
      const { done, value } = chunk;
      if (done) {
        if (settled || signal.aborted || reconnects++ >= 3) break;
        reader.releaseLock();
        buffer = '';
        decoder = new TextDecoder();
        let resumed: Response;
        try {
          resumed = await fetch('/api/turns/subscribe', {
            method: 'POST', credentials: 'same-origin', signal,
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrf() },
            body: JSON.stringify({ thread, cursor }),
          });
        } catch (error: any) {
          if (signal.aborted || error?.name === 'AbortError') throw error;
          throw new ApiError('连接暂时中断，请刷新对话查看云端任务。', 0);
        }
        if (!resumed.ok || !resumed.body) break;
        reader = resumed.body.getReader();
        continue;
      }
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

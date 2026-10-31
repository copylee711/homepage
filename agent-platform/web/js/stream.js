import { ApiError, getCsrf } from './api.js';

// Parses the runner's NDJSON stream. TextDecoder(stream) handles split UTF-8 and
// the line buffer handles records split across arbitrary network chunks.
export async function streamPrompt({ thread, message, signal, onEvent }) {
  let response;
  try {
    response = await fetch('/api/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrf() },
      body: JSON.stringify({ thread, message }),
      signal,
      credentials: 'same-origin',
      redirect: 'error',
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new ApiError(navigator.onLine === false ? '网络已断开，任务未发送。' : '无法连接服务，任务未发送。', 0);
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(typeof data.error === 'string' ? data.error : '任务启动失败，请重试', response.status, data);
  }
  if (!response.body) throw new ApiError('浏览器无法读取流式响应', 0);
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let settled = false;
  const dispatch = line => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event?.type === 'agent_settled') settled = true;
    onEvent(event);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
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
    reader.releaseLock?.();
  }
  return { settled };
}

import type { Chat } from '../stores/session';

const day = (value: number | string) => { const d = new Date(value); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };

export function formatClock(value: number | string) {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}
export function formatDate(value: number | string) {
  const d = new Date(value); const now = new Date();
  if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
}
export function formatShort(value: number | string) {
  const d = new Date(value); const today = day(Date.now());
  if (day(d.getTime()) === today) return formatClock(d.getTime());
  return (d.getMonth() + 1) + '/' + d.getDate();
}
export function formatBytes(value: number) {
  const size = Number(value) || 0;
  if (size < 1024) return size + ' B';
  if (size < 1024 * 1024) return (size / 1024).toFixed(size < 10 * 1024 ? 1 : 0) + ' KB';
  return (size / 1024 / 1024).toFixed(1) + ' MB';
}
export function formatDuration(ms: number) {
  const v = Number(ms) || 0;
  if (v < 1000) return Math.max(0, Math.round(v)) + ' ms';
  if (v < 60000) return (v / 1000).toFixed(v < 10000 ? 1 : 0) + ' s';
  return Math.floor(v / 60000) + ' 分 ' + Math.round((v % 60000) / 1000) + ' 秒';
}
export function grantDate(seconds?: number) { return seconds ? new Date(seconds * 1000).toLocaleDateString('zh-CN') : ''; }

export interface ChatGroup { key: string; label: string; chats: Chat[]; }
export function groupChats(chats: Chat[], groupByDate = true): ChatGroup[] {
  const pinned = chats.filter(c => c.pinned);
  const rest = chats.filter(c => !c.pinned);
  const groups: ChatGroup[] = [];
  if (pinned.length) groups.push({ key: 'pinned', label: '置顶', chats: pinned });

  if (!groupByDate) {
    if (rest.length) groups.push({ key: 'all', label: pinned.length ? '全部对话' : '', chats: rest });
    return groups;
  }

  const today = day(Date.now()), yesterday = today - 86400000, week = today - 6 * 86400000;
  const t: Chat[] = [], y: Chat[] = [], w: Chat[] = [], o: Chat[] = [];
  for (const c of rest) {
    const s = day(c.updated);
    if (s >= today) t.push(c); else if (s >= yesterday) y.push(c); else if (s >= week) w.push(c); else o.push(c);
  }
  if (t.length) groups.push({ key: 'today', label: '今天', chats: t });
  if (y.length) groups.push({ key: 'yesterday', label: '昨天', chats: y });
  if (w.length) groups.push({ key: 'week', label: '最近 7 天', chats: w });
  if (o.length) groups.push({ key: 'older', label: '更早', chats: o });
  return groups;
}

export function textContent(value: any): string {
  if (typeof value === 'string') return value;
  return (Array.isArray(value) ? value : []).filter((p: any) => p?.type === 'text').map((p: any) => p.text || '').join('\n');
}

// Normalize an assistant message's content (Pi shape or live view-model) into
// the block list BlockList.vue renders.
export function normalizeBlocks(content: any, toolResults?: Record<string, any>): any[] {
  if (!Array.isArray(content)) return content ? [{ type: 'text', text: String(content) }] : [];
  // Live view-model blocks already use {type:'text'|'thinking'|'tool'}.
  if (content.some((b: any) => b && (b.type === 'tool' || (b.type === 'text' && 'index' in b)))) return content;
  const blocks: any[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text') blocks.push({ type: 'text', text: part.text || '' });
    else if (part.type === 'thinking' && part.thinking) blocks.push({ type: 'thinking', text: part.thinking });
    else if (part.type === 'toolCall') {
      const r = toolResults?.[part.id];
      blocks.push({ type: 'tool', id: part.id, name: part.name || 'tool', args: part.arguments ? JSON.stringify(part.arguments, null, 2) : '', state: r ? (r.isError ? 'error' : 'success') : 'success', result: r ? r.text : '', durationMs: 0 });
    }
  }
  return blocks;
}

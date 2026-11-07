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
export function formatDuration(ms: number, live = false) {
  const v = Math.max(0, Number(ms) || 0);
  if (live) {
    if (v < 60000) return (v / 1000).toFixed(1) + 's';
    const mins = Math.floor(v / 60000);
    const secs = ((v % 60000) / 1000).toFixed(1);
    return `${mins}分 ${secs}秒`;
  }
  if (v < 100) return Math.round(v) + 'ms';
  if (v < 60000) return (v / 1000).toFixed(1) + 's';
  return Math.floor(v / 60000) + '分 ' + Math.round((v % 60000) / 1000) + '秒';
}
export function grantDate(seconds?: number) { return seconds ? new Date(seconds * 1000).toLocaleDateString('zh-CN') : ''; }

export interface ChatGroup { key: string; label: string; chats: Chat[]; }
export function groupChats(
  chats: Chat[],
  mode: boolean | 'date' | 'project' | 'none' = 'date',
  projects: Array<{ id: string; name: string }> = []
): ChatGroup[] {
  const groups: ChatGroup[] = [];

  // When grouping by project: keep chats (including pinned) inside their respective projects,
  // with pinned chats sorted to the top of each project group.
  if (mode === 'project') {
    const byProj = new Map<string, Chat[]>();
    for (const c of chats) {
      const pid = c.projectId || 'default';
      if (!byProj.has(pid)) byProj.set(pid, []);
      byProj.get(pid)!.push(c);
    }
    for (const p of projects) {
      const list = byProj.get(p.id) || [];
      list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updated || 0) - (a.updated || 0));
      groups.push({ key: 'proj:' + p.id, label: p.name || p.id, chats: list });
      byProj.delete(p.id);
    }
    for (const [pid, list] of byProj.entries()) {
      list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updated || 0) - (a.updated || 0));
      groups.push({ key: 'proj:' + pid, label: pid === 'default' ? '默认项目' : pid, chats: list });
    }
    return groups;
  }

  const pinned = chats.filter(c => c.pinned);
  const rest = chats.filter(c => !c.pinned);
  if (pinned.length) groups.push({ key: 'pinned', label: '置顶', chats: pinned });

  if (mode === false || mode === 'none') {
    if (rest.length) groups.push({ key: 'all', label: pinned.length ? '全部任务' : '', chats: rest });
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

export { normalizeBlocks } from './transcript.mjs';

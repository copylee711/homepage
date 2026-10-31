const day = value => {
  const date = new Date(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};
export function formatClock(value) {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}
export function formatDate(value) {
  const date = new Date(value);
  const now = new Date();
  if (year(date) === year(now)) return (date.getMonth() + 1) + '月' + date.getDate() + '日';
  return date.getFullYear() + '年' + (date.getMonth() + 1) + '月' + date.getDate() + '日';
}
function year(date) { return date.getFullYear(); }
export function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return formatDate(date) + ' ' + formatClock(date);
}
export function formatShort(value) {
  const date = new Date(value);
  const today = day(Date.now());
  if (day(date) === today) return formatClock(date);
  return (date.getMonth() + 1) + '/' + date.getDate();
}
export function formatBytes(value) {
  const size = Number(value) || 0;
  if (size < 1024) return size + ' B';
  if (size < 1024 * 1024) return (size / 1024).toFixed(size < 10 * 1024 ? 1 : 0) + ' KB';
  return (size / 1024 / 1024).toFixed(1) + ' MB';
}
export function formatDuration(ms) {
  const value = Number(ms) || 0;
  if (value < 1000) return Math.max(0, Math.round(value)) + ' ms';
  if (value < 60000) return (value / 1000).toFixed(value < 10000 ? 1 : 0) + ' 秒';
  return Math.floor(value / 60000) + ' 分 ' + Math.round((value % 60000) / 1000) + ' 秒';
}
export function groupChats(chats) {
  const pinned = chats.filter(chat => chat.pinned);
  const rest = chats.filter(chat => !chat.pinned);
  const today = day(Date.now()), yesterday = today - 86400000, week = today - 6 * 86400000;
  const groups = [];
  if (pinned.length) groups.push({ key: 'pinned', label: '置顶', chats: pinned });
  const todayItems = [], yesterdayItems = [], weekItems = [], olderItems = [];
  for (const chat of rest) {
    const stamp = day(chat.updated);
    if (stamp >= today) todayItems.push(chat);
    else if (stamp >= yesterday) yesterdayItems.push(chat);
    else if (stamp >= week) weekItems.push(chat);
    else olderItems.push(chat);
  }
  if (todayItems.length) groups.push({ key: 'today', label: '今天', chats: todayItems });
  if (yesterdayItems.length) groups.push({ key: 'yesterday', label: '昨天', chats: yesterdayItems });
  if (weekItems.length) groups.push({ key: 'week', label: '最近 7 天', chats: weekItems });
  if (olderItems.length) groups.push({ key: 'older', label: '更早', chats: olderItems });
  return groups;
}
export function grantDate(seconds) {
  if (!seconds) return '';
  return new Date(seconds * 1000).toLocaleDateString('zh-CN');
}
export function normalizeWorkspacePath(value) {
  if (typeof value !== 'string') return '';
  const path = value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return path === '.' || path === './' ? '' : path;
}
export function workspaceReference(path) {
  const relative = normalizeWorkspacePath(String(path || '').replace(/^\/workspace\/?/, ''));
  if (!relative) return '';
  return "'/workspace/" + relative.replace(/'/g, "'\\''") + "'";
}

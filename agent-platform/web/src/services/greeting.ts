import { get } from './api';

// A short, length-bounded welcome greeting. The agent generates one periodically
// (/api/greeting); we cache it for a few hours and fall back to a rotating local set.
const FALLBACKS = [
  '我是 Iris，交给我吧',
  '今天想做点什么？',
  '把任务交给我，开始吧',
  '准备好了，说说你的想法',
  '需要我做什么？',
  '一起把它完成吧',
];
const MAX_LEN = 16;
const KEY = 'iris-greeting';
const TTL = 3 * 3600 * 1000; // refresh at most every 3 hours

function clamp(text: string): string {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > MAX_LEN ? t.slice(0, MAX_LEN) : t;
}

export async function loadGreeting(): Promise<string> {
  let cached: { text: string; at: number } | null = null;
  try { cached = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {}
  if (cached && cached.text && Date.now() - cached.at < TTL) return cached.text;
  try {
    const r = await get('/api/greeting');
    const text = clamp(r?.text);
    if (text) { try { localStorage.setItem(KEY, JSON.stringify({ text, at: Date.now() })); } catch {} return text; }
  } catch { /* fall through to local rotation */ }
  const pick = FALLBACKS[Math.floor(Date.now() / TTL) % FALLBACKS.length];
  return pick;
}

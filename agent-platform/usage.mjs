import { readdir, readFile, stat } from 'node:fs/promises';
import { loadProviders, modelLimits } from './providers.mjs';

// Token and cost totals read straight from Pi session files, so viewing usage
// never starts a model process. Parsed files are cached by size and mtime.
const cache = new Map();
const MAX_FILES = 400;

function priced(provider, model, usage) {
  const reported = Number(usage?.cost?.total) || 0;
  if (reported > 0 || !provider) return reported;
  const p = modelLimits(provider, model);
  if (p.input == null || p.output == null) return 0;
  return ((usage.input || 0) * p.input + (usage.output || 0) * p.output + (usage.cacheRead || 0) * (p.cacheRead ?? 0) + (usage.cacheWrite || 0) * (p.cacheWrite ?? 0)) / 1e6;
}

async function fileUsage(path, providers) {
  const info = await stat(path);
  const key = path + ':' + info.size + ':' + info.mtimeMs;
  if (cache.has(key)) return cache.get(key);
  const rows = [];
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    if (!line.includes('"usage"')) continue;
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    const m = entry.message;
    if (entry.type !== 'message' || m?.role !== 'assistant' || !m.usage) continue;
    const provider = providers.find(p => p.id === m.provider);
    rows.push({ day: String(entry.timestamp || '').slice(0, 10), model: (m.provider || '?') + '/' + (m.model || '?'), input: m.usage.input || 0, output: m.usage.output || 0, cacheRead: m.usage.cacheRead || 0, cacheWrite: m.usage.cacheWrite || 0, cost: priced(provider, m.model, m.usage) });
  }
  for (const k of cache.keys()) if (k.startsWith(path + ':')) cache.delete(k);
  cache.set(key, rows);
  return rows;
}

export async function usageSummary(user, titles = {}, days = 30, root = '/data/sessions') {
  const dir = `${root}/${user}`;
  const providers = (await loadProviders()).providers;
  let names = [];
  try { names = (await readdir(dir)).filter(n => n.endsWith('.jsonl')); } catch {}
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 };
  const byDay = {}, byModel = {}, byChat = {};
  const add = (bucket, row) => { bucket.input += row.input; bucket.output += row.output; bucket.cacheRead += row.cacheRead; bucket.cacheWrite += row.cacheWrite; bucket.cost += row.cost; bucket.calls++; };
  const blank = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 });
  for (const name of names.slice(0, MAX_FILES)) {
    const thread = name.slice(0, -6);
    let rows; try { rows = await fileUsage(`${dir}/${name}`, providers); } catch { continue; }
    for (const row of rows) {
      if (row.day < since) continue;
      add(total, row);
      add(byDay[row.day] ||= blank(), row);
      add(byModel[row.model] ||= blank(), row);
      add(byChat[thread] ||= { ...blank(), title: titles[thread] || '对话 ' + thread.slice(0, 8) }, row);
    }
  }
  const sortCost = obj => Object.entries(obj).map(([key, v]) => ({ key, ...v })).sort((a, b) => b.cost - a.cost || (b.input + b.output) - (a.input + a.output));
  return { days, since, total, byDay: Object.entries(byDay).map(([day, v]) => ({ day, ...v })).sort((a, b) => a.day.localeCompare(b.day)), byModel: sortCost(byModel), byChat: sortCost(byChat).slice(0, 20) };
}

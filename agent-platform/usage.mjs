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

function contentChars(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let sum = 0;
  for (const part of content) {
    if (!part) continue;
    if (typeof part.text === 'string') sum += part.text.length;
    else if (typeof part.thinking === 'string') sum += part.thinking.length;
    else if (part.type === 'toolCall' && part.arguments) sum += JSON.stringify(part.arguments).length;
  }
  return sum;
}

export async function sessionUsageStats(user, thread, root = '/data/sessions') {
  const providersData = await loadProviders();
  const providers = providersData.providers || [];
  const activeProv = providers.find(p => p.id === providersData.active) || providers[0];
  const defaultLimits = activeProv ? modelLimits(activeProv, activeProv.model || '') : { contextWindow: 128000, maxTokens: 16384 };

  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let cost = 0;
  let totalMessages = 0;
  let userMessages = 0;
  let assistantCalls = 0;
  let toolCalls = 0;
  let compactions = 0;

  let lastContextTokens = 0;
  let lastBreakdown = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let lastModelLimits = defaultLimits;
  let branchTextChars = 0;
  let historyChars = 0;
  const entryOffsets = new Map();
  let userTextChars = 0;
  let assistantTextChars = 0;
  let prevEntryTs = 0;

  let totalGenMs = 0;
  let timedOutputTokens = 0;
  let lastTokensPerSec = 0;
  let peakTokensPerSec = 0;

  const path = `${root}/${user}/${thread}.jsonl`;
  let raw = '';
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    const cw = defaultLimits.contextWindow || 128000;
    const autoCompactAt = Math.round(cw * 0.85);
    return {
      tokens,
      cost: 0,
      cacheHitRate: 0,
      totalMessages: 0,
      userMessages: 0,
      assistantCalls: 0,
      toolCalls: 0,
      compactions: 0,
      speed: { avgTokensPerSec: 0, lastTokensPerSec: 0, peakTokensPerSec: 0, totalOutputTokens: 0, totalGenMs: 0 },
      contextUsage: {
        tokens: 0,
        contextWindow: cw,
        percent: 0,
        autoCompactThreshold: autoCompactAt,
        remainingUntilCompact: autoCompactAt,
        breakdown: lastBreakdown,
      },
    };
  }

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const entryTs = entry.timestamp ? Date.parse(entry.timestamp) : (entry.message?.timestamp ? Number(entry.message.timestamp) : 0);

    if (entry.id) entryOffsets.set(entry.id, historyChars);
    if (entry.type === 'compaction') {
      compactions++;
      const keptOffset = entryOffsets.get(entry.firstKeptEntryId);
      const keptChars = keptOffset == null ? 0 : historyChars - keptOffset;
      branchTextChars = String(entry.summary || '').length + keptChars;
      const after = Number(entry.tokensAfter || entry.estimatedTokensAfter) || Math.ceil(branchTextChars / 3.5);
      if (after > 0) {
        lastContextTokens = after;
        lastBreakdown = { input: after, cacheRead: 0, cacheWrite: 0, output: 0 };
      }
      if (entryTs > 0) prevEntryTs = entryTs;
      continue;
    }

    if (entry.type === 'message' && entry.message) {
      totalMessages++;
      const m = entry.message;
      const chars = contentChars(m.content);
      branchTextChars += chars;
      historyChars += chars;
      if (Array.isArray(m.content)) {
        for (const p of m.content) if (p?.type === 'toolCall') toolCalls++;
      }
      if (m.role === 'user') {
        userMessages++;
        userTextChars += chars;
      } else if (m.role === 'assistant') {
        assistantCalls++;
        assistantTextChars += chars;
        const provider = providers.find(p => p.id === m.provider) || activeProv;
        if (provider) lastModelLimits = modelLimits(provider, m.model || provider.model || '');
        if (m.usage) {
          const inp = Number(m.usage.input) || 0;
          const out = Number(m.usage.output) || 0;
          const cr = Number(m.usage.cacheRead) || 0;
          const cw = Number(m.usage.cacheWrite) || 0;
          const tot = Number(m.usage.totalTokens) || (inp + out + cr + cw);
          tokens.input += inp;
          tokens.output += out;
          tokens.cacheRead += cr;
          tokens.cacheWrite += cw;
          tokens.total += tot;
          cost += priced(provider, m.model, m.usage);
          const ctx = inp + cr + cw + out;
          if (ctx > 1) {
            lastContextTokens = ctx;
            lastBreakdown = { input: inp, cacheRead: cr, cacheWrite: cw, output: out };
          }
          const durMs = Number(m.durationMs) || (prevEntryTs > 0 && entryTs > prevEntryTs && (entryTs - prevEntryTs) < 600000 ? (entryTs - prevEntryTs) : 0);
          if (out > 0 && durMs >= 100) {
            const rate = out / (durMs / 1000);
            if (rate > 0 && rate < 2500) {
              totalGenMs += durMs;
              timedOutputTokens += out;
              lastTokensPerSec = Number(rate.toFixed(1));
              if (lastTokensPerSec > peakTokensPerSec) peakTokensPerSec = lastTokensPerSec;
            }
          }
        }
      }
      if (entryTs > 0) prevEntryTs = entryTs;
    }
  }

  if (lastContextTokens <= 1 && branchTextChars > 0) {
    const estIn = Math.max(1, Math.ceil((userTextChars || branchTextChars * 0.4) / 3.5));
    const estOut = Math.max(0, Math.ceil(assistantTextChars / 3.5));
    lastContextTokens = estIn + estOut;
    if (tokens.total === 0) {
      tokens.input = estIn;
      tokens.output = estOut;
      tokens.total = lastContextTokens;
    }
    lastBreakdown = { input: estIn, cacheRead: 0, cacheWrite: 0, output: estOut };
  }

  const contextWindow = lastModelLimits.contextWindow || 128000;
  const percent = Math.min(100, Number(((lastContextTokens / contextWindow) * 100).toFixed(1)));
  const autoCompactThreshold = Math.round(contextWindow * 0.85);
  const remainingUntilCompact = Math.max(0, autoCompactThreshold - lastContextTokens);
  const avgTokensPerSec = totalGenMs > 0 ? Number((timedOutputTokens / (totalGenMs / 1000)).toFixed(1)) : lastTokensPerSec;
  const promptTotal = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  const cacheHitRate = promptTotal > 0 ? Number(((tokens.cacheRead / promptTotal) * 100).toFixed(1)) : 0;

  return {
    tokens,
    cost,
    cacheHitRate,
    totalMessages,
    userMessages,
    assistantCalls,
    toolCalls,
    compactions,
    speed: {
      avgTokensPerSec,
      lastTokensPerSec,
      peakTokensPerSec,
      totalOutputTokens: tokens.output,
      totalGenMs,
    },
    contextUsage: {
      tokens: lastContextTokens,
      contextWindow,
      percent,
      autoCompactThreshold,
      remainingUntilCompact,
      breakdown: lastBreakdown,
    },
  };
}

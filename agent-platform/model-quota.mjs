import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { fail } from './shared.mjs';
import { loadProviders, normalizeQuotaOverride, quotaOf, saveSharedQuota } from './providers.mjs';

const root = process.env.PROVIDER_DATA_DIR || '/data';
const quotaFile = root + '/model-quotas.json';
const locks = new Map();

export function shanghaiDay(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function usageTokens(usage) {
  return ['input', 'output', 'cacheRead', 'cacheWrite'].reduce((sum, key) => sum + (Number(usage?.[key]) || 0), 0);
}

function withLock(user, task) {
  const previous = locks.get(user) || Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  locks.set(user, run);
  return run.finally(() => { if (locks.get(user) === run) locks.delete(user); });
}

async function writeJson(path, value) {
  await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true, mode: 0o700 });
  await writeFile(path + '.pending', JSON.stringify(value), { mode: 0o600 });
  await rename(path + '.pending', path);
}

async function readOverrides() {
  try { return JSON.parse(await readFile(quotaFile, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

async function readUsage(user) {
  try { return JSON.parse(await readFile(root + '/model-usage/' + user + '.json', 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { days: {} }; throw error; }
}

export async function effectiveLimits(user) {
  const defaults = quotaOf(await loadProviders());
  const own = (await readOverrides())[user] || {};
  return {
    daily_requests: own.daily_requests ?? defaults.daily_requests,
    daily_tokens: own.daily_tokens ?? defaults.daily_tokens,
  };
}

export async function usageFor(user, now = new Date()) {
  const day = shanghaiDay(now);
  const bucket = (await readUsage(user)).days?.[day];
  return { requests: bucket?.requests || 0, tokens: bucket?.tokens || 0 };
}

export function quotaStatus(limits, used) {
  if (limits.daily_requests > 0 && used.requests >= limits.daily_requests) return 'requests';
  if (limits.daily_tokens > 0 && used.tokens >= limits.daily_tokens) return 'tokens';
  return null;
}

export function quotaError(kind) {
  return kind === 'requests' ? '今日共享模型请求次数已用完' : '今日共享模型 token 已用完';
}

export async function assertSharedQuota(user, now = new Date()) {
  const limits = await effectiveLimits(user);
  const kind = quotaStatus(limits, await usageFor(user, now));
  if (kind) fail(429, quotaError(kind));
}

export async function recordSharedUsage(user, usage, now = new Date()) {
  return withLock(user, async () => {
    const limits = await effectiveLimits(user);
    const day = shanghaiDay(now);
    const data = await readUsage(user);
    data.days ||= {};
    const bucket = data.days[day] ||= { requests: 0, tokens: 0 };
    bucket.requests += 1;
    bucket.tokens += usageTokens(usage);
    const cutoff = shanghaiDay(new Date(now.getTime() - 40 * 864e5));
    for (const key of Object.keys(data.days)) if (key < cutoff) delete data.days[key];
    await writeJson(root + '/model-usage/' + user + '.json', data);
    return { exceeded: quotaStatus(limits, bucket), used: { ...bucket }, limits };
  });
}

export async function modelQuotaView(user, now = new Date()) {
  const defaults = quotaOf(await loadProviders());
  const own = (await readOverrides())[user] || {};
  return {
    defaults,
    override: {
      daily_requests: own.daily_requests ?? null,
      daily_tokens: own.daily_tokens ?? null,
    },
    limits: await effectiveLimits(user),
    used: await usageFor(user, now),
  };
}

export async function saveModelQuota(user, input, now = new Date()) {
  const override = normalizeQuotaOverride(input);
  const all = await readOverrides();
  if (override.daily_requests == null && override.daily_tokens == null) delete all[user];
  else all[user] = override;
  await writeJson(quotaFile, all);
  return modelQuotaView(user, now);
}

export async function saveDefaultModelQuota(input) {
  return saveSharedQuota(input);
}

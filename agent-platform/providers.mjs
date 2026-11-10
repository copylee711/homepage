import { readFile, writeFile, rename, mkdir, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { fail } from './shared.mjs';

export const presets = [
  { id: 'opencode-go', name: 'OpenCode Go', baseUrl: 'https://opencode.ai/inference/go/openai/v1', api: 'openai-completions', model: 'deepseek-v4.1-flash', proxy: false, reasoning: true },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', api: 'openai-responses', model: '', proxy: true, reasoning: true },
  { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', api: 'anthropic-messages', model: '', proxy: true, reasoning: true },
  { id: 'google', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', api: 'google-generative-ai', model: '', proxy: true, reasoning: true },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', api: 'openai-completions', model: 'deepseek-chat', proxy: false, reasoning: true },
];
const root = process.env.PROVIDER_DATA_DIR || '/data';
const file = root + '/providers.json';
const personalDir = root + '/personal-providers';
const choiceDir = root + '/model-choice';
const validApis = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'];
const modelIdPattern = /^[A-Za-z0-9_.:/-]{1,160}$/;

function forbiddenHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  const ver = isIP(host);
  if (ver === 4) {
    const [a, b] = host.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || a >= 224) return true;
  } else if (ver === 6) {
    return true;
  }
  return false;
}

function validateBaseUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { fail(422, 'API 地址格式不正确'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port || forbiddenHost(url.hostname)) {
    fail(422, 'API 地址须为公网 HTTPS，不能包含账号、查询参数、自定义端口或内网地址');
  }
  return url.href.replace(/\/$/, '');
}

// Pi gives a custom model 16384 output tokens unless told otherwise, and reasoning
// shares that allowance with the answer. A long think could use all of it and end with
// stopReason "length" and no reply. Use the limits from Pi's own catalog for models we
// know, fall back to the model family, and let the provider or a per-model setting
// override them (contextWindow / maxTokens).
export const DEFAULT_MODEL_LIMITS = Object.freeze({ contextWindow: 128000, maxTokens: 16384 });
const KNOWN_MODEL_LIMITS = [
  // Pi 1.4.0 catalog: opencode / opencode-go deepseek-v4.x
  { host: /(^|\.)opencode\.ai$/, model: /^deepseek-v4/, contextWindow: 1000000, maxTokens: 384000 },
];
// Family fallback for endpoints Pi's catalog does not list (official DeepSeek,
// OpenAI-compatible gateways, Claude proxies).
const FAMILY_LIMITS = [
  [/claude-(opus|sonnet|fable)/i, { contextWindow: 200000, maxTokens: 64000 }],
  [/claude-haiku/i, { contextWindow: 200000, maxTokens: 32000 }],
  [/gpt-5|gpt-6|o3|o4/i, { contextWindow: 400000, maxTokens: 128000 }],
  [/gemini-(2\.5|3)/i, { contextWindow: 1000000, maxTokens: 65536 }],
  [/deepseek/i, { contextWindow: 128000, maxTokens: 32768 }],
];
export function modelLimits(provider, model) {
  let host = '';
  try { host = new URL(provider.baseUrl).hostname; } catch { /* invalid URLs are rejected on save */ }
  const known = KNOWN_MODEL_LIMITS.find(item => item.host.test(host) && item.model.test(model))
    || FAMILY_LIMITS.find(([pattern]) => pattern.test(model))?.[1] || DEFAULT_MODEL_LIMITS;
  let contextWindow = known.contextWindow, maxTokens = known.maxTokens;
  if (Number.isInteger(provider.contextWindow)) contextWindow = provider.contextWindow;
  if (Number.isInteger(provider.maxTokens)) maxTokens = provider.maxTokens;
  const own = Object.fromEntries(Object.entries(provider.modelSettings?.[model] || {}).filter(([, value]) => value != null));
  if (Number.isInteger(own.contextWindow)) contextWindow = own.contextWindow;
  if (Number.isInteger(own.maxTokens)) maxTokens = own.maxTokens;
  const price = {};
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) if (own[key] != null) price[key] = own[key];
  return { contextWindow, maxTokens: Math.min(maxTokens, contextWindow), ...price };
}
function optionalLimit(value, min, max, message) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) fail(422, message);
  return number;
}

function assertUser(user) {
  if (typeof user !== 'string' || !/^[a-f0-9]{64}$/.test(user)) fail(422, '用户标识无效');
  return user;
}
function personalPath(user) { return personalDir + '/' + user + '.json'; }
function choicePath(user) { return choiceDir + '/' + user + '.json'; }
async function writeJson(path, value) {
  await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true, mode: 0o700 });
  await writeFile(path + '.pending', JSON.stringify(value), { mode: 0o600 });
  await rename(path + '.pending', path);
}
export function quotaOf(config) {
  const raw = config?.quota || {};
  const number = key => Number.isInteger(raw[key]) && raw[key] >= 0 && raw[key] <= 1000000000 ? raw[key] : 0;
  return { daily_requests: number('daily_requests'), daily_tokens: number('daily_tokens') };
}
export function normalizeDailyQuota(input) {
  if (!input || typeof input !== 'object') fail(422, '请填写每日限额');
  const quota = {};
  for (const [key, label] of [['daily_requests', '每日请求数'], ['daily_tokens', '每日 token']]) {
    const number = Number(input[key] ?? 0);
    if (!Number.isInteger(number) || number < 0 || number > 1000000000) fail(422, `${label}需为 0–1000000000 的整数，0 表示不限制`);
    quota[key] = number;
  }
  return quota;
}
export function normalizeQuotaOverride(input) {
  if (!input || typeof input !== 'object') fail(422, '请填写模型限额');
  const quota = {};
  for (const [key, label] of [['daily_requests', '每日请求数'], ['daily_tokens', '每日 token']]) {
    if (input[key] == null || input[key] === '') { quota[key] = null; continue; }
    const number = Number(input[key]);
    if (!Number.isInteger(number) || number < 0 || number > 1000000000) fail(422, `${label}需为 0–1000000000 的整数，留空表示沿用默认`);
    quota[key] = number;
  }
  return quota;
}
function modelList(provider) {
  return Array.isArray(provider?.models) && provider.models.length ? provider.models : (provider?.model ? [provider.model] : []);
}
function present(value, shared = false) {
  const { apiKey, ...rest } = value;
  const models = modelList(value);
  return {
    ...rest,
    models,
    shared,
    hasKey: !!providerKey({ ...value, apiKey }),
    limits: Object.fromEntries(models.filter(Boolean).map(id => [id, modelLimits(value, id)])),
  };
}
export async function loadProviders() {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { active: 'opencode-go', providers: [{ ...presets[0], apiKey: '' }], quota: { daily_requests: 0, daily_tokens: 0 } };
  }
}
export async function loadPersonal(user) {
  try { return JSON.parse(await readFile(personalPath(user), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { providers: [] };
  }
}
async function loadChoice(user) {
  try { return JSON.parse(await readFile(choicePath(user), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}
async function personalIds() {
  let names = [];
  try { names = await readdir(personalDir); }
  catch (error) { if (error.code === 'ENOENT') return new Set(); throw error; }
  const ids = new Set();
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    try {
      const data = JSON.parse(await readFile(personalDir + '/' + name, 'utf8'));
      for (const item of data.providers || []) if (item?.id) ids.add(item.id);
    } catch { /* A damaged personal file must not block the shared catalog. */ }
  }
  return ids;
}
function locate(shared, personal, id) {
  const fromShared = shared.providers.find(item => item.id === id);
  if (fromShared) return { provider: fromShared, shared: true };
  const fromPersonal = personal.providers.find(item => item.id === id);
  if (fromPersonal) return { provider: fromPersonal, shared: false };
  return null;
}
export function providerKey(value) {
  return value.apiKey || (value.id === 'opencode-go' && value.baseUrl === presets[0].baseUrl ? process.env.OPENCODE_API_KEY : '');
}
export async function providersFor(user) {
  const shared = await loadProviders();
  if (!user) return shared.providers;
  const personal = await loadPersonal(assertUser(user));
  return [...shared.providers, ...personal.providers];
}
export async function isSharedProvider(id) {
  return (await loadProviders()).providers.some(item => item.id === id);
}
export async function hasModelChoice(user) {
  return !!(await loadChoice(assertUser(user)));
}
export async function publicProviders(user) {
  const config = await loadProviders();
  const shared = config.providers.map(item => present(item, true));
  const quota = quotaOf(config);
  if (!user) {
    return {
      active: config.active,
      activeModel: config.activeModel || config.providers.find(item => item.id === config.active)?.model || '',
      presets,
      providers: shared,
      shared,
      quota,
    };
  }
  const id = assertUser(user);
  const personal = await loadPersonal(id);
  const resolved = await activeProvider(id);
  return {
    active: resolved?.id || config.active,
    activeModel: resolved?.model || '',
    presets,
    providers: personal.providers.map(item => present(item, false)),
    shared,
    quota,
  };
}
export async function normalizeProvider(input, existing) {
  if (!input || !/^[a-z][a-z0-9-]{0,39}$/.test(input.id || '')) fail(422, '供应商标识需为 1–40 位小写字母、数字或短横线');
  if (!validApis.includes(input.api)) fail(422, '请选择支持的 API 协议');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 60) fail(422, '请填写供应商名称（最多 60 字符）');
  const candidateModels = [];
  if (typeof input.model === 'string' && input.model.trim()) {
    const primary = input.model.trim();
    if (!modelIdPattern.test(primary)) fail(422, '请填写有效的模型 ID');
    candidateModels.push(primary);
  }
  if (Array.isArray(input.models)) {
    for (const raw of input.models) {
      if (typeof raw !== 'string') continue;
      const m = raw.trim();
      if (!m) continue;
      if (!modelIdPattern.test(m)) fail(422, `模型 ID 格式无效：${m.slice(0, 40)}`);
      if (!candidateModels.includes(m)) candidateModels.push(m);
    }
  }
  if (!candidateModels.length) fail(422, '请至少添加或勾选一个模型 ID');
  if (candidateModels.length > 80) fail(422, '单个供应商最多启用 80 个模型');
  const primaryModel = candidateModels[0];
  const baseUrl = validateBaseUrl(input.baseUrl);
  const list = Array.isArray(existing) ? existing : (await loadProviders()).providers;
  const old = list.find(value => value.id === input.id);
  if (old && old.baseUrl !== baseUrl && !input.apiKey) fail(422, '修改 API 地址时，请重新填写密钥');
  const apiKey = input.apiKey || old?.apiKey || '';
  if (typeof apiKey !== 'string' || apiKey.length > 1024 || /[\r\n]/.test(apiKey) || /^[!$]/.test(apiKey)) fail(422, '密钥格式无效');
  const value = {
    id: input.id,
    name: input.name.trim(),
    baseUrl,
    api: input.api,
    model: primaryModel,
    models: candidateModels,
    proxy: input.proxy === true,
    reasoning: input.reasoning === true,
    apiKey,
  };
  value.modelSettings = normalizeModelSettings(input.modelSettings, candidateModels);
  const maxTokens = optionalLimit(input.maxTokens, 256, 2000000, '最大输出 token 需为 256–2000000 的整数');
  const contextWindow = optionalLimit(input.contextWindow, 1024, 10000000, '上下文窗口需为 1024–10000000 的整数');
  if (maxTokens !== undefined) value.maxTokens = maxTokens;
  if (contextWindow !== undefined) value.contextWindow = contextWindow;
  if (!providerKey(value)) fail(422, '请先填写 API 密钥');
  return value;
}

const settingRanges = { contextWindow: [4096, 4000000], maxTokens: [256, 1000000], input: [0, 1000], output: [0, 1000], cacheRead: [0, 1000], cacheWrite: [0, 1000] };
function normalizeModelSettings(raw, models) {
  const result = {};
  if (!raw || typeof raw !== 'object') return result;
  for (const id of models) {
    const item = raw[id];
    if (!item || typeof item !== 'object') continue;
    const clean = {};
    for (const [key, [min, max]] of Object.entries(settingRanges)) {
      if (item[key] === '' || item[key] == null) continue;
      const value = Number(item[key]);
      if (!Number.isFinite(value) || value < min || value > max) fail(422, `${id} 的 ${key} 超出允许范围（${min}–${max}）`);
      clean[key] = key === 'contextWindow' || key === 'maxTokens' ? Math.round(value) : value;
    }
    if (Object.keys(clean).length) result[id] = clean;
  }
  return result;
}

export async function normalizeProbeInput(input, existing) {
  if (!input || !validApis.includes(input.api)) fail(422, '请选择支持的 API 协议');
  const baseUrl = validateBaseUrl(input.baseUrl);
  const id = typeof input.id === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(input.id) ? input.id : '';
  const list = Array.isArray(existing) ? existing : (await loadProviders()).providers;
  const old = id ? list.find(value => value.id === id) : undefined;
  if (old && old.baseUrl !== baseUrl && !input.apiKey) fail(422, '修改 API 地址时，请重新填写密钥后再探测模型');
  const apiKey = input.apiKey || old?.apiKey || '';
  if (typeof apiKey !== 'string' || apiKey.length > 1024 || /[\r\n]/.test(apiKey) || /^[!$]/.test(apiKey)) fail(422, '密钥格式无效');
  const resolved = providerKey({ id, baseUrl, apiKey });
  if (!resolved) fail(422, '请先填写 API 密钥后再探测模型');
  return { id, api: input.api, baseUrl, proxy: input.proxy === true, apiKey: resolved };
}

async function persistShared(config) {
  if (!config.quota) config.quota = quotaOf(config);
  await writeJson(file, config);
  await syncModelsJson(config);
}
export async function saveProvider(input) {
  const value = await normalizeProvider(input), config = await loadProviders();
  if (!config.providers.some(item => item.id === value.id) && (await personalIds()).has(value.id)) {
    fail(422, '该标识已被用户的个人供应商使用');
  }
  const idx = config.providers.findIndex(item => item.id === value.id);
  if (idx >= 0) config.providers[idx] = value;
  else config.providers.push(value);
  if (config.active === value.id && !value.models.includes(config.activeModel)) config.activeModel = value.model;
  if (!config.providers.some(item => item.id === config.active)) {
    config.active = value.id;
    config.activeModel = value.model;
  }
  await persistShared(config);
  return publicProviders();
}
export async function saveSharedQuota(input) {
  const config = await loadProviders();
  config.quota = normalizeDailyQuota(input);
  await writeJson(file, config);
  return { quota: config.quota };
}

export async function deleteProvider(id) {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(id)) fail(422, '供应商标识无效');
  const config = await loadProviders();
  if (!config.providers.some(item => item.id === id)) fail(404, '供应商不存在');
  if (config.providers.length <= 1) fail(422, '至少需要保留一个已保存的供应商');
  config.providers = config.providers.filter(item => item.id !== id);
  if (config.active === id) {
    config.active = config.providers[0].id;
    config.activeModel = config.providers[0].model;
  }
  await persistShared(config);
  return publicProviders();
}

export async function savePersonalProvider(user, input) {
  const id = assertUser(user);
  const shared = await loadProviders();
  if (shared.providers.some(item => item.id === input?.id)) fail(422, '该标识已被共享供应商使用');
  const personal = await loadPersonal(id);
  const value = await normalizeProvider(input, personal.providers);
  const idx = personal.providers.findIndex(item => item.id === value.id);
  if (idx >= 0) personal.providers[idx] = value;
  else personal.providers.push(value);
  await writeJson(personalPath(id), personal);
  return publicProviders(id);
}
export async function deletePersonalProvider(user, providerId) {
  const id = assertUser(user);
  if (typeof providerId !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(providerId)) fail(422, '供应商标识无效');
  const personal = await loadPersonal(id);
  if (!personal.providers.some(item => item.id === providerId)) fail(404, '供应商不存在');
  personal.providers = personal.providers.filter(item => item.id !== providerId);
  await writeJson(personalPath(id), personal);
  const choice = await loadChoice(id);
  if (choice?.id === providerId) await rm(choicePath(id), { force: true });
  return publicProviders(id);
}

export async function activeProvider(user) {
  const config = await loadProviders();
  const personal = user ? await loadPersonal(assertUser(user)) : { providers: [] };
  const choice = user ? await loadChoice(user) : null;
  const wantedId = choice?.id || config.active;
  const found = locate(config, personal, wantedId) || locate(config, personal, config.active);
  if (!found) return undefined;
  const models = modelList(found.provider);
  const wanted = choice?.id === found.provider.id ? choice.model : config.activeModel;
  const model = wanted && models.includes(wanted) ? wanted : found.provider.model;
  return { ...found.provider, model, shared: found.shared };
}

export async function activateProvider({ id, model } = {}) {
  const config = await loadProviders();
  const provider = config.providers.find(item => item.id === id);
  if (!provider) fail(422, '供应商不存在');
  const models = modelList(provider);
  if (model != null && !models.includes(model)) fail(422, '该供应商未配置此模型');
  config.active = id;
  config.activeModel = model != null ? model : (models.includes(config.activeModel) ? config.activeModel : provider.model);
  await persistShared(config);
  return { active: config.active, activeModel: config.activeModel };
}
export async function activateUserModel(user, { id, model } = {}) {
  const uid = assertUser(user);
  const found = locate(await loadProviders(), await loadPersonal(uid), id);
  if (!found) fail(422, '供应商不存在');
  const models = modelList(found.provider);
  const chosen = model != null ? model : found.provider.model;
  if (!models.includes(chosen)) fail(422, '该供应商未配置此模型');
  await writeJson(choicePath(uid), { id, model: chosen });
  return { active: id, activeModel: chosen };
}

// Rewrite models.json from the saved providers, e.g. at startup so new limits apply.
export async function refreshModelsJson() {
  let config;
  try { config = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; } // built-in provider only
  if (config.providers?.length) await syncModelsJson(config);
}

async function syncModelsJson(config, dir = root + '/agent') {
  const providers = Object.fromEntries(config.providers.map(item => {
    const list = modelList(item);
    const chosen = item.id === config.active && list.includes(config.activeModel) ? config.activeModel : item.model;
    const ordered = [chosen, ...list.filter(m => m !== chosen)];
    return [item.id, {
      baseUrl: item.baseUrl, api: item.api, apiKey: item.apiKey || '$OPENCODE_API_KEY', authHeader: item.api.startsWith('openai-'),
      headers: { 'User-Agent': 'copylee-pi-agent/0.1.0' },
      models: ordered.map(id => {
        const { contextWindow, maxTokens, ...price } = modelLimits(item, id);
        const cost = ['input', 'output'].every(key => price[key] != null)
          ? { input: price.input, output: price.output, cacheRead: price.cacheRead ?? 0, cacheWrite: price.cacheWrite ?? 0 } : undefined;
        return { id, reasoning: item.reasoning === true, input: ['text', 'image'], contextWindow, maxTokens, ...(cost ? { cost } : {}) };
      }),
    }];
  }));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await syncAgentSettings(dir);
  await writeFile(dir + '/models.json.pending', JSON.stringify({ providers }), { mode: 0o600 });
  await rename(dir + '/models.json.pending', dir + '/models.json');
}
// Pi's agent-level retry covers overload, rate limits, 5xx and dropped streams.
export async function syncAgentSettings(dir = root + '/agent') {
  const path = dir + '/settings.json';
  let settings = {};
  try { settings = JSON.parse(await readFile(path, 'utf8')); } catch {}
  settings.retry = { enabled: true, maxRetries: 5, baseDelayMs: 2000, maxAgentDelayMs: 60000 };
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(path + '.pending', JSON.stringify(settings, null, 2), { mode: 0o600 });
  await rename(path + '.pending', path);
}
export async function syncProviderFiles() { await syncModelsJson(await loadProviders()); }
export async function writeUserAgentDir(user) {
  const id = assertUser(user);
  const shared = await loadProviders();
  const personal = await loadPersonal(id);
  const choice = await activeProvider(id);
  const dir = root + '/agent-users/' + id;
  await syncModelsJson({
    providers: [...shared.providers, ...personal.providers],
    active: choice?.id || shared.active,
    activeModel: choice?.model || shared.activeModel,
  }, dir);
  return dir;
}
export function proxyEnvironment(useProxy, source = process.env) {
  const env = { ...source };
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NODE_USE_ENV_PROXY']) delete env[name];
  if (useProxy) {
    env.HTTP_PROXY = env.HTTPS_PROXY = 'http://192.168.84.1:17890'; env.NODE_USE_ENV_PROXY = '1';
    env.NO_PROXY = 'localhost,127.0.0.1,runner,gateway';
  }
  return env;
}
function runProviderScript(scriptName, payload, useProxy, timeoutMs, fallbackDetail) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL(scriptName, import.meta.url))], { env: proxyEnvironment(useProxy), stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, models: [], detail: '连接超时，请检查 API 地址与代理线路', route: useProxy ? 'Mihomo' : '直连' }); }, timeoutMs);
    child.stdout.on('data', chunk => { if (output.length < 262144) output += chunk; });
    child.stderr.on('data', () => {});
    child.on('error', () => { clearTimeout(timer); reject(Object.assign(new Error('子进程无法启动'), { status: 503 })); });
    child.on('close', () => {
      clearTimeout(timer);
      try { resolve({ ...JSON.parse(output), route: useProxy ? 'Mihomo' : '直连' }); }
      catch { resolve({ ok: false, models: [], detail: fallbackDetail, route: useProxy ? 'Mihomo' : '直连' }); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}
export async function testProvider(input, existing) {
  const config = await normalizeProvider(input, existing);
  return runProviderScript('./provider-test.mjs', { ...config, apiKey: providerKey(config) }, config.proxy, 35000, '测试未完成，请检查代理服务');
}
export async function discoverProviderModels(input, existing) {
  const probe = await normalizeProbeInput(input, existing);
  return runProviderScript('./provider-models.mjs', probe, probe.proxy, 25000, '模型探测未完成，请检查代理服务');
}

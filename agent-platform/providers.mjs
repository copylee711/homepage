import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
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

export async function loadProviders() {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { active: 'opencode-go', providers: [{ ...presets[0], apiKey: '' }] };
  }
}
export function providerKey(value) {
  return value.apiKey || (value.id === 'opencode-go' && value.baseUrl === presets[0].baseUrl ? process.env.OPENCODE_API_KEY : '');
}
export async function publicProviders() {
  const config = await loadProviders();
  return {
    active: config.active,
    activeModel: config.activeModel || config.providers.find(p => p.id === config.active)?.model || '',
    presets,
    providers: config.providers.map(({ apiKey, ...value }) => ({
      ...value,
      models: Array.isArray(value.models) && value.models.length ? value.models : (value.model ? [value.model] : []),
      hasKey: !!providerKey({ ...value, apiKey }),
      limits: Object.fromEntries((Array.isArray(value.models) && value.models.length ? value.models : [value.model]).filter(Boolean).map(id => [id, modelLimits(value, id)])),
    })),
  };
}
export async function normalizeProvider(input) {
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
  const old = (await loadProviders()).providers.find(value => value.id === input.id);
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

export async function normalizeProbeInput(input) {
  if (!input || !validApis.includes(input.api)) fail(422, '请选择支持的 API 协议');
  const baseUrl = validateBaseUrl(input.baseUrl);
  const id = typeof input.id === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(input.id) ? input.id : '';
  const old = id ? (await loadProviders()).providers.find(value => value.id === id) : undefined;
  if (old && old.baseUrl !== baseUrl && !input.apiKey) fail(422, '修改 API 地址时，请重新填写密钥后再探测模型');
  const apiKey = input.apiKey || old?.apiKey || '';
  if (typeof apiKey !== 'string' || apiKey.length > 1024 || /[\r\n]/.test(apiKey) || /^[!$]/.test(apiKey)) fail(422, '密钥格式无效');
  const resolved = providerKey({ id, baseUrl, apiKey });
  if (!resolved) fail(422, '请先填写 API 密钥后再探测模型');
  return { id, api: input.api, baseUrl, proxy: input.proxy === true, apiKey: resolved };
}

export async function saveProvider(input) {
  const value = await normalizeProvider(input), config = await loadProviders();
  const idx = config.providers.findIndex(item => item.id === value.id);
  if (idx >= 0) config.providers[idx] = value;
  else config.providers.push(value);
  config.active = value.id;
  if (!config.activeModel || !value.models.includes(config.activeModel)) config.activeModel = value.model;
  await writeFile(file + '.pending', JSON.stringify(config), { mode: 0o600 });
  await rename(file + '.pending', file);
  await syncModelsJson(config);
  return publicProviders();
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
  await writeFile(file + '.pending', JSON.stringify(config), { mode: 0o600 });
  await rename(file + '.pending', file);
  await syncModelsJson(config);
  return publicProviders();
}

export async function activeProvider() {
  const config = await loadProviders();
  const provider = config.providers.find(item => item.id === config.active);
  if (!provider) return provider;
  const models = Array.isArray(provider.models) && provider.models.length ? provider.models : [provider.model];
  const model = config.activeModel && models.includes(config.activeModel) ? config.activeModel : provider.model;
  return { ...provider, model };
}

export async function activateProvider({ id, model } = {}) {
  const config = await loadProviders();
  const provider = config.providers.find(item => item.id === id);
  if (!provider) fail(422, '供应商不存在');
  const models = Array.isArray(provider.models) && provider.models.length ? provider.models : [provider.model];
  if (model != null && !models.includes(model)) fail(422, '该供应商未配置此模型');
  config.active = id;
  config.activeModel = model != null ? model : (models.includes(config.activeModel) ? config.activeModel : provider.model);
  await writeFile(file + '.pending', JSON.stringify(config), { mode: 0o600 });
  await rename(file + '.pending', file);
  await syncModelsJson(config);
  return { active: config.active, activeModel: config.activeModel };
}

// Rewrite models.json from the saved providers, e.g. at startup so new limits apply.
export async function refreshModelsJson() {
  let config;
  try { config = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; } // built-in provider only
  if (config.providers?.length) await syncModelsJson(config);
}

async function syncModelsJson(config) {
  const providers = Object.fromEntries(config.providers.map(item => {
    const list = Array.isArray(item.models) && item.models.length ? item.models : [item.model];
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
  await mkdir(root + '/agent', { recursive: true, mode: 0o700 });
  await syncAgentSettings();
  await writeFile(root + '/agent/models.json.pending', JSON.stringify({ providers }), { mode: 0o600 });
  await rename(root + '/agent/models.json.pending', root + '/agent/models.json');
}
// Pi's agent-level retry covers overload, rate limits, 5xx and dropped streams.
export async function syncAgentSettings() {
  const path = root + '/agent/settings.json';
  let settings = {};
  try { settings = JSON.parse(await readFile(path, 'utf8')); } catch {}
  settings.retry = { enabled: true, maxRetries: 5, baseDelayMs: 2000, maxAgentDelayMs: 60000 };
  await mkdir(root + '/agent', { recursive: true, mode: 0o700 });
  await writeFile(path + '.pending', JSON.stringify(settings, null, 2), { mode: 0o600 });
  await rename(path + '.pending', path);
}
export async function syncProviderFiles() { await syncModelsJson(await loadProviders()); }
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
export async function testProvider(input) {
  const config = await normalizeProvider(input);
  return runProviderScript('./provider-test.mjs', { ...config, apiKey: providerKey(config) }, config.proxy, 35000, '测试未完成，请检查代理服务');
}
export async function discoverProviderModels(input) {
  const probe = await normalizeProbeInput(input);
  return runProviderScript('./provider-models.mjs', probe, probe.proxy, 25000, '模型探测未完成，请检查代理服务');
}

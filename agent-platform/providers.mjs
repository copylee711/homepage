import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fail } from './shared.mjs';

export const presets = [
  { id: 'opencode-go', name: 'OpenCode Go', baseUrl: 'https://opencode.ai/inference/go/openai/v1', api: 'openai-completions', model: 'deepseek-v4.1-flash', proxy: false, reasoning: true },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', api: 'openai-responses', model: '', proxy: true },
  { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', api: 'anthropic-messages', model: '', proxy: true },
  { id: 'google', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', api: 'google-generative-ai', model: '', proxy: true },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', api: 'openai-completions', model: 'deepseek-flash', proxy: false, reasoning: true },
];
const root = process.env.PROVIDER_DATA_DIR || '/data';
const file = root + '/providers.json';
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
    })),
  };
}
export async function normalizeProvider(input) {
  if (!input || !/^[a-z][a-z0-9-]{0,39}$/.test(input.id || '')) fail(422, '供应商标识需为 1–40 位小写字母、数字或短横线');
  if (!['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'].includes(input.api)) fail(422, '请选择支持的 API 协议');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 60) fail(422, '请填写供应商名称（最多 60 字符）');
  if (typeof input.model !== 'string' || !/^[A-Za-z0-9_.:/-]{1,160}$/.test(input.model)) fail(422, '请填写有效的模型 ID');
  let url;
  try { url = new URL(input.baseUrl); } catch { fail(422, 'API 地址格式不正确'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port) fail(422, 'API 地址须为 HTTPS，不能包含账号、查询参数或自定义端口');
  const baseUrl = url.href.replace(/\/$/, '');
  const old = (await loadProviders()).providers.find(value => value.id === input.id);
  if (old && old.baseUrl !== baseUrl && !input.apiKey) fail(422, '修改 API 地址时，请重新填写密钥');
  const apiKey = input.apiKey || old?.apiKey || '';
  if (typeof apiKey !== 'string' || apiKey.length > 1024 || /[\r\n]/.test(apiKey) || /^[!$]/.test(apiKey)) fail(422, '密钥格式无效');
  // Optional extra models for quick-switch; each must be a valid id. The primary
  // `model` is always included first.
  let models = [input.model];
  if (Array.isArray(input.models)) {
    for (const m of input.models) {
      if (typeof m === 'string' && /^[A-Za-z0-9_.:/-]{1,160}$/.test(m) && !models.includes(m)) models.push(m);
    }
  }
  if (models.length > 24) fail(422, '模型数量过多');
  const value = { id: input.id, name: input.name.trim(), baseUrl, api: input.api, model: input.model, models, proxy: input.proxy === true, reasoning: input.reasoning === true, apiKey };
  if (!providerKey(value)) fail(422, '请先填写 API 密钥');
  return value;
}
export async function saveProvider(input) {
  const value = await normalizeProvider(input), config = await loadProviders();
  config.providers = [...config.providers.filter(item => item.id !== value.id), value];
  config.active = value.id;
  config.activeModel = value.model;
  await writeFile(file + '.pending', JSON.stringify(config), { mode: 0o600 });
  await rename(file + '.pending', file);
  await syncModelsJson(config);
  return publicProviders();
}
export async function activeProvider() {
  const config = await loadProviders();
  const provider = config.providers.find(item => item.id === config.active);
  if (!provider) return provider;
  // Honor a per-config active model chosen via quick-switch, if it is one this
  // provider declares; otherwise fall back to the provider's primary model.
  const models = Array.isArray(provider.models) && provider.models.length ? provider.models : [provider.model];
  const model = config.activeModel && models.includes(config.activeModel) ? config.activeModel : provider.model;
  return { ...provider, model };
}

// Quick-switch the active provider and/or model among already-saved configs.
// Does not touch keys; only flips which saved config and model Pi uses next.
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
  // Reflect the active model into models.json so Pi launches with it.
  await syncModelsJson(config);
  return { active: config.active, activeModel: config.activeModel };
}

// Write models.json from the saved providers, putting each config's chosen model first.
async function syncModelsJson(config) {
  const providers = Object.fromEntries(config.providers.map(item => {
    const list = Array.isArray(item.models) && item.models.length ? item.models : [item.model];
    const chosen = item.id === config.active && list.includes(config.activeModel) ? config.activeModel : item.model;
    const ordered = [chosen, ...list.filter(m => m !== chosen)];
    return [item.id, {
      baseUrl: item.baseUrl, api: item.api, apiKey: item.apiKey || '$OPENCODE_API_KEY', authHeader: item.api.startsWith('openai-'),
      headers: { 'User-Agent': 'copylee-pi-agent/0.1.0' },
      models: ordered.map(id => ({ id, reasoning: item.reasoning === true, input: ['text'], contextWindow: 128000, maxTokens: 16384 })),
    }];
  }));
  await mkdir(root + '/agent', { recursive: true, mode: 0o700 });
  await writeFile(root + '/agent/models.json.pending', JSON.stringify({ providers }), { mode: 0o600 });
  await rename(root + '/agent/models.json.pending', root + '/agent/models.json');
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
export async function testProvider(input) {
  const config = await normalizeProvider(input);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL('./provider-test.mjs', import.meta.url).pathname], { env: proxyEnvironment(config.proxy), stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, detail: '连接超时，请检查 API 地址、模型及代理线路', route: config.proxy ? 'Mihomo' : '直连' }); }, 35000);
    child.stdout.on('data', chunk => { if (output.length < 65536) output += chunk; }); child.stderr.on('data', () => {});
    child.on('error', () => { clearTimeout(timer); reject(Object.assign(new Error('测试进程无法启动'), { status: 503 })); });
    child.on('close', () => {
      clearTimeout(timer);
      try { resolve({ ...JSON.parse(output), route: config.proxy ? 'Mihomo' : '直连' }); }
      catch { resolve({ ok: false, detail: '测试未完成，请检查代理服务', route: config.proxy ? 'Mihomo' : '直连' }); }
    });
    child.stdin.end(JSON.stringify({ ...config, apiKey: providerKey(config) }));
  });
}

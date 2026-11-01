let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const config = JSON.parse(raw);

const headers = {
  Accept: 'application/json',
  'User-Agent': 'copylee-pi-agent/0.1.0',
};
if (config.api === 'anthropic-messages') {
  headers['x-api-key'] = config.apiKey;
  headers['anthropic-version'] = '2023-06-01';
} else if (config.api === 'google-generative-ai') {
  headers['x-goog-api-key'] = config.apiKey;
} else {
  headers.Authorization = 'Bearer ' + config.apiKey;
}

const candidatePaths = ['/models'];
if (config.api === 'anthropic-messages' && !/\/v\d+$/i.test(config.baseUrl)) candidatePaths.push('/v1/models');
if (config.api === 'google-generative-ai' && !/\/v\d+(?:beta)?$/i.test(config.baseUrl)) candidatePaths.push('/v1beta/models');

const idPattern = /^[A-Za-z0-9_.:/-]{1,160}$/;
const started = Date.now();

function extractModels(data, api) {
  if (!data || typeof data !== 'object') return [];
  const rawList = Array.isArray(data.data)
    ? data.data
    : Array.isArray(data.models)
      ? data.models
      : Array.isArray(data)
        ? data
        : [];
  const seen = new Set();
  const out = [];
  for (const item of rawList) {
    if (api === 'google-generative-ai' && item && typeof item === 'object' && Array.isArray(item.supportedGenerationMethods)) {
      if (!item.supportedGenerationMethods.includes('generateContent')) continue;
    }
    let id = typeof item === 'string' ? item : String(item?.id || item?.name || '');
    if (api === 'google-generative-ai') id = id.replace(/^models\//, '');
    id = id.trim();
    if (!idPattern.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= 300) break;
  }
  return out;
}

try {
  let lastStatus = 0;
  for (const suffix of candidatePaths) {
    const response = await fetch(config.baseUrl + suffix, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
    });
    lastStatus = response.status;
    if (response.status === 404 && suffix !== candidatePaths[candidatePaths.length - 1]) continue;
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      console.log(JSON.stringify({
        ok: false,
        status: response.status,
        latency: Date.now() - started,
        models: [],
        detail: `模型列表接口返回 HTTP ${response.status}，请检查地址、密钥或手动添加模型 ID`,
      }));
      process.exit(0);
    }
    const models = extractModels(data, config.api);
    console.log(JSON.stringify({
      ok: models.length > 0,
      status: response.status,
      latency: Date.now() - started,
      models,
      detail: models.length > 0 ? `探测到 ${models.length} 个可用模型` : '接口已响应但未返回可用模型列表，请手动输入模型 ID',
    }));
    process.exit(0);
  }
  console.log(JSON.stringify({
    ok: false,
    status: lastStatus || 404,
    latency: Date.now() - started,
    models: [],
    detail: '该端点不支持自动获取模型列表，请手动输入模型 ID',
  }));
} catch {
  console.log(JSON.stringify({
    ok: false,
    latency: Date.now() - started,
    models: [],
    detail: '网络连接失败或超时，请检查 API 地址与代理设置',
  }));
}

let raw = ''; for await (const chunk of process.stdin) raw += chunk;
const config = JSON.parse(raw), headers = { 'Content-Type': 'application/json', 'User-Agent': 'copylee-pi-agent/0.1.0', 'x-opencode-session': 'copylee-connection-test' };
let path, payload;
if (config.api === 'anthropic-messages') {
  headers['x-api-key'] = config.apiKey; headers['anthropic-version'] = '2023-06-01';
  path = '/messages'; payload = { model: config.model, max_tokens: 32, messages: [{ role: 'user', content: 'Reply with OK.' }] };
} else if (config.api === 'google-generative-ai') {
  headers['x-goog-api-key'] = config.apiKey;
  path = '/models/' + encodeURIComponent(config.model.replace(/^models\//, '')) + ':generateContent';
  payload = { contents: [{ parts: [{ text: 'Reply with OK.' }] }], generationConfig: { maxOutputTokens: 64 } };
} else {
  headers.Authorization = 'Bearer ' + config.apiKey;
  if (config.api === 'openai-responses') { path = '/responses'; payload = { model: config.model, input: 'Reply with OK.', max_output_tokens: 64 }; }
  else { path = '/chat/completions'; payload = { model: config.model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 64 }; }
}
const started = Date.now();
try {
  const response = await fetch(config.baseUrl + path, { method: 'POST', headers, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(30000) });
  const data = await response.json().catch(() => null);
  const valid = !!data && !data.error && (Array.isArray(data.choices) || Array.isArray(data.content) || Array.isArray(data.output) || Array.isArray(data.candidates));
  console.log(JSON.stringify({ ok: response.ok && valid, status: response.status, latency: Date.now() - started,
    detail: response.ok && valid ? '已通过认证并完成模型调用' : `接口返回 HTTP ${response.status}，请检查密钥、模型权限或 API 协议` }));
} catch { console.log(JSON.stringify({ ok: false, latency: Date.now() - started, detail: '网络连接失败或超时，请检查 API 地址和代理线路' })); }

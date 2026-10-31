import { timingSafeEqual, createHash } from 'node:crypto';

export function equal(a, b) {
  return timingSafeEqual(createHash('sha256').update(a || '').digest(), createHash('sha256').update(b || '').digest());
}
export function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
export async function body(req, limit = 65536) {
  let size = 0, chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('请求过大'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw Object.assign(new Error('请求格式错误'), { status: 400 }); }
}
// A provider-qualified model ID is shown without its provider route or credentials.
export function modelLabel(model) {
  if (typeof model !== 'string' || !model.trim()) return 'Pi 模型';
  const raw = model.split('/').pop().trim();
  const brands = { deepseek: 'DeepSeek', gpt: 'GPT', claude: 'Claude', gemini: 'Gemini', qwen: 'Qwen',
    kimi: 'Kimi', glm: 'GLM', llama: 'Llama', mistral: 'Mistral', grok: 'Grok', o: 'o' };
  return raw.split(/[-_]+/).filter(Boolean).map((part, index) => {
    const lower = part.toLowerCase();
    if (brands[lower]) return brands[lower];
    if (index === 0 && /^v\d/i.test(part)) return 'V' + part.slice(1);
    return part.charAt(0).toUpperCase() + part.slice(1);
  }).join(' ').slice(0, 80) || 'Pi 模型';
}
export function fail(status, message) { throw Object.assign(new Error(message), { status }); }
export function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing configuration: ${name}`);
  return value;
}

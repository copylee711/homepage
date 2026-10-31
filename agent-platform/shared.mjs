import { timingSafeEqual, createHash } from 'node:crypto';

export function equal(a, b) {
  return timingSafeEqual(createHash('sha256').update(a || '').digest(), createHash('sha256').update(b || '').digest());
}
export function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
export async function body(req) {
  let size = 0, chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw Object.assign(new Error('请求过大'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw Object.assign(new Error('请求格式错误'), { status: 400 }); }
}
export function fail(status, message) { throw Object.assign(new Error(message), { status }); }
export function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing configuration: ${name}`);
  return value;
}

import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { fail } from './shared.mjs';

const MiB = 1024 * 1024;
const outputLimit = 2 * MiB;
const mineru = 'https://mineru.net/api';
const paddle = 'https://paddleocr.aistudio-app.com/api/v2/ocr/jobs';

export function ocrSettings(secret, root = '/data/ocr') {
  const key = createHash('sha256').update('iris-ocr-settings-v1\0').update(secret).digest();
  const path = user => root + '/' + user + '.json';
  const writes = new Map();
  async function load(user) {
    let envelope;
    try { envelope = JSON.parse(await readFile(path(user), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return { online: false };
      throw error;
    }
    const decode = field => Buffer.from(envelope[field], 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, decode('iv'));
    decipher.setAAD(Buffer.from(user));
    decipher.setAuthTag(decode('tag'));
    return JSON.parse(Buffer.concat([decipher.update(decode('data')), decipher.final()]));
  }
  const status = value => ({ online: value.online, mineruConfigured: !!value.mineruKey, paddleConfigured: !!value.paddleKey });
  return {
    load,
    async status(user) { return status(await load(user)); },
    save(user, input) {
      const previous = writes.get(user) || Promise.resolve();
      const next = previous.catch(() => {}).then(() => save(user, input));
      writes.set(user, next);
      return next.finally(() => { if (writes.get(user) === next) writes.delete(user); });
    },
  };

  async function save(user, input) {
    if (typeof input.online !== 'boolean') fail(422, '请选择是否启用在线 OCR');
    const value = { ...await load(user), online: input.online };
    for (const name of ['mineruKey', 'paddleKey']) {
      if (!Object.hasOwn(input, name)) continue;
      if (typeof input[name] !== 'string' || !/^[\x21-\x7e]{0,2048}$/.test(input[name])) fail(422, 'OCR Token 格式无效');
      value[name] = input[name];
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(user));
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    const encoded = JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
    await mkdir(root, { recursive: true, mode: 0o700 });
    const temp = path(user) + '.' + randomUUID();
    try {
      await writeFile(temp, encoded, { mode: 0o600, flag: 'wx' });
      await rename(temp, path(user));
    } finally { await rm(temp, { force: true }); }
    return status(value);
  }
}

function storageURL(raw, provider) {
  const url = new URL(raw);
  const host = url.hostname;
  const allowed = provider === 'paddle'
    ? host === 'paddleocr.aistudio-app.com' || host.endsWith('.bcebos.com')
    : ['oss-mineru.openxlab.org.cn', 'cdn-mineru.openxlab.org.cn', 'mineru.oss-cn-shanghai.aliyuncs.com'].includes(host);
  if (!allowed || url.protocol !== 'https:' || url.port || url.username || url.password) throw new Error('OCR storage URL rejected');
  return url;
}

async function responseBytes(response, limit) {
  const chunks = [];
  let length = 0;
  if (!response.body) return Buffer.alloc(0);
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > limit) throw new Error('OCR response too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

function http(fetcher, signal) {
  return async (url, options = {}, limit = MiB) => {
    const response = await fetcher(url, { ...options, signal, redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('OCR request failed');
    }
    return responseBytes(response, limit);
  };
}

async function data(request, url, options) {
  const body = JSON.parse(await request(url, options));
  if ((body.code ?? 0) !== 0 || !body.data) throw new Error('OCR service rejected request');
  return body.data;
}

function post(value, headers) {
  return { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(value) };
}

async function poll(status, signal, delay) {
  for (;;) {
    const value = await status();
    if (value?.state === 'done') return value;
    if (!['pending', 'running', 'waiting-file', 'uploading', 'converting'].includes(value?.state)) throw new Error('OCR task failed');
    await wait(delay, undefined, { signal });
  }
}

function unpackMarkdown(bytes, signal) {
  // Read only full.md. Never extract paths or inflate the other ZIP entries.
  const script = [
    'import io, sys, zipfile',
    'with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:',
    '    entry = next(x for x in archive.infolist() if x.filename.split("/")[-1] == "full.md")',
    '    with archive.open(entry) as file: sys.stdout.buffer.write(file.read(2097153))',
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', script], { signal, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stdin.on('error', reject);
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks).toString('utf8')) : reject(new Error('OCR ZIP invalid')));
    child.stdin.end(bytes);
  });
}

async function parseOnline(provider, file, key, signal, fetcher, delay) {
  const request = http(fetcher, signal);
  const bytes = Buffer.from(file.data, 'base64');
  const filename = 'document.' + file.ext;
  const headers = key ? { Authorization: 'Bearer ' + key } : {};
  if (provider === 'paddle') {
    const form = new FormData();
    form.set('file', new Blob([bytes]), filename);
    form.set('model', 'PaddleOCR-VL-1.6');
    form.set('optionalPayload', JSON.stringify({ useTableRecognition: true, visualize: false }));
    const { jobId } = await data(request, paddle, { method: 'POST', headers, body: form });
    if (typeof jobId !== 'string' || !jobId) throw new Error('OCR job missing');
    const result = await poll(() => data(request, paddle + '/' + encodeURIComponent(jobId), { headers }), signal, delay);
    const jsonl = await request(storageURL(result.resultUrl?.jsonUrl, provider), {}, 16 * MiB);
    const pages = jsonl.toString('utf8').trim().split(/\r?\n/).flatMap(line => {
      const { result } = JSON.parse(line);
      return result.layoutParsingResults.map(page => page.markdown?.text || '');
    });
    if (pages.length !== file.count || !pages.some(page => page.trim())) throw new Error('OCR page count mismatch or empty result');
    return pages.map((page, i) => '## 第 ' + (file.start + i) + ' 页\n\n' + (page.trim() || '（未识别到文本）')).join('\n\n');
  }
  if (provider === 'mineru') {
    const batch = await data(request, mineru + '/v4/file-urls/batch', post({ files: [{ name: filename, is_ocr: true }], model_version: 'vlm' }, headers));
    if (typeof batch.batch_id !== 'string' || !batch.batch_id) throw new Error('OCR job missing');
    await request(storageURL(batch.file_urls?.[0], provider), { method: 'PUT', body: bytes });
    const result = await poll(async () => {
      const items = (await data(request, mineru + '/v4/extract-results/batch/' + encodeURIComponent(batch.batch_id), { headers })).extract_result;
      return items?.[0] || { state: 'pending' };
    }, signal, delay);
    return unpackMarkdown(await request(storageURL(result.full_zip_url, provider), {}, 64 * MiB), signal);
  }
  const agent = mineru + '/v1/agent/parse';
  const task = await data(request, agent + '/file', post({ file_name: filename, is_ocr: true, enable_table: true }));
  if (typeof task.task_id !== 'string' || !task.task_id) throw new Error('OCR job missing');
  await request(storageURL(task.file_url, provider), { method: 'PUT', body: bytes });
  const result = await poll(() => data(request, agent + '/' + encodeURIComponent(task.task_id)), signal, delay);
  return (await request(storageURL(result.markdown_url, provider), {}, outputLimit)).toString('utf8');
}

export async function recognizeDocument({ path, firstPage, lastPage, settings, run, signal, fetcher = fetch, pollDelay = 3000 }) {
  const info = await run('ocr-source', { path, mode: 'info' });
  const read = (mode, start, end) => run('ocr-source', { path, mode, start, end, revision: info.revision });
  async function prepare(mode, start, end) {
    try { return await read(mode, start, end); }
    catch {
      signal.throwIfAborted();
      return {};
    }
  }
  const start = firstPage ?? 1;
  const end = lastPage ?? info.pages;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > info.pages || end - start >= 200) {
    fail(422, '页码超出范围，单次最多识别 200 页');
  }
  const parts = [];
  const providers = new Set();
  const unavailable = new Set();
  const cloudBudget = AbortSignal.any([signal, AbortSignal.timeout(360000)]);
  async function online(provider, file, key) {
    try {
      const timeout = AbortSignal.any([cloudBudget, AbortSignal.timeout(120000)]);
      const markdown = await parseOnline(provider, file, key, timeout, fetcher, pollDelay);
      if (!markdown.trim() || Buffer.byteLength(markdown) > outputLimit) throw new Error('OCR output empty or too large');
      return markdown;
    } catch {
      signal.throwIfAborted();
      unavailable.add(provider);
      return '';
    }
  }
  const keyed = [['mineru', settings.mineruKey], ['paddle', settings.paddleKey]].filter(([, key]) => key);
  if (settings.online && keyed.length && (info.size <= 50 * MiB || start !== 1 || end !== info.pages)) {
    const file = await prepare('file', start, end);
    if (file.data) {
      for (const [provider, key] of keyed) {
        const markdown = await online(provider, file, key);
        if (markdown) return { markdown, providers: [provider], pages: [start, end] };
      }
    }
  }
  let total = 0;
  for (let page = start; page <= end;) {
    signal.throwIfAborted();
    let markdown = '';
    let last = Math.min(end, page + 3);
    if (settings.online && !cloudBudget.aborted && !unavailable.has('mineru-free')) {
      const file = await prepare('free', page, Math.min(end, page + 19));
      if (file.data) {
        markdown = await online('mineru-free', file);
        if (markdown) {
          last = page + file.count - 1;
          providers.add('mineru-free');
          markdown = '## 第 ' + page + (last === page ? '' : '–' + last) + ' 页\n\n' + markdown;
        }
      }
    }
    if (!markdown) {
      markdown = (await read('local', page, last)).markdown;
      providers.add('tesseract');
    }
    total += Buffer.byteLength(markdown);
    if (total > outputLimit) fail(422, 'OCR 结果超过 2 MiB，请缩小页码范围');
    parts.push(markdown);
    page = last + 1;
  }
  return { markdown: parts.join('\n\n'), providers: [...providers], pages: [start, end] };
}

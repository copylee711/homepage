import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ocrSettings, recognizeDocument } from '../ocr.mjs';

const path = '/workspace/default/scan.pdf';
const source = (start, count) => ({ data: 'c2Nhbg==', ext: 'pdf', start, count });
const options = { path, signal: new AbortController().signal, pollDelay: 0 };

test('OCR tokens are encrypted, never returned from settings, and scoped to the account', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-ocr-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = ocrSettings('test-secret', dir);
  const key = 'private-mineru-token';
  assert.deepEqual(await store.save('alice', { online: true, mineruKey: key }), {
    online: true, mineruConfigured: true, paddleConfigured: false,
  });
  assert.doesNotMatch(await readFile(join(dir, 'alice.json'), 'utf8'), /private-mineru-token/);
  assert.equal((await store.load('alice')).mineruKey, key);
  assert.deepEqual(await store.status('bob'), { online: false, mineruConfigured: false, paddleConfigured: false });
  await store.save('alice', { online: false, paddleKey: 'paddle-token' });
  assert.equal((await store.load('alice')).mineruKey, key);
  assert.equal((await store.save('alice', { online: false, mineruKey: '' })).mineruConfigured, false);
  await Promise.all([
    store.save('bob', { online: true, mineruKey: 'mineru-bob' }),
    store.save('bob', { online: true, paddleKey: 'paddle-bob' }),
  ]);
  assert.deepEqual(await store.load('bob'), { online: true, mineruKey: 'mineru-bob', paddleKey: 'paddle-bob' });
});

test('a rate-limited MinerU Token falls back to PaddleOCR and sends credentials only to the API', async () => {
  const calls = [];
  const result = await recognizeDocument({
    ...options, firstPage: 2, lastPage: 2,
    settings: { online: true, mineruKey: 'mineru-test', paddleKey: 'paddle-test' },
    run: async (op, request) => {
      assert.equal(op, 'ocr-source');
      if (request.mode === 'info') return { size: 41000000, pages: 45 };
      assert.equal(request.mode, 'file');
      assert.equal(request.start, 2);
      assert.equal(request.end, 2);
      return source(2, 1);
    },
    fetcher: async (url, request) => {
      const target = new URL(url);
      calls.push(target.host);
      assert.equal(request.redirect, 'error');
      if (target.host === 'mineru.net') {
        assert.equal(request.headers.Authorization, 'Bearer mineru-test');
        return new Response('', { status: 429 });
      }
      if (target.host === 'paddleocr.aistudio-app.com') {
        assert.equal(request.headers.Authorization, 'Bearer paddle-test');
        if (request.method === 'POST') {
          assert.equal(request.body.get('model'), 'PaddleOCR-VL-1.6');
          assert.equal(await request.body.get('file').text(), 'scan');
          return Response.json({ data: { jobId: 'one' } });
        }
        return Response.json({ data: { state: 'done', resultUrl: { jsonUrl: 'https://sample.bj.bcebos.com/result.jsonl' } } });
      }
      assert.equal(request.headers, undefined);
      return new Response(JSON.stringify({ result: { layoutParsingResults: [{ markdown: { text: '| 华南理工大学 | 一等奖 |' } }] } }));
    },
  });
  assert.deepEqual(calls, ['mineru.net', 'paddleocr.aistudio-app.com', 'paddleocr.aistudio-app.com', 'sample.bj.bcebos.com']);
  assert.deepEqual(result, { pages: [2, 2], providers: ['paddle'], markdown: '## 第 2 页\n\n| 华南理工大学 | 一等奖 |' });
});

test('free OCR respects actual split size and local fallback resumes at the first failed page', async () => {
  const local = [];
  let requests = 0;
  const result = await recognizeDocument({
    ...options, settings: { online: true },
    run: async (_op, request) => {
      if (request.mode === 'info') return { size: 41000000, pages: 45 };
      if (request.mode === 'free') {
        assert.equal(request.end - request.start, 19);
        return source(request.start, 10);
      }
      local.push([request.start, request.end]);
      return { markdown: 'local ' + request.start };
    },
    fetcher: async (url, request) => {
      const target = new URL(url);
      if (target.pathname.endsWith('/file')) {
        if (requests++) return new Response('', { status: 429 });
        return Response.json({ code: 0, data: { task_id: 'one', file_url: 'https://oss-mineru.openxlab.org.cn/upload' } });
      }
      if (request.method === 'PUT') return new Response(null);
      if (target.host === 'mineru.net') {
        return Response.json({ code: 0, data: { state: 'done', markdown_url: 'https://cdn-mineru.openxlab.org.cn/full.md' } });
      }
      return new Response('recognized table');
    },
  });
  assert.deepEqual(result.providers, ['mineru-free', 'tesseract']);
  assert.match(result.markdown, /^## 第 1–10 页\n\nrecognized table\n\nlocal 11/);
  assert.deepEqual(local.flatMap(([start, end]) => Array.from({ length: end - start + 1 }, (_, i) => start + i)),
    Array.from({ length: 35 }, (_, i) => i + 11));
  assert.equal(requests, 2);
});

test('disabled cloud never uploads and an unsafe signed URL falls through without a request', async () => {
  for (const online of [false, true]) {
    let requests = 0;
    const result = await recognizeDocument({
      ...options, settings: { online, mineruKey: 'saved-token' },
      run: async (_op, request) => request.mode === 'info' ? { size: 8000, pages: 1 }
        : request.mode === 'local' ? { markdown: 'local' } : source(1, 1),
      fetcher: async url => {
        assert.equal(new URL(url).hostname, 'mineru.net');
        requests++;
        return Response.json({ data: { batch_id: 'one', file_urls: ['https://127.0.0.1/'],
          task_id: 'one', file_url: 'https://127.0.0.1/' } });
      },
    });
    assert.deepEqual(result.providers, ['tesseract']);
    assert.equal(requests, online ? 2 : 0);
  }
});

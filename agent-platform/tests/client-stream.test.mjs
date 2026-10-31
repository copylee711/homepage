import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamPrompt } from '../web/js/stream.js';
import { safeHref } from '../web/js/markdown.js';

test('NDJSON streaming preserves split UTF-8 characters and final records without a newline', async () => {
  const original = globalThis.fetch;
  const events = [{ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '中文🙂' } }, { type: 'agent_settled', aborted: false }];
  const bytes = new TextEncoder().encode(events.map(event => JSON.stringify(event)).join('\r\n'));
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close();
  } }));
  try {
    const received = [];
    assert.deepEqual(await streamPrompt({ thread: 'test', message: 'test', onEvent: event => received.push(event) }), { settled: true });
    assert.deepEqual(received, events);
    globalThis.fetch = async () => new Response(JSON.stringify(events[0]) + '\n');
    assert.deepEqual(await streamPrompt({ thread: 'test', message: 'test', onEvent() {} }), { settled: false });
  } finally { globalThis.fetch = original; }
});
test('model-supplied Markdown links cannot invoke scripts, local files or credential-bearing URLs', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', '//evil.test', 'https://user:secret@example.test', 'java\nscript:alert(1)']) assert.equal(safeHref(url), null);
  assert.equal(safeHref('https://example.com/docs'), 'https://example.com/docs');
  assert.equal(safeHref('mailto:test@example.com'), 'mailto:test@example.com');
});

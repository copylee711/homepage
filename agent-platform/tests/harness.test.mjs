import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const directory = await mkdtemp(join(tmpdir(), 'agent-harness-'));
process.env.PROVIDER_DATA_DIR = directory;
process.env.OPENCODE_API_KEY = 'test-only-provider-key';
const { presets, saveProvider, modelLimits, syncAgentSettings } = await import('../providers.mjs');
const { requiresApproval, blockedInPlan } = await import('../execution-policy.mjs');
const { ChatStore, sanitizePermission } = await import('../conversations.mjs');
const { usageSummary, sessionUsageStats } = await import('../usage.mjs');
const { widgetDocument } = await import('../widget-document.mjs');
const { reactiveLive, handleEvent } = await import('../web/src/services/live.mjs');

test('plan mode is read-only: reads pass, writes and shell are blocked before any approval', () => {
  for (const tool of ['read', 'search_files', 'web_fetch', 'update_plan', 'ask_user']) assert.equal(blockedInPlan('plan', tool), false);
  for (const tool of ['write', 'edit', 'bash', 'background_start', 'memory_update']) assert.equal(blockedInPlan('plan', tool), true);
  for (const mode of ['ask', 'edit', 'auto']) assert.equal(blockedInPlan(mode, 'bash'), false);
  assert.equal(requiresApproval('plan', 'bash'), true);
  assert.equal(sanitizePermission({ execution: 'plan' }).execution, 'plan');
  assert.equal(sanitizePermission({ execution: 'root' }).execution, 'ask');
});

test('model limits: family defaults, per-model overrides, range validation and pricing in models.json', async () => {
  assert.equal(modelLimits({}, 'unknown-model').maxTokens, 16384);
  assert.equal(modelLimits({}, 'claude-opus-5-5').maxTokens, 64000);
  const saved = await saveProvider({ ...presets[4], apiKey: 'deepseek-test-key', models: ['deepseek-chat'], modelSettings: { 'deepseek-chat': { maxTokens: 65536, contextWindow: 1000000, input: 0.27, output: 1.1 } } });
  const provider = saved.providers.find(p => p.id === 'deepseek');
  assert.equal(provider.limits['deepseek-chat'].maxTokens, 65536);
  const models = JSON.parse(await readFile(join(directory, 'agent/models.json'), 'utf8'));
  const entry = models.providers.deepseek.models.find(m => m.id === 'deepseek-chat');
  assert.deepEqual([entry.maxTokens, entry.contextWindow, entry.cost.output], [65536, 1000000, 1.1]);
  await assert.rejects(saveProvider({ ...presets[4], apiKey: 'deepseek-test-key', models: ['deepseek-chat'], modelSettings: { 'deepseek-chat': { maxTokens: 10 } } }), /超出允许范围/);
});

test('agent settings enable bounded retry and keep unrelated settings', async () => {
  await writeFile(join(directory, 'agent/settings.json'), JSON.stringify({ compaction: { enabled: true } }));
  await syncAgentSettings();
  const settings = JSON.parse(await readFile(join(directory, 'agent/settings.json'), 'utf8'));
  assert.equal(settings.compaction.enabled, true);
  assert.equal(settings.retry.enabled, true);
  assert.ok(settings.retry.maxRetries >= 3 && settings.retry.maxRetries <= 8);
});

test('idle chats auto-archive after the chosen window; pinned and running chats stay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-archive-'));
  const store = new ChatStore({ sessionsRoot: join(root, 'sessions'), metaRoot: join(root, 'meta') });
  const user = 'c'.repeat(64), [old, pinned, busy, fresh] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  await mkdir(join(root, 'sessions', user), { recursive: true });
  const stale = new Date(Date.now() - 40 * 864e5);
  for (const id of [old, pinned, busy, fresh]) {
    const file = join(root, 'sessions', user, id + '.jsonl');
    await writeFile(file, JSON.stringify({ type: 'session', id }) + '\n');
    if (id !== fresh) await utimes(file, stale, stale);
    await store.initialize(user, id, 'default');
  }
  await store.setPinned(user, pinned, true);
  assert.equal(await store.autoArchive(user), 0, 'disabled by default');
  await assert.rejects(store.setChatSettings(user, { autoArchiveDays: 1000 }), /0–365/);
  await store.setChatSettings(user, { autoArchiveDays: 30 });
  assert.equal(await store.autoArchive(user, new Set([busy])), 1);
  const archived = Object.fromEntries((await store.list(user)).map(c => [c.id, c.archived]));
  assert.deepEqual([archived[old], archived[pinned], archived[busy], archived[fresh]], [true, false, false, false]);
});

test('usage totals come from session files and price unpriced calls from configured rates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-usage-')), user = 'd'.repeat(64), thread = randomUUID();
  await mkdir(join(root, user), { recursive: true });
  const call = usage => JSON.stringify({ type: 'message', timestamp: new Date().toISOString(), message: { role: 'assistant', provider: 'deepseek', model: 'deepseek-chat', usage } });
  await writeFile(join(root, user, thread + '.jsonl'), [JSON.stringify({ type: 'session' }), call({ input: 1e6, output: 1e6, cost: { total: 0 } }), call({ input: 10, output: 5, cost: { total: 2 } })].join('\n'));
  const summary = await usageSummary(user, { [thread]: '测试对话' }, 30, root);
  assert.equal(summary.total.calls, 2);
  assert.equal(summary.total.input, 1e6 + 10);
  assert.ok(Math.abs(summary.total.cost - (0.27 + 1.1 + 2)) < 1e-9);
  assert.equal(summary.byChat[0].title, '测试对话');

  // Verify per-session usage stats (tokens, cost, context window, and tokens/s speed)
  const sThread = randomUUID();
  const t0 = Date.now() - 10000;
  await writeFile(join(root, user, sThread + '.jsonl'), [
    JSON.stringify({ type: 'session', id: sThread }),
    JSON.stringify({ type: 'message', timestamp: new Date(t0).toISOString(), message: { role: 'user', content: '你好' } }),
    JSON.stringify({
      type: 'message',
      timestamp: new Date(t0 + 4000).toISOString(),
      message: {
        role: 'assistant',
        provider: 'deepseek',
        model: 'deepseek-chat',
        content: [{ type: 'text', text: '世界' }],
        usage: { input: 2000, cacheRead: 1000, output: 200, totalTokens: 3200, cost: { total: 0.012 } },
      },
    }),
  ].join('\n'));
  const stats = await sessionUsageStats(user, sThread, root);
  assert.equal(stats.tokens.total, 3200);
  assert.equal(stats.tokens.input, 2000);
  assert.equal(stats.tokens.cacheRead, 1000);
  assert.equal(stats.tokens.output, 200);
  assert.equal(stats.userMessages, 1);
  assert.equal(stats.assistantCalls, 1);
  assert.equal(stats.contextUsage.tokens, 3200);
  assert.ok(stats.contextUsage.autoCompactThreshold > 0);
  assert.equal(stats.speed.avgTokensPerSec, 50);
  assert.equal(stats.cacheHitRate, 33.3);
});

test('widget document supports frameless transparent background, dark mode variables, and live theme sync', () => {
  const doc = widgetDocument('<div style="background:#ffffff;color:#111111">Widget</div>');
  assert.match(doc, /html\[data-theme=dark\]/);
  assert.match(doc, /background:transparent/);
  assert.match(doc, /e\.data\.type==="iris-theme"/);
});

test('live state tracks dynamic retry countdown target and streaming usage metrics', () => {
  const vm = reactiveLive();
  handleEvent({ type: 'auto_retry_start', attempt: 2, maxAttempts: 5, delayMs: 4000 }, vm);
  assert.ok(vm.retry && vm.retry.attempt === 2 && vm.retry.maxAttempts === 5);
  assert.ok(vm.retry.until > Date.now());
  handleEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello world from streaming model' } }, vm);
  assert.ok(vm.usage.streamedChars > 0);
  assert.equal(vm.retry, null);
  handleEvent({ type: 'message_end', message: { role: 'assistant', usage: { input: 500, output: 120, cacheRead: 300, totalTokens: 920, cost: { total: 0.005 } } } }, vm);
  assert.equal(vm.usage.totalTokens, 920);
  assert.equal(vm.usage.lastContextTokens, 920);
});


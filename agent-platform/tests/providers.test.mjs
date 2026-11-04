import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'agent-providers-'));
process.env.PROVIDER_DATA_DIR = directory;
process.env.OPENCODE_API_KEY = 'test-only-provider-key';
const { presets, normalizeProvider, normalizeProbeInput, saveProvider, deleteProvider, activateProvider, publicProviders, proxyEnvironment, modelLimits, refreshModelsJson, DEFAULT_MODEL_LIMITS } = await import('../providers.mjs');
test('keys are never returned, blank preserves key, changed host requires explicit key', async () => {
  const input = { ...presets[0], apiKey: 'saved-secret-for-tests' };
  const result = await saveProvider(input);
  assert.equal(result.providers[0].hasKey, true);
  assert.equal(JSON.stringify(result).includes('saved-secret-for-tests'), false);
  assert.equal((await normalizeProvider({ ...input, apiKey: '' })).apiKey, input.apiKey);
  await assert.rejects(normalizeProvider({ ...input, apiKey: '', baseUrl: 'https://another.example/v1' }), /重新填写/);
  const stored = JSON.parse(await readFile(join(directory, 'agent/models.json'), 'utf8'));
  assert.equal(stored.providers['opencode-go'].apiKey, input.apiKey);
  assert.equal(JSON.stringify(await publicProviders()).includes(input.apiKey), false);
});
test('provider validation refuses credentials in URL, unknown protocols and malformed model', async () => {
  for (const bad of [{ baseUrl: 'http://example.com' }, { baseUrl: 'https://user:pass@example.com' }, { api: 'arbitrary' }, { model: '../../bad model' }, { id: '../bad' }]) {
    await assert.rejects(normalizeProvider({ ...presets[0], apiKey: 'test-key', ...bad }));
  }
});
test('proxy route is explicit and inherited proxies cannot override direct mode', () => {
  const source = { HTTP_PROXY: 'http://wrong', https_proxy: 'http://wrong', NODE_USE_ENV_PROXY: '1', KEEP: 'yes' };
  assert.deepEqual(proxyEnvironment(false, source), { KEEP: 'yes' });
  const proxy = proxyEnvironment(true, source);
  assert.equal(proxy.HTTPS_PROXY, 'http://192.168.84.1:17890');
  assert.equal(proxy.NODE_USE_ENV_PROXY, '1');
});
test('multi-model list,probe input security, activation, and provider deletion work cleanly', async () => {
  await saveProvider({ id: 'custom-hub', name: 'Custom Hub', api: 'openai-completions', baseUrl: 'https://hub.example.com/v1', model: '', models: ['gpt-5', 'claude-sonnet-5-5', 'qwen3-max'], apiKey: 'hub-secret-key', proxy: false });
  const pub = await publicProviders();
  const hub = pub.providers.find(p => p.id === 'custom-hub');
  assert.deepEqual(hub.models, ['gpt-5', 'claude-sonnet-5-5', 'qwen3-max']);
  assert.equal(hub.model, 'gpt-5');
  // Probe refuses SSRF / changed baseUrl without new key
  await assert.rejects(normalizeProbeInput({ id: 'custom-hub', api: 'openai-completions', baseUrl: 'https://127.0.0.1/v1', apiKey: 'k' }));
  await assert.rejects(normalizeProbeInput({ id: 'custom-hub', api: 'openai-completions', baseUrl: 'https://evil.example.com/v1', apiKey: '' }), /重新填写/);
  const probeOk = await normalizeProbeInput({ id: 'custom-hub', api: 'openai-completions', baseUrl: 'https://hub.example.com/v1', apiKey: '' });
  assert.equal(probeOk.apiKey, 'hub-secret-key');
  // Activate secondary model
  const sw = await activateProvider({ id: 'custom-hub', model: 'qwen3-max' });
  assert.equal(sw.activeModel, 'qwen3-max');
  // Delete provider falls back to remaining provider; last provider cannot be deleted
  const afterDel = await deleteProvider('custom-hub');
  assert.equal(afterDel.providers.some(p => p.id === 'custom-hub'), false);
  await assert.rejects(deleteProvider('opencode-go'), /至少需要保留/);
});
test.after(async () => rm(directory, { recursive: true, force: true }));

test('reasoning models get real output limits instead of the 16384-token default', async () => {
  // The KMP turn spent all 16384 output tokens on thinking and stopped with no answer.
  assert.deepEqual(modelLimits(presets[0], 'deepseek-v4.1-flash'), { contextWindow: 1000000, maxTokens: 384000 });
  assert.deepEqual(modelLimits({ baseUrl: 'https://api.example.com/v1' }, 'other'), { ...DEFAULT_MODEL_LIMITS });
  assert.deepEqual(modelLimits({ baseUrl: 'https://api.example.com/v1', maxTokens: 65536, contextWindow: 200000 }, 'other'), { contextWindow: 200000, maxTokens: 65536 });
  assert.equal(modelLimits({ baseUrl: 'https://api.example.com/v1', maxTokens: 900000, contextWindow: 200000 }, 'x').maxTokens, 200000);
  const saved = await normalizeProvider({ ...presets[0], apiKey: 'test-key', maxTokens: '65536', contextWindow: 262144 });
  assert.equal(saved.maxTokens, 65536); assert.equal(saved.contextWindow, 262144);
  for (const bad of [{ maxTokens: 0 }, { maxTokens: 'lots' }, { contextWindow: 10 }]) await assert.rejects(normalizeProvider({ ...presets[0], apiKey: 'test-key', ...bad }), error => error.status === 422);
  await saveProvider({ ...presets[0], apiKey: 'saved-secret-for-tests' });
  await refreshModelsJson();
  const stored = JSON.parse(await readFile(join(directory, 'agent/models.json'), 'utf8'));
  const model = stored.providers['opencode-go'].models.find(item => item.id === 'deepseek-v4.1-flash');
  assert.equal(model.maxTokens, 384000); assert.equal(model.contextWindow, 1000000);
});

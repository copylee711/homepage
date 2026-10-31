import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'agent-providers-'));
process.env.PROVIDER_DATA_DIR = directory;
process.env.OPENCODE_API_KEY = 'test-only-provider-key';
const { presets, normalizeProvider, saveProvider, publicProviders, proxyEnvironment } = await import('../providers.mjs');
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
test.after(async () => rm(directory, { recursive: true, force: true }));

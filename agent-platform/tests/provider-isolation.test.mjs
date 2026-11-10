import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'agent-provider-split-'));
process.env.PROVIDER_DATA_DIR = directory;
process.env.OPENCODE_API_KEY = 'shared-fallback-key';
const alice = createHash('sha256').update('alice').digest('hex');
const bob = createHash('sha256').update('bob').digest('hex');
const { saveProvider, savePersonalProvider, publicProviders, activateProvider, activateUserModel, isSharedProvider, loadProviders, writeUserAgentDir } = await import('../providers.mjs');
const personal = { id: 'my-hub', name: 'My Hub', api: 'openai-completions', baseUrl: 'https://mine.example/v1', model: 'mine-model', models: ['mine-model'], apiKey: 'alice-private-key', proxy: false };

test('personal providers stay with their user and do not change the shared default', async () => {
  await saveProvider({ id: 'opencode-go', name: 'OpenCode Go', api: 'openai-completions', baseUrl: 'https://opencode.ai/inference/go/openai/v1', model: 'deepseek-v4.1-flash', apiKey: 'shared-key', proxy: false });
  await savePersonalProvider(alice, personal);
  const shared = await publicProviders();
  assert.equal(shared.providers.some(item => item.id === 'my-hub'), false);
  assert.equal(JSON.stringify(shared).includes('alice-private-key'), false);
  const globalModels = JSON.parse(await readFile(join(directory, 'agent/models.json'), 'utf8'));
  assert.equal(globalModels.providers['my-hub'], undefined);
  const aliceModels = JSON.parse(await readFile(join(await writeUserAgentDir(alice), 'models.json'), 'utf8'));
  assert.equal(aliceModels.providers['my-hub'].apiKey, 'alice-private-key');
  const bobModels = JSON.parse(await readFile(join(await writeUserAgentDir(bob), 'models.json'), 'utf8'));
  assert.equal(bobModels.providers['my-hub'], undefined);
  const visible = await publicProviders(alice);
  assert.equal(visible.providers[0].id, 'my-hub');
  assert.equal(visible.shared.some(item => item.id === 'opencode-go'), true);
  assert.equal(JSON.stringify(visible).includes('alice-private-key'), false);
  await assert.rejects(savePersonalProvider(alice, { ...personal, id: 'opencode-go' }), /共享供应商/);
  await assert.rejects(saveProvider({ id: 'my-hub', name: 'Taken', api: 'openai-completions', baseUrl: 'https://shared.example/v1', model: 'x', apiKey: 'shared-key' }), /个人供应商/);
  assert.equal((await activateUserModel(alice, { id: 'my-hub', model: 'mine-model' })).active, 'my-hub');
  assert.equal((await loadProviders()).active, 'opencode-go');
  await activateProvider({ id: 'opencode-go', model: 'deepseek-v4.1-flash' });
  assert.equal((await publicProviders(alice)).active, 'my-hub');
  assert.equal((await publicProviders()).active, 'opencode-go');
  assert.equal(await isSharedProvider('opencode-go'), true);
  assert.equal(await isSharedProvider('my-hub'), false);
});

after(async () => rm(directory, { recursive: true, force: true }));

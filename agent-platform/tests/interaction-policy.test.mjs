import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requiresApproval } from '../execution-policy.mjs';
import { ToolApprovals, UserQuestions } from '../tool-approvals.mjs';
import { SearchSettings, normalizeSearch, publicSearch } from '../search.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('only known low-risk tools bypass approval, arbitrary bash never does', () => {
  for (const name of ['read', 'web_fetch', 'web_search', 'ask_user', 'update_plan']) assert.equal(requiresApproval('ask', name), false);
  for (const name of ['bash', 'write', 'edit', 'unknown', 'background_start', 'background_wait']) assert.equal(requiresApproval('ask', name), true);
  assert.equal(requiresApproval('auto', 'bash'), false);
});
test('switching to auto releases pending approval, preserves independent user questions', () => {
  const replies = [], approvals = new ToolApprovals(e => replies.push(e), () => {}), questions = new UserQuestions(e => replies.push(e), () => {});
  approvals.capture({ type: 'extension_ui_request', method: 'confirm', id: 'a' });
  questions.capture({ type: 'extension_ui_request', method: 'input', id: 'q', title: 'IRIS_ASK:' + JSON.stringify({ question: 'Which?', options: [{ label: 'A', recommended: true }, { label: 'B' }] }) });
  approvals.allowPending(); assert.equal(replies[0].confirmed, true); assert.equal(questions.pending.size, 1);
  assert.throws(() => questions.resolve('other', 'A'), e => e.status === 409);
  assert.throws(() => questions.resolve('q', ''), e => e.status === 422);
  questions.resolve('q', 'custom answer'); assert.equal(replies[1].value, 'custom answer');
  assert.throws(() => questions.resolve('q', 'again'), e => e.status === 409);
  questions.clear();
});
test('search configuration is validated and isolated per user', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iris-search-'));
  try {
    const store = new SearchSettings(dir), a = 'a'.repeat(64), b = 'b'.repeat(64);
    await store.save(a, { enabled: false, engine: 'bing', count: 2 });
    assert.equal((await store.get(a)).enabled, false); assert.equal((await store.get(b)).enabled, true);
    assert.throws(() => normalizeSearch({ engine: 'http://127.0.0.1' }));
    assert.throws(() => normalizeSearch({ count: 11 }));
    assert.throws(() => store.file('../user'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('search source secrets never appear in public settings; blank preserves, URL change clears', () => {
  const source={id:'custom',name:'Custom',kind:'json',enabled:true,endpoint:'https://api.example.com/search',auth:'bearer',bodyTemplate:{query:'{{query}}'},mapping:{results:'data.results',title:'title',url:'url',snippet:'snippet'},apiKey:'private-test-key'};
  const config=normalizeSearch({sources:[source]});
  assert.ok(!JSON.stringify(publicSearch(config)).includes('private-test-key'));
  assert.equal(publicSearch(config).sources[0].hasKey,true);
  const retained=normalizeSearch({sources:[{...source,apiKey:''}]},config);
  assert.equal(retained.sources[0].apiKey,'private-test-key');
  const changed=normalizeSearch({sources:[{...source,endpoint:'https://other.example.com/search',apiKey:''}]},config);
  assert.equal(changed.sources[0].apiKey,'');
  assert.throws(()=>normalizeSearch({sources:[{...source,endpoint:'https://127.0.0.1/search'}]}));
  assert.throws(()=>normalizeSearch({sources:[{...source,mapping:{results:'__proto__.items',title:'title',url:'url',snippet:'snippet'}}]}));
});

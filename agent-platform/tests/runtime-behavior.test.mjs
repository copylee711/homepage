import {test} from 'node:test';import assert from 'node:assert/strict';
import {promptInput} from '../prompt-input.mjs';import {WebSession,WEB_LIMITS}from'../web-session.mjs';import {turnGuidance}from'../agent-guidance.mjs';
test('image-only prompts keep text genuinely empty; empty messages without images are rejected',()=>{const image={type:'image',data:'AA==',mimeType:'image/png'};assert.deepEqual(promptInput({message:'',images:[image]}),{message:'',images:[image]});assert.throws(()=>promptInput({message:'',images:[]}));assert.throws(()=>promptInput({message:'',images:[{data:'',mimeType:'image/png'}]}));assert.equal(promptInput({message:'只看颜色',images:[image]}).message,'只看颜色');});
test('same-turn duplicate web calls share in-flight work; consecutive hard failures stop retries',async()=>{const web=new WebSession();let calls=0;const operation=async()=>{calls++;return {results:['verified']};};await Promise.all([web.run('search',' query ',operation),web.run('search','query',operation)]);assert.equal(calls,1);for(let i=0;i<20;i++)assert.notEqual((await web.run('search','different '+i,operation)).stopRetry,true);assert.equal(calls,21);const failed=new WebSession();for(let i=0;i<WEB_LIMITS.failures;i++)await failed.run('fetch','url'+i,async()=>{throw Error('secret-provider-details');});const stopped=await failed.run('fetch','another',operation);assert.equal(stopped.stopRetry,true);assert.doesNotMatch(JSON.stringify(stopped),/secret-provider-details/);assert.equal(calls,21);});
test('trusted Shanghai date, specialist diagrams and lightweight widgets are explicit per-turn guidance',()=>{const guidance=turnGuidance(new Date('2026-11-02T16:01:00Z'));assert.match(guidance,/2026-11-03/);assert.match(guidance,/graph-theory/);assert.match(guidance,/mathworld/);assert.match(guidance,/TMPDIR/);assert.match(guidance,/stopRetry/);});

test('image and web searches have separate, generous per-turn budgets and reuse identical requests', async () => {
  const web = new WebSession();
  let calls = 0;
  const operation = async () => ({ images: [++calls] });
  await web.run('image', 'first', operation);
  await web.run('image', 'first', operation);
  assert.equal(calls, 1);
  for (let i = 0; i < 30; i++) assert.notEqual((await web.run('image', 'query ' + i, operation)).stopRetry, true);
  assert.equal(calls, 31);
  assert.deepEqual(await web.run('search', 'third', operation), { images: [32] });
  const capped = new WebSession({ ...WEB_LIMITS, requests: { search: 2, fetch: 2, image: 2 } });
  await capped.run('image', 'a', operation); await capped.run('image', 'b', operation);
  assert.equal((await capped.run('image', 'c', operation)).stopRetry, true);
});

test('empty results are neither failures nor budget use; the old two-call image stop is gone', async () => {
  const web = new WebSession();
  let calls = 0;
  const empty = async () => { calls++; return { status: 'empty', results: [], images: [], notice: 'none' }; };
  // The reported case: two meme queries, then more re-phrasings.
  for (const q of ['cat meme funny reaction', '搞笑表情包 沙雕', 'funny cat reaction image', 'reaction meme cat', '猫 表情包']) {
    const result = await web.run('image', q, empty);
    assert.equal(result.status, 'empty'); assert.equal(result.stopRetry, false);
  }
  assert.equal(calls, 5); assert.equal(web.used.image, 0); assert.equal(web.failures.image, 0);
  // A result object without any hits counts as empty too.
  assert.equal((await web.run('search', 'nothing', async () => ({ results: [] }))).status, 'empty');
  // Within the per-turn request budget the next real hit still goes through.
  assert.deepEqual(await web.run('image', 'cat', async () => ({ images: ['x'] })), { images: ['x'] });
});

test('a hard failure resets after the source answers again and failed requests can be retried', async () => {
  const web = new WebSession();
  let attempt = 0;
  const flaky = async () => { if (attempt++ < 2) throw Error('down'); return { results: ['ok'] }; };
  assert.equal((await web.run('search', 'q', flaky)).status, 'unavailable');
  assert.equal((await web.run('search', 'q', flaky)).status, 'unavailable');
  assert.deepEqual(await web.run('search', 'q', flaky), { results: ['ok'] });
  assert.equal(web.failures.search, 0);
});

test('repeating the same request many times in a row is the loop that stops retries', async () => {
  const web = new WebSession();
  let calls = 0;
  const operation = async () => ({ results: [++calls] });
  for (let i = 1; i < WEB_LIMITS.repeats; i++) assert.notEqual((await web.run('search', 'same', operation)).stopRetry, true);
  const looped = await web.run('search', 'same', operation);
  assert.equal(looped.stopRetry, true); assert.deepEqual(looped.results, [1]); assert.equal(calls, 1);
  assert.notEqual((await web.run('search', 'different', operation)).stopRetry, true);
});

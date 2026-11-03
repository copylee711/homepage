import {test} from 'node:test';import assert from 'node:assert/strict';
import {promptInput} from '../prompt-input.mjs';import {WebSession}from'../web-session.mjs';import {turnGuidance}from'../agent-guidance.mjs';
test('image-only prompts keep text genuinely empty; empty messages without images are rejected',()=>{const image={type:'image',data:'AA==',mimeType:'image/png'};assert.deepEqual(promptInput({message:'',images:[image]}),{message:'',images:[image]});assert.throws(()=>promptInput({message:'',images:[]}));assert.throws(()=>promptInput({message:'',images:[{data:'',mimeType:'image/png'}]}));assert.equal(promptInput({message:'只看颜色',images:[image]}).message,'只看颜色');});
test('same-turn duplicate web calls share in-flight work; failure and total budgets stop retries',async()=>{const web=new WebSession();let calls=0;const operation=async()=>{calls++;return {results:['verified']};};await Promise.all([web.run('search',' query ',operation),web.run('search','query',operation)]);assert.equal(calls,1);for(let i=0;i<5;i++)await web.run('search','different '+i,operation);assert.equal((await web.run('search','over-budget',operation)).stopRetry,true);assert.equal(calls,6);const failed=new WebSession();for(let i=0;i<3;i++)await failed.run('fetch','url'+i,async()=>{throw Error('secret-provider-details');});assert.equal((await failed.run('fetch','another',operation)).stopRetry,true);assert.equal(calls,6);});
test('trusted Shanghai date, specialist diagrams and lightweight widgets are explicit per-turn guidance',()=>{const guidance=turnGuidance(new Date('2026-11-02T16:01:00Z'));assert.match(guidance,/2026-11-03/);assert.match(guidance,/graph-theory/);assert.match(guidance,/mathworld/);assert.match(guidance,/TMPDIR/);assert.match(guidance,/stopRetry/);});

test('image retries have a separate budget from web search and reuse identical requests', async () => {
  const web = new WebSession();
  let calls = 0;
  const operation = async () => ({ images: [++calls] });
  await web.run('image', 'first', operation);
  await web.run('image', 'first', operation);
  await web.run('image', 'second', operation);
  assert.equal((await web.run('image', 'third', operation)).stopRetry, true);
  assert.equal(calls, 2);
  assert.deepEqual(await web.run('search', 'third', operation), { images: [3] });
});

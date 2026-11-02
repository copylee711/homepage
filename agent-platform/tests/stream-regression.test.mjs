import {test} from 'node:test';import assert from 'node:assert/strict';
import {reactiveLive,handleEvent} from '../web/src/services/live.mjs';
test('normal user message events never become assistant supplemental instructions',()=>{const live=reactiveLive();handleEvent({type:'message_start',message:{role:'user',content:[{type:'text',text:'hello'}]}},live);assert.equal(live.blocks.length,0);});
import {eventBatch} from '../web/src/services/event-batch.mjs';
import {streamEvent} from '../stream-wire.mjs';
test('frame batching merges only adjacent matching deltas, flushes before tools and preserves final bytes',()=>{
 const output=[];let callback;const batch=eventBatch(e=>output.push(e),cb=>{callback=cb;return 1;},()=>{});
 for(let i=0;i<1000;i++)batch.push({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'字'}});
 assert.equal(output.length,0);callback();assert.equal(output.length,1);assert.equal(output[0].assistantMessageEvent.delta,'字'.repeat(1000));
 batch.push({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'末'}});batch.push({type:'agent_settled'});assert.equal(output[1].assistantMessageEvent.delta,'末');assert.equal(output[2].type,'agent_settled');
});
test('wire delta size stays constant as SDK snapshots grow; final canonical message retained',()=>{
 const event={type:'message_update',message:{content:'x'.repeat(100000)},assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:'hello',partial:{content:'x'.repeat(100000)}}};
 assert.ok(JSON.stringify(streamEvent(event)).length<200);assert.equal(event.assistantMessageEvent.partial.content.length,100000);
 const end={type:'message_end',message:event.message};assert.equal(streamEvent(end),end);
});

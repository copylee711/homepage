import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reactiveLive, handleEvent } from './live.mjs';
import { planFromBlock, planIsComplete, resolveTaskPlan } from './plan-state.mjs';
import { segmentBlocks } from './transcript.mjs';

const pending = [
  { step: '核对需求', status: 'in_progress' },
  { step: '修改实现', status: 'pending' },
  { step: '跑验证', status: 'pending' },
];
const done = pending.map((step) => ({ step: step.step, status: 'completed' }));

function planCall(id, steps) {
  return { id, name: 'update_plan', arguments: { steps } };
}

test('a finished checklist ignores a replayed pending snapshot and stays closed', () => {
  const live = reactiveLive();
  const play = (id, steps) => {
    handleEvent({ type: 'message_start', message: { role: 'assistant' } }, live);
    handleEvent({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0, toolCall: planCall(id, steps) } }, live);
    handleEvent({ type: 'tool_execution_start', toolCallId: id, toolName: 'update_plan', args: { steps } }, live);
    handleEvent({ type: 'tool_execution_end', toolCallId: id, result: { content: [{ type: 'text', text: JSON.stringify({ steps }) }] } }, live);
  };
  play('p1', pending);
  play('p2', done);

  const finished = live.blocks.find((block) => block.id === 'p2');
  assert.equal(finished.state, 'success');
  assert.equal(planIsComplete(planFromBlock(finished)), true);

  handleEvent({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id: 'p2', toolName: 'update_plan' } }, live);
  handleEvent({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0, toolCall: planCall('p2', pending) } }, live);
  handleEvent({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall', ...planCall('p1', pending) }] } }, live);
  handleEvent({ type: 'tool_execution_start', toolCallId: 'p2', toolName: 'update_plan', args: { steps: pending } }, live);

  assert.equal(finished.state, 'success');
  assert.deepEqual(planFromBlock(finished), done);
  assert.equal(live.blocks.filter((block) => block.name === 'update_plan').length, 2);

  const history = [
    { role: 'assistant', content: [{ type: 'toolCall', ...planCall('old', pending) }] },
  ];
  const visible = resolveTaskPlan(history, live.blocks);
  assert.deepEqual(visible, done);
  assert.equal(planIsComplete(visible), true);

  const folded = resolveTaskPlan([
    ...history,
    { role: 'assistant', content: live.blocks },
  ], null);
  assert.deepEqual(folded, done);
  assert.equal(planIsComplete(folded), true);

  const cards = segmentBlocks(live.blocks).filter((segment) => segment.type === 'plan');
  assert.equal(cards.length, 2);
  assert.deepEqual(planFromBlock(cards.at(-1).block), done);
});

test('the corner count follows the bubble and a new request can open a new plan', () => {
  const messages = [
    { role: 'user', content: '做完这三步' },
    { role: 'assistant', content: [{ type: 'tool', name: 'update_plan', args: JSON.stringify({ steps: done }), state: 'success' }] },
  ];
  assert.equal(planIsComplete(resolveTaskPlan(messages, null)), true);

  const restarted = [
    ...messages,
    { role: 'user', content: '再做一遍同样的清单' },
    { role: 'assistant', content: [{ type: 'toolCall', ...planCall('next', pending) }] },
  ];
  const again = resolveTaskPlan(restarted, null);
  assert.deepEqual(again, pending);
  assert.equal(planIsComplete(again), false);
  assert.equal(again.filter((step) => step.status === 'completed').length, 0);
});

test('args that regress to 0/n do not hide a completed tool result', () => {
  const block = {
    name: 'update_plan',
    args: JSON.stringify({ steps: pending }),
    result: JSON.stringify({ steps: done }),
  };
  assert.deepEqual(planFromBlock(block), done);
  const cards = segmentBlocks([
    { type: 'tool', name: 'update_plan', args: JSON.stringify({ steps: done }) },
    { type: 'tool', name: 'update_plan', args: JSON.stringify({ steps: pending }) },
  ]);
  assert.equal(cards.length, 1);
  assert.deepEqual(planFromBlock(cards[0].block), done);
});

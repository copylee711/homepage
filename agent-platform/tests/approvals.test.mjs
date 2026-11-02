import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolApprovals } from '../tool-approvals.mjs';

test('tool approvals wait, bind to one instance, reject replay, and return explicit decisions', () => {
  const replies = [], events = [];
  const owner = new ToolApprovals(e => replies.push(e), e => events.push(e));
  const other = new ToolApprovals(() => assert.fail('Another session resolved approval'), () => {});
  owner.capture({ type: 'extension_ui_request', method: 'confirm', id: 'one' });
  assert.equal(replies.length, 0);
  assert.throws(() => other.resolve('one', true), e => e.status === 409);
  assert.throws(() => owner.resolve('one', 'true'), e => e.status === 422);
  owner.resolve('one', false);
  assert.deepEqual(replies, [{ type: 'extension_ui_response', id: 'one', confirmed: false }]);
  assert.throws(() => owner.resolve('one', true), e => e.status === 409);
  owner.capture({ type: 'extension_ui_request', method: 'confirm', id: 'two' });
  owner.resolve('two', true);
  assert.equal(replies[1].confirmed, true);
  assert.equal(events.length, 2);
});

test('timeout and task completion fail closed', async () => {
  const replies = [];
  const gate = new ToolApprovals(e => replies.push(e), () => {}, 10);
  gate.capture({ type: 'extension_ui_request', method: 'confirm', id: 'timeout' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(replies[0].confirmed, false);
  assert.throws(() => gate.resolve('timeout', true), e => e.status === 409);
  gate.capture({ type: 'extension_ui_request', method: 'confirm', id: 'cancelled' });
  gate.clear();
  assert.equal(replies[1].confirmed, false);
});

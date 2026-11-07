import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnWatchdog, TURN_IDLE_MS, TOOL_IDLE_MS } from '../turn-watchdog.mjs';

const clock = () => { let t = 0; return { now: () => t, advance: ms => { t += ms; } }; };

test('a turn that keeps streaming reasoning is never stopped, however long it runs', () => {
  const c = clock(); let stopped = 0;
  const dog = new TurnWatchdog(() => stopped++, { now: c.now });
  for (let minute = 0; minute < 180; minute++) {
    c.advance(60000);
    dog.activity({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '…' } });
    assert.equal(dog.check(), false);
  }
  assert.equal(stopped, 0);
});

test('a silent turn stops once after the idle allowance; tools get a longer one', () => {
  const c = clock(); let stopped = 0;
  const dog = new TurnWatchdog(() => stopped++, { now: c.now });
  dog.activity({ type: 'tool_execution_start', toolCallId: 't1' });
  c.advance(TURN_IDLE_MS + 1000); assert.equal(dog.check(), false);
  dog.activity({ type: 'tool_execution_end', toolCallId: 't1' });
  c.advance(TURN_IDLE_MS - 1000); assert.equal(dog.check(), false);
  c.advance(2000); assert.equal(dog.check(), true); assert.equal(dog.check(), false);
  assert.equal(stopped, 1);
  const busy = new TurnWatchdog(() => stopped++, { now: c.now });
  busy.activity({ type: 'tool_execution_start', toolCallId: 't2' });
  c.advance(TOOL_IDLE_MS); assert.equal(busy.check(), true);
});

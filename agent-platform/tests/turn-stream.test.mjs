import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TurnFanout } from '../turn-stream.mjs';

function fakeRes() {
  const listeners = [];
  return {
    destroyed: false,
    writableEnded: false,
    writableLength: 0,
    chunks: [],
    once(event, fn) { listeners.push([event, fn]); },
    write(line) { this.chunks.push(line); return true; },
    end() { this.writableEnded = true; },
    destroy() { this.destroyed = true; },
    emitClose() { for (const [event, fn] of listeners) if (event === 'close') fn(); },
  };
}

test('closing a subscriber does not stop later events for the turn', () => {
  const fanout = new TurnFanout();
  const left = fakeRes();
  const stayed = fakeRes();
  fanout.publish('{"type":"start"}\n');
  fanout.attach(left, 0);
  fanout.attach(stayed, 0);
  assert.deepEqual(left.chunks, ['{"type":"start"}\n']);
  left.emitClose();
  fanout.publish('{"type":"still"}\n');
  assert.deepEqual(left.chunks, ['{"type":"start"}\n']);
  assert.deepEqual(stayed.chunks, ['{"type":"start"}\n', '{"type":"still"}\n']);
  assert.equal(fanout.cursor, 2);
});

test('cursor replay skips events the client already has and reports a gap after trimming', () => {
  const fanout = new TurnFanout(20);
  fanout.publish('{"n":1}\n');
  fanout.publish('{"n":2}\n');
  fanout.publish('{"n":3}\n');
  assert.ok(fanout.dropped > 0);
  const res = fakeRes();
  fanout.attach(res, 0);
  assert.equal(JSON.parse(res.chunks[0]).type, 'turn_gap');
  assert.match(res.chunks.at(-1), /"n":3/);
  const tail = fakeRes();
  fanout.attach(tail, fanout.cursor, { endIfIdle: true });
  assert.equal(tail.chunks.length, 0);
  assert.equal(tail.writableEnded, true);
});

test('runner and gateway do not bind turn cancellation to response close', async () => {
  const runner = await readFile(new URL('../runner.mjs', import.meta.url), 'utf8');
  const gateway = await readFile(new URL('../gateway.mjs', import.meta.url), 'utf8');
  assert.match(runner, /fanout\.attach\(res, 0\)/);
  assert.match(runner, /abortTurn\(\)/);
  assert.doesNotMatch(runner, /res\.once\('close', abort\)/);
  assert.doesNotMatch(gateway, /res\.once\('close', \(\) => abort\.abort\(\)\)/);
  assert.match(gateway, /turn\.pump\(response\)/);
  assert.match(gateway, /\/api\/turns\/subscribe/);
  assert.match(gateway, /\/api\/abort/);
});

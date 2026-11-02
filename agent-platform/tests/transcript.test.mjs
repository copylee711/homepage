import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reactiveLive, handleEvent } from '../web/src/services/live.mjs';
import { segmentBlocks, buildTranscript } from '../web/src/services/transcript.mjs';
test('multiple model messages reset contentIndex without merging text or moving tools', () => {
  const live = reactiveLive();
  for (const [text, id] of [['before', 'a'], ['between', 'b'], ['after', null]]) {
    handleEvent({ type: 'message_start', message: { role: 'assistant' } }, live);
    handleEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text } }, live);
    if (id) {
      handleEvent({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 1, toolCall: { id, name: 'read', arguments: { path: id } } } }, live);
      handleEvent({ type: 'tool_execution_start', toolCallId: id, toolName: 'read' }, live);
      handleEvent({ type: 'tool_execution_end', toolCallId: id, result: { content: [{ type: 'text', text: 'result-' + id }] } }, live);
    }
  }
  assert.deepEqual(live.blocks.map(b => b.type === 'text' ? b.text : b.id), ['before', 'a', 'between', 'b', 'after']);
  assert.equal(live.blocks[1].result, 'result-a');
  assert.deepEqual(segmentBlocks(live.blocks).map(s => s.type === 'text' ? s.text : s.items.length), ['before', 1, 'between', 1, 'after']);
});
test('only adjacent tools group, across history message boundaries; source history remains immutable', () => {
  const messages = [
    { role: 'user', content: 'task' },
    { role: 'assistant', content: [{ type: 'toolCall', id: '1', name: 'read' }] },
    { role: 'toolResult', toolCallId: '1', content: [{ type: 'text', text: 'found' }] },
    { role: 'assistant', content: [{ type: 'toolCall', id: '2', name: 'read' }, { type: 'text', text: 'explain' }, { type: 'toolCall', id: '3', name: 'write' }] },
  ];
  const before = JSON.stringify(messages);
  const display = buildTranscript(messages);
  const segments = segmentBlocks(display[1].content);
  assert.deepEqual(segments.map(s => s.type === 'tools' ? s.items.map(t => t.id) : s.text), [['1', '2'], 'explain', ['3']]);
  assert.equal(segments[0].items[0].result, 'found');
  assert.equal(JSON.stringify(messages), before);
});

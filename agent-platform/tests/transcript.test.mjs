import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reactiveLive, handleEvent } from '../web/src/services/live.mjs';
import { segmentBlocks, buildTranscript, groupExecution } from '../web/src/services/transcript.mjs';
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
test('reloaded history keeps stopReason length, including when a later assistant message is merged', () => {
  const limited = buildTranscript([
    { role: 'user', content: '继续' },
    { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: '先看一下' }] },
    { role: 'toolResult', toolCallId: 't', content: [{ type: 'text', text: 'ok' }] },
    { role: 'assistant', stopReason: 'length', content: [{ type: 'text', text: '截断的回答' }] },
  ]);
  assert.equal(limited[1].stopReason, 'length');
  assert.equal(limited[1].content.some(block => block.text === '截断的回答'), true);
  const finished = buildTranscript([
    { role: 'user', content: 'hi' },
    { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '完成' }] },
  ]);
  assert.equal(finished[1].stopReason, 'stop');
});
test('message_end records an output-limit stop without treating a normal stop as one', () => {
  const live = reactiveLive();
  handleEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'ok' }] } }, live);
  assert.equal(live.stopReason, '');
  handleEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'length', content: [{ type: 'text', text: 'cut' }] } }, live);
  assert.equal(live.stopReason, 'length');
  handleEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [] } }, live);
  assert.equal(live.stopReason, 'length');
});

test('execution disclosure stops at each visible answer segment', () => {
  const blocks = [
    { type: 'thinking', text: 'first thought' },
    { type: 'text', text: 'first answer' },
    { type: 'tool', id: 'read' },
    { type: 'text', text: 'second answer' },
    { type: 'tool', id: 'wait' },
  ];
  for (const streaming of [true, false]) {
    const groups = groupExecution(blocks, streaming);
    assert.deepEqual(groups.filter(block => block.type === 'text'), [blocks[1], blocks[3]]);
    assert.deepEqual(groups.filter(block => block.type === 'execution').map(group => group.items), [[blocks[0]], [blocks[2]], [blocks[4]]]);
    assert.deepEqual(groups.filter(block => block.type === 'execution').map(group => group.collapsed), [true, true, !streaming]);
  }
});

test('image reads preserve the returned preview in both live and reloaded transcripts', () => {
  const call = { type: 'toolCall', id: 'photo', name: 'read', arguments: { path: 'photo.png' } };
  const content = [{ type: 'text', text: 'Image read' }, { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }];
  for (const isError of [false, true]) {
    const live = reactiveLive();
    handleEvent({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args: call.arguments }, live);
    handleEvent({ type: 'tool_execution_end', toolCallId: call.id, isError, result: { content } }, live);
    const history = buildTranscript([
      { role: 'user', content: 'Read the image' },
      { role: 'assistant', content: [call] },
      { role: 'toolResult', toolCallId: call.id, isError, content },
    ]);
    const expected = isError ? undefined : 'data:image/png;base64,aW1hZ2U=';
    assert.equal(live.blocks[0].imageUrl, expected);
    assert.equal(history[1].content[0].imageUrl, expected);
  }
});

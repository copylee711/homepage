import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspacePanel, decodePreview } from '../web/js/workspace.js';

const value = text => ({ data: Buffer.from(text).toString('base64'), size: Buffer.byteLength(text), truncated: false });
test('text preview handles empty files and a UTF-8 boundary without classifying them as binary', () => {
  assert.deepEqual(decodePreview(value('')), { text: '', binary: false });
  const bytes = Buffer.from('中文');
  assert.deepEqual(decodePreview({ data: bytes.subarray(0, 4).toString('base64'), truncated: true }), { text: '中', binary: false });
  assert.equal(decodePreview(value('a\0b')).binary, true);
  assert.equal(decodePreview({ data: Buffer.from([255]).toString('base64') }).binary, true);
});
test('late file responses cannot replace the currently selected file or reopen a closed preview', async () => {
  const pending = [];
  const panel = Object.assign(Object.create(WorkspacePanel.prototype), {
    previewRequest: 0, preview: {}, previewTitle: {}, previewMeta: {}, previewNote: {},
    previewBody: { replaceChildren() {} }, download: {}, insert: {},
    request: () => new Promise(resolve => pending.push(resolve)),
  });
  const first = panel.previewFile('first.txt');
  const second = panel.previewFile('second.txt');
  pending[1](value('second')); await second;
  pending[0](value('first')); await first;
  assert.equal(panel.previewTitle.textContent, 'second.txt');
  assert.equal(panel.previewBody.textContent, 'second');
  const third = panel.previewFile('third.txt');
  panel.clearPreview(); pending[2](value('third')); await third;
  assert.equal(panel.selected, null); assert.equal(panel.preview.hidden, true);
  assert.equal(panel.previewBody.textContent, 'second');
});

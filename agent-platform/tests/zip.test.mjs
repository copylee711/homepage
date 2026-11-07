import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { createZip, crc32 } from '../zip.mjs';

// Minimal reader for the archives createZip produces: walk the central
// directory, then decompress each entry from its local header.
function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end > 0, 'end of central directory present');
  const count = buffer.readUInt16LE(end + 10);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  const files = {};
  let cursor = directoryOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;

    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const body = buffer.subarray(start, start + compressed);
    const data = method === 8 ? inflateRawSync(body) : body;
    assert.equal(data.length, size);
    assert.equal(crc32(data), crc);
    files[name] = data.toString('utf8');
  }
  return files;
}

test('a bundle round-trips with UTF-8 names, stored incompressible and deflated text', () => {
  const random = Array.from({ length: 4096 }, (_, i) => String.fromCharCode(33 + ((i * 37) % 90))).join('');
  const zip = createZip([
    { name: 'chat.md', data: '# 会话 · 中文标题\n\n正文内容\n'.repeat(40) },
    { name: 'turn.ndjson', data: '{"type":"message_update"}\n' },
    { name: 'random.bin', data: random },
    { name: 'empty.txt', data: '' },
  ]);
  const files = unzip(zip);
  assert.deepEqual(Object.keys(files).sort(), ['chat.md', 'empty.txt', 'random.bin', 'turn.ndjson']);
  assert.ok(files['chat.md'].startsWith('# 会话 · 中文标题'));
  assert.equal(files['turn.ndjson'], '{"type":"message_update"}\n');
  assert.equal(files['empty.txt'], '');
  assert.equal(files['random.bin'], random);
  // Compressible text is deflated, saving space on real transcripts.
  assert.ok(Buffer.byteLength(files['chat.md']) > 400);
  assert.ok(zip.length > Buffer.byteLength(files['chat.md']) * 0.2);
});

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

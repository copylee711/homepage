import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const worker = fileURLToPath(new URL('../sandbox-worker.py', import.meta.url));
function findPython() {
  for (const command of [process.env.PYTHON, 'python3', 'python', 'backend/.venv/Scripts/python.exe'].filter(Boolean)) {
    const probe = spawnSync(command, ['-I', '-c', 'import sys; print(sys.version)'], { encoding: 'utf8' });
    if (probe.status === 0) return command;
  }
  return null;
}
const python = findPython();
const root = await mkdtemp(join(tmpdir(), 'agent-workspace-'));
const outside = await mkdtemp(join(tmpdir(), 'agent-outside-'));
await mkdir(join(root, 'notes'), { recursive: true });
await writeFile(join(root, 'README.md'), '# Workspace\n');
await writeFile(join(root, 'notes', 'todo.txt'), 'buy milk\n');
await writeFile(join(outside, 'secret.txt'), 'HOST SECRET\n');
after(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });

function run(value) {
  const result = spawnSync(python, ['-I', worker], { input: JSON.stringify(value), encoding: 'utf8',
    env: { ...process.env, SANDBOX_WORKSPACE: root }, timeout: 20000 });
  const output = JSON.parse((result.stdout || '').trim() || '{}');
  return { status: result.status, output };
}
const skip = python ? false : 'Python 3 is not installed in this environment';

test('lists only the user workspace and marks directories/files', { skip }, () => {
  const result = run({ op: 'list', path: '' });
  assert.equal(result.status, 0);
  assert.equal(result.output.root, '/workspace');
  assert.equal(result.output.path, '');
  assert.equal(result.output.parent, null);
  const names = result.output.entries.map(entry => entry.name);
  assert.deepEqual(names.sort(), ['README.md', 'notes']);
  assert.equal(result.output.entries.find(entry => entry.name === 'notes').type, 'dir');
  assert.equal(result.output.entries.find(entry => entry.name === 'README.md').type, 'file');
  const nested = run({ op: 'list', path: 'notes' });
  assert.equal(nested.output.path, 'notes');
  assert.equal(nested.output.parent, '');
  assert.equal(nested.output.entries[0].path, 'notes/todo.txt');
});

test('file preview is bounded and returns base64 for its own files', { skip }, () => {
  const result = run({ op: 'file-read', path: 'README.md', limit: 8 });
  assert.equal(result.status, 0);
  assert.equal(Buffer.from(result.output.data, 'base64').toString(), '# Worksp');
  assert.equal(result.output.size, 12);
  assert.equal(result.output.truncated, true);
  const missing = run({ op: 'file-read', path: 'nope.txt' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.output.error, /路径|文件/);
});

test('traversal, absolute host paths and symlink escapes are refused inside the container', { skip }, async () => {
  for (const path of ['../' + outside.split(/[\\/]/).pop(), outside, '/etc/passwd', 'notes/../../x']) {
    const result = run({ op: 'file-read', path });
    assert.notEqual(result.status, 0, path + ' must be refused');
  }
  let linked = false;
  try {
    await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'), 'file');
    linked = true;
  } catch {}
  if (linked) {
    const result = run({ op: 'file-read', path: 'escape.txt' });
    assert.notEqual(result.status, 0);
    assert.match(result.output.error, /工作区/);
    const write = run({ op: 'file-write', path: 'escape.txt', content: 'overwrite' });
    assert.notEqual(write.status, 0);
    const list = run({ op: 'list', path: '' });
    assert.equal(list.output.entries.find(entry => entry.name === 'escape.txt').type, 'symlink');
  }
});

test('text upload writes only inside /workspace with an explicit size cap', { skip }, () => {
  const result = run({ op: 'file-write', path: 'notes/new.txt', content: 'hello 工作区\n' });
  assert.equal(result.status, 0);
  assert.equal(result.output.path, 'notes/new.txt');
  assert.equal(result.output.size, Buffer.byteLength('hello 工作区\n'));
  assert.equal(run({ op: 'file-read', path: 'notes/new.txt' }).output.data.length > 0, true);
  // An unconfirmed duplicate must not truncate the existing file.
  const duplicate = run({ op: 'file-write', path: 'notes/new.txt', content: 'replacement' });
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.output.error, /已存在/);
  const preserved = run({ op: 'file-read', path: 'notes/new.txt' });
  assert.equal(Buffer.from(preserved.output.data, 'base64').toString(), 'hello 工作区\n');
  const overwritten = run({ op: 'file-write', path: 'notes/new.txt', content: 'replacement', overwrite: true });
  assert.equal(overwritten.status, 0);
  assert.equal(Buffer.from(run({ op: 'file-read', path: 'notes/new.txt' }).output.data, 'base64').toString(), 'replacement');
  const outsideWrite = run({ op: 'file-write', path: '../outside.txt', content: 'x' });
  assert.notEqual(outsideWrite.status, 0);
  const binary = run({ op: 'file-write', path: 'notes/binary.txt', content: 'a\u0000b' });
  assert.notEqual(binary.status, 0);
  const large = run({ op: 'file-write', path: 'notes/large.txt', content: 'x'.repeat(256 * 1024 + 1) });
  assert.notEqual(large.status, 0);
  const directory = run({ op: 'file-write', path: 'notes', content: 'x' });
  assert.notEqual(directory.status, 0);
});

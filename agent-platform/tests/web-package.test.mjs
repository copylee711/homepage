import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const python = [process.env.PYTHON, 'python3', 'python', 'backend/.venv/Scripts/python.exe'].filter(Boolean).find(command => spawnSync(command, ['-I', '-c', 'import sys']).status === 0);
test('public web access denies SSRF/rebinding redirects; packages are pinned, integrity-checked and text-only', { skip: !python }, () => {
  const result = spawnSync(python, ['-I', fileURLToPath(new URL('./web-package.test.py', import.meta.url))], { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

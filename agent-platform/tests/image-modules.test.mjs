import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';

// Every local module the entry point imports must be COPYed into /app, or the
// container dies on start with ERR_MODULE_NOT_FOUND (912e32c shipped without
// turn-watchdog.mjs in the runner image).
const root = new URL('..', import.meta.url).pathname;
const copied = dockerfile => {
  const files = new Set();
  for (const line of readFileSync(join(root, dockerfile), 'utf8').split('\n')) {
    if (!line.startsWith('COPY ') || line.includes('--from')) continue;
    const parts = line.trim().split(/\s+/).slice(1), dest = parts.pop();
    if (dest === './' || dest === '/app/') for (const part of parts) files.add(basename(part));
  }
  return files;
};
const imports = entry => {
  const seen = new Set(), stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file) || !existsSync(join(root, file))) continue;
    seen.add(file);
    for (const match of readFileSync(join(root, file), 'utf8').matchAll(/(?:from\s+|import\()\s*['"]\.\/([\w.-]+)['"]/g)) stack.push(match[1]);
  }
  return seen;
};

for (const [dockerfile, entry] of [['Dockerfile.runner', 'runner.mjs'], ['Dockerfile.gateway', 'gateway.mjs'], ['Dockerfile.gateway.prebuilt', 'gateway.mjs']]) {
  test(`${dockerfile} copies every module ${entry} imports`, () => {
    const have = copied(dockerfile);
    assert.deepEqual([...imports(entry)].filter(file => !have.has(file)), []);
  });
}

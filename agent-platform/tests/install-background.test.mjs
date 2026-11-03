import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prefersBackgroundInstall, taskPurpose, INSTALL_GUIDANCE, INSTALL_REDIRECT } from '../install-background.mjs';

const installs = [
  'pip install -r requirements.txt',
  'pip3 install requests',
  'python3 -m pip install numpy',
  'python -m pip install .',
  'uv pip install ruff',
  'poetry install',
  'FOO=bar npm install',
  'FOO="a b" npm ci',
  'npm ci --no-audit',
  'npm install --legacy-peer-deps',
  'pnpm install',
  'yarn install --frozen-lockfile',
  'bun install',
  'npm run build',
  'pnpm run compile',
  'cargo build --release',
  'cargo install ripgrep',
  'go build ./...',
  'go mod download',
  'mvn package -DskipTests',
  'gradle build',
  'cd /workspace/app && npm ci',
  'cd /workspace/app; pip install -r requirements.txt',
];
const foreground = [
  'npm test',
  'npm run dev -- --host 0.0.0.0 --port 5173',
  'echo npm install',
  'ls',
  'python3 -m http.server 5173',
  'go test ./...',
  'git status',
];

test('install and build commands are the ones that should leave the foreground bash tool', () => {
  for (const command of installs) assert.equal(prefersBackgroundInstall(command), true, command);
  for (const command of foreground) assert.equal(prefersBackgroundInstall(command), false, command);
  assert.equal(taskPurpose('npm install', 'server'), 'install');
  assert.equal(taskPurpose('npm run dev', 'server'), 'server');
  assert.equal(taskPurpose('python3 -m http.server 5173', undefined), 'server');
  assert.equal(taskPurpose('sleep 2', 'install'), 'install');
  assert.match(INSTALL_REDIRECT, /background_start/);
  assert.match(INSTALL_REDIRECT, /background_wait/);
  assert.match(INSTALL_GUIDANCE, /purpose "install"/);
});

test('the sandbox extension moves installs to the background and can pause until background work finishes', async () => {
  const source = await readFile(new URL('../sandbox-extension.ts', import.meta.url), 'utf8');
  assert.match(source, /prefersBackgroundInstall/);
  assert.match(source, /name: 'background_wait'/);
  assert.match(source, /taskPurpose\(params\.command, params\.purpose\)/);
  assert.match(source, /INSTALL_GUIDANCE/);
  assert.match(source, /call\('background-start', \{ command, cwd, purpose: 'install' \}, signal\)/);
});

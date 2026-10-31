// Opt-in acceptance test, run INSIDE a trusted runner on the deployment network.
// Uses isolated test users; never print secrets or upstream model responses.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const url = process.env.SANDBOX_URL || 'http://192.168.84.1:18082';
const secret = process.env.SANDBOX_SECRET;
if (!secret) throw new Error('SANDBOX_SECRET required');
const a = createHash('sha256').update('sandbox-acceptance-a').digest('hex');
const b = createHash('sha256').update('sandbox-acceptance-b').digest('hex');
async function request(path, token, value) {
  const res = await fetch(url + path, { method: 'POST', headers: {
    'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(value), signal: AbortSignal.timeout(90000) });
  return { status: res.status, value: await res.json() };
}
async function lease(user) { const res = await request('/lease', secret, { user }); assert.equal(res.status, 200); return res.value.token; }
let ta = await lease(a), tb = await lease(b);
const tool = (token, value) => request('/tool', token, value);
const bash = (token, command, timeout) => tool(token, { op: 'bash', command, timeout });
try {
  assert.equal((await request('/lease', 'forged', { user: a })).status, 401);
  assert.equal((await request('/lease', secret, { user: '../escape' })).status, 422);
  assert.equal((await tool(secret, { op: 'bash', command: 'true' })).status, 403);
  console.log('PASS private broker authentication and user validation');
  assert.equal((await bash(ta, 'printf USER_A_ONLY > /workspace/private.txt')).status, 200);
  const persisted = await tool(ta, { op: 'read', path: '/workspace/private.txt' });
  assert.equal(Buffer.from(persisted.value.data, 'base64').toString(), 'USER_A_ONLY');
  assert.notEqual((await tool(tb, { op: 'read', path: '/workspace/private.txt' })).status, 200);
  assert.notEqual((await tool(tb, { op: 'read', path: '/data/providers.json' })).status, 200);
  assert.notEqual((await tool(tb, { op: 'read', path: '/var/run/docker.sock' })).status, 200);
  assert.equal((await tool(ta, { op: 'write', user: b, path: '/workspace/scoped.txt', content: 'A' })).status, 200);
  assert.notEqual((await tool(tb, { op: 'read', path: '/workspace/scoped.txt' })).status, 200);
  console.log('PASS persistent private workspaces, tenant spoofing and secret paths');
  const security = await bash(ta, `python3 - <<'PY'
import os, socket
from pathlib import Path
assert os.getuid() == 1000
assert not any(k in os.environ for k in ['OPENCODE_API_KEY','RUNNER_SECRET','SANDBOX_SECRET','SANDBOX_LEASE'])
pid1 = Path('/proc/1/environ').read_bytes().split(bytes([0]))
assert not any(item.split(b'=', 1)[0] in [b'OPENCODE_API_KEY',b'RUNNER_SECRET',b'SANDBOX_SECRET',b'SANDBOX_LEASE'] for item in pid1)
assert not Path('/var/run/docker.sock').exists()
assert 'CapEff:\\t0000000000000000' in Path('/proc/self/status').read_text()
assert 'NoNewPrivs:\\t1' in Path('/proc/self/status').read_text()
assert Path('/sys/fs/cgroup/memory.max').read_text().strip() == '268435456'
assert Path('/sys/fs/cgroup/pids.max').read_text().strip() == '48'
try: Path('/etc/cross-boundary').write_text('bad')
except OSError: pass
else: raise AssertionError('writable root')
for host in ['192.168.84.1','1.1.1.1','169.254.169.254']:
 try: socket.create_connection((host,80), .3)
 except OSError: pass
 else: raise AssertionError('network available')
print('isolation verified')
PY`);
  assert.equal(security.value.exitCode, 0, JSON.stringify(security));
  console.log('PASS nonroot, caps, readonly root, bounded resources, no credentials/network/metadata');
  await request('/renew', secret, { user: a, token: ta });
  const quota = await bash(ta, 'for n in 1 2 3 4; do dd if=/dev/zero of=/workspace/quota$n bs=1M count=80 status=none || exit 17; done');
  assert.equal(quota.value.exitCode, 17);
  assert.equal((await bash(ta, 'rm -f /workspace/quota*')).value.exitCode, 0);
  console.log('PASS persistent workspace disk quota');
  await request('/renew', secret, { user: a, token: ta });
  const pending = bash(ta, 'setsid sleep 60 & wait');
  await new Promise(resolve => setTimeout(resolve, 1500));
  const start = Date.now();
  assert.equal((await request('/cancel', secret, { user: a })).status, 200);
  assert.notEqual((await pending).status, 200);
  assert.ok(Date.now() - start < 10000);
  assert.equal((await bash(ta, 'true')).status, 403);
  console.log('PASS revocation kills descendants and invalidates existing lease');
  ta = await lease(a);
  const expiring = bash(ta, 'sleep 60');
  const expired = await expiring;
  assert.notEqual(expired.status, 200);
  assert.equal((await bash(ta, 'true')).status, 403);
  console.log('PASS heartbeat loss fails closed after 20-second lease expiry');
} finally {
  await request('/cancel', secret, { user: a }); await request('/cancel', secret, { user: b });
}

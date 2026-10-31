import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
let large = true;
const broker = createServer(async (req, res) => {
  let text = ''; for await (const chunk of req) text += chunk;
  const input = JSON.parse(text);
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/lease') {
    assert.equal(req.headers.authorization, 'Bearer test-sandbox-control');
    assert.equal(input.user, 'a'.repeat(64));
    return res.end(JSON.stringify({ token: 'scoped-lease' }));
  }
  assert.equal(req.headers.authorization, 'Bearer scoped-lease');
  assert.equal(input.op, 'file-read');
  res.end(JSON.stringify({ data: Buffer.from('complete').toString('base64'), size: large ? 1048577 : 8, truncated: large }));
});
await new Promise(resolve => broker.listen(0, '127.0.0.1', resolve));
process.env.SANDBOX_URL = `http://127.0.0.1:${broker.address().port}`;
process.env.SANDBOX_SECRET = 'test-sandbox-control';
const { downloadWorkspace, previewWorkspace } = await import('../workspace.mjs');
after(() => new Promise(resolve => broker.close(resolve)));
test('oversized downloads reject instead of silently returning a truncated file; previews remain bounded', async () => {
  await assert.rejects(downloadWorkspace('a'.repeat(64), 'large.txt'), error => error.status === 413);
  assert.equal((await previewWorkspace('a'.repeat(64), 'large.txt')).truncated, true);
  large = false;
  const result = await downloadWorkspace('a'.repeat(64), 'small.txt');
  assert.equal(Buffer.from(result.data, 'base64').toString(), 'complete');
});

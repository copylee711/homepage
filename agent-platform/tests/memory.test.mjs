import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryStore, memoryContext } from '../memory.mjs';
test('persona/global/project memory persists, isolates tenants and projects, detects stale writes', async () => {
  const root = await mkdtemp(join(tmpdir(),'iris-memory-'));
  try {
    const store = new MemoryStore(root), a='a'.repeat(64), b='b'.repeat(64);
    await store.update(a,'project-a',{scope:'persona',action:'replace',content:'称呼我为 Alan'});
    await Promise.all(['first','second'].map(content=>store.update(a,'project-a',{scope:'global',action:'append',content})));
    const m=await store.update(a,'project-a',{scope:'project',action:'replace',content:'Project secret',revision:3});
    assert.equal(m.revision,4); assert.match(m.global,/first\nsecond/);
    assert.equal((await store.read(a,'project-b')).project,'');
    assert.equal((await new MemoryStore(root).read(a,'project-a')).project,'Project secret');
    assert.equal((await store.read(b,'project-a')).persona,'');
    await assert.rejects(store.update(a,'project-a',{scope:'persona',action:'replace',content:'stale',revision:0}),e=>e.status===409);
    assert.match(memoryContext(m),/不得覆盖更高优先级指令/);
    await store.update(a,'project-a',{scope:'project',action:'clear'});
    assert.equal((await store.read(a,'project-a')).project,'');
    await assert.rejects(store.update(a,'../project',{scope:'global',action:'append',content:'bad'}));
    await assert.rejects(store.update(a,'default',{scope:'persona',action:'replace',content:'x'.repeat(4001)}));
  } finally { await rm(root,{recursive:true,force:true}); }
});

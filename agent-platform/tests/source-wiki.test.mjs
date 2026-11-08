import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceWiki, discoveredSource } from '../source-wiki.mjs';

test('public defaults, account isolation, stale drafts and bounded automatic maintenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'iris-source-wiki-'));
  const wiki = new SourceWiki(root);
  const user = 'a'.repeat(64), other = 'b'.repeat(64);
  try {
    const base = await wiki.get(user);
    assert.ok(base.sources.some(source => source.url === 'https://github.com/trending'));
    const candidate = discoveredSource('news', new URL('https://example.org/news'));
    assert.ok(candidate);
    assert.equal(discoveredSource('news', new URL('https://example.org/news?token=secret')), null);
    assert.equal(discoveredSource('news', new URL('https://example.org/news/single-article')), null);
    assert.equal((await wiki.maintain(user, [candidate], new Map(), 0)).revision, 0);
    const edited = await wiki.save(user, { ...base, auto: true, sources: base.sources.slice(1) });
    assert.ok(!(await wiki.get(user)).sources.some(source => source.url === base.sources[0].url));
    assert.equal((await wiki.maintain(user, [candidate], new Map(), 0)).revision, edited.revision);
    const ignored = await wiki.maintain(user, [base.sources[0]], new Map(), edited.revision);
    assert.equal(ignored.revision, edited.revision);
    const tracked = 'https://github.com/trending';
    let state = edited;
    for (let i = 0; i < 3; i++) state = await wiki.maintain(user, [candidate], new Map([[tracked, false]]), state.revision);
    assert.equal(state.sources.find(source => source.url === tracked).failures, 3);
    assert.equal(state.sources.filter(source => source.url === candidate.url).length, 1);
    await assert.rejects(wiki.save(user, edited), { status: 409 });
    const untouched = await wiki.get(other);
    assert.equal(untouched.sources.length, base.sources.length);
    assert.ok(!untouched.sources.some(source => source.url === candidate.url));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

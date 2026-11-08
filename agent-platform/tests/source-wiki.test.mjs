import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceWiki, discoveredSource, documentationSources } from '../source-wiki.mjs';

test('existing accounts gain the official docs catalog and resolve relevant technologies without embeddings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'iris-wiki-docs-'));
  const wiki = new SourceWiki(root);
  const user = 'c'.repeat(64);
  try {
    const base = await wiki.get(user);
    const legacy = { ...base, sources: base.sources.filter(source => source.topic !== 'docs'),
      knownBuiltins: base.knownBuiltins.filter(key => !key.startsWith('docs:')) };
    await writeFile(wiki.file(user), JSON.stringify(legacy));
    const snapshot = await wiki.get(user);
    assert.equal(snapshot.sources.filter(source => source.topic === 'docs').length, 28);
    assert.deepEqual(documentationSources(snapshot, 'Next.js 16 和 React 19 迁移').map(source => source.title), ['React', 'Next.js']);
    assert.deepEqual(documentationSources(snapshot, 'go to the store'), []);
    const edited = await wiki.save(user, { ...snapshot, sources: snapshot.sources.map(source =>
      source.title === 'Python' ? { ...source, enabled: false } : source) });
    assert.deepEqual(documentationSources(edited, 'Python 3.14 文档'), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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

test('embedding credentials stay private and do not follow a changed endpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'iris-wiki-embedding-'));
  const wiki = new SourceWiki(root);
  const user = 'a'.repeat(64);
  try {
    const base = await wiki.get(user);
    const embedding = {url:'https://example.org/v1/embeddings',model:'embed',apiKey:'private-key'};
    const saved = await wiki.save(user, { ...base, semantic: true, embedding });
    assert.equal(wiki.publicConfig(saved).embedding.hasKey, true);
    assert.ok(!JSON.stringify(wiki.publicConfig(saved)).includes('private-key'));
    const next = await wiki.save(user, { ...saved, embedding: {...embedding,url:'https://example.net/v1/embeddings',apiKey:''} });
    assert.equal(next.embedding.apiKey, '');
    await assert.rejects(wiki.save(user,{...next,embedding:{...embedding,url:'http://127.0.0.1'}}),{status:422});
  } finally { await rm(root,{recursive:true,force:true}); }
});

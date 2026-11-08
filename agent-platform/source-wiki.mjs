import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fail } from './shared.mjs';

export const WIKI_TOPICS = ['news', 'llm', 'github', 'images', 'mathematics', 'physics', 'biology'];
const builtins = [
  ['news', 'Reuters World', 'https://www.reuters.com/world/'],
  ['news', 'Associated Press', 'https://apnews.com/world-news'],
  ['news', '新华社', 'https://www.news.cn/'],
  ['llm', 'Artificial Analysis', 'https://artificialanalysis.ai/leaderboards/models'],
  ['llm', 'Arena 文本榜', 'https://arena.ai/leaderboard/text'],
  ['llm', 'Terminal-Bench', 'https://www.tbench.ai/leaderboard'],
  ['github', 'GitHub Trending', 'https://github.com/trending'],
  ['github', 'GitHub Search', 'https://github.com/search?type=repositories'],
  ['images', 'Openverse', 'https://openverse.org/'],
  ['images', 'Wikimedia Commons', 'https://commons.wikimedia.org/'],
  ['images', 'Unsplash', 'https://unsplash.com/'],
  ['mathematics', 'MathWorld', 'https://mathworld.wolfram.com/'],
  ['mathematics', 'Wikimedia 数学图解', 'https://commons.wikimedia.org/wiki/Category:Mathematical_diagrams'],
  ['physics', 'HyperPhysics', 'https://hyperphysics.phy-astr.gsu.edu/hbase/hframe.html'],
  ['physics', 'PhET', 'https://phet.colorado.edu/en/simulations/filter?subjects=physics'],
  ['physics', 'Wikimedia 物理图解', 'https://commons.wikimedia.org/wiki/Category:Physics_diagrams'],
  ['biology', 'EMBL-EBI', 'https://www.ebi.ac.uk/'],
  ['biology', 'Wikimedia 生物图解', 'https://commons.wikimedia.org/wiki/Category:Biological_diagrams'],
  ['biology', 'RCSB PDB', 'https://www.rcsb.org/'],
].map(([topic, title, url]) => ({ topic, title, url, enabled: true, origin: 'builtin' }));

export function wikiSource(value) {
  let url;
  try { url = new URL(value?.url); } catch { fail(422, '请输入完整的 HTTPS 来源地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.href.length > 1000 ||
      !url.hostname.includes('.') || /(?:^|\.)(localhost|local|internal)$/.test(url.hostname) ||
      /^[\d.]+$/.test(url.hostname)) fail(422, '来源须使用公开 HTTPS 地址');
  url.hash = '';
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  if (!WIKI_TOPICS.includes(value.topic) || !title || title.length > 100) fail(422, '来源类别或名称无效');
  return { topic: value.topic, title, url: url.href, enabled: value.enabled !== false };
}
const key = source => source.topic + ':' + source.url;
// Auto-learning is restricted to recognizable index pages already fetched for
// the user's task. Query strings, article slugs and private URLs are excluded.
export function discoveredSource(topic, url) {
  if (!WIKI_TOPICS.includes(topic) || url.search ||
      !/^\/(?:news|trending|leaderboards?|benchmarks?|gallery|galleries|photos|collections)\/?$/i.test(url.pathname)) return null;
  try { return wikiSource({ topic, url: url.href, title: url.hostname.replace(/^www\./, '') }); }
  catch { return null; }
}

const initial = () => ({ revision: 0, auto: false, knownBuiltins: builtins.map(key), sources: builtins.map(source => ({ ...source })) });

export class SourceWiki {
  constructor(root = '/data/source-wiki') {
    this.root = root;
    this.queue = new Map();
  }
  file(user) {
    if (!/^[a-f0-9]{64}$/.test(user)) fail(422, '用户标识无效');
    return this.root + '/' + user + '.json';
  }
  async get(user) {
    try {
      const saved = JSON.parse(await readFile(this.file(user), 'utf8'));
      const known = new Set(saved.knownBuiltins || []);
      const existing = new Set(saved.sources.map(key));
      const additions = builtins.filter(source => !known.has(key(source)) && !existing.has(key(source)));
      return { ...saved, knownBuiltins: builtins.map(key), sources: [...saved.sources, ...additions].slice(0, 80) };
    }
    catch (error) { if (error.code === 'ENOENT') return initial(); throw error; }
  }
  async update(user, transform) {
    const previous = this.queue.get(user) || Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      const current = await this.get(user);
      const next = transform(current);
      if (next === current) return current;
      next.revision = current.revision + 1;
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const file = this.file(user), temp = file + '.' + randomUUID();
      await writeFile(temp, JSON.stringify(next), { mode: 0o600 });
      await rename(temp, file);
      return next;
    });
    this.queue.set(user, work);
    try { return await work; }
    finally { if (this.queue.get(user) === work) this.queue.delete(user); }
  }
  save(user, input) {
    return this.update(user, current => {
      if (input.revision !== current.revision) fail(409, '目录已更新，请重新载入后再保存');
      if (!Array.isArray(input.sources) || input.sources.length > 80) fail(422, '目录最多 80 条来源');
      const sources = input.sources.map(value => {
        const source = wikiSource(value);
        const old = current.sources.find(item => key(item) === key(source));
        return { ...old, ...source, origin: old?.origin || 'user', failures: value.retry === true ? 0 : (old?.failures || 0) };
      });
      if (new Set(sources.map(key)).size !== sources.length) fail(422, '同一类别中存在重复地址');
      return { ...current, auto: input.auto === true, sources };
    });
  }
  maintain(user, proposals, checks, revision) {
    return this.update(user, current => {
      if (!current.auto || revision !== current.revision) return current;
      let changed = false;
      const sources = current.sources.map(source => {
        if (!checks.has(source.url)) return source;
        const failures = checks.get(source.url) ? 0 : Math.min(3, (source.failures || 0) + 1);
        if (failures === (source.failures || 0)) return source;
        changed = true;
        return { ...source, failures };
      });
      for (const source of proposals) {
        if (sources.length >= 80 || sources.some(item => key(item) === key(source))) continue;
        sources.push({ ...source, origin: 'agent', addedAt: new Date().toISOString() });
        changed = true;
      }
      return changed ? { ...current, sources } : current;
    });
  }
}

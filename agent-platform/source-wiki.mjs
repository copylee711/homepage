import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { sandbox } from './sandbox-client.mjs';
import { fail } from './shared.mjs';

export const WIKI_TOPICS = ['news', 'llm', 'github', 'images', 'mathematics', 'physics', 'biology'];
const topicDescription = {
  news: '时事新闻 今日热点 world news current events',
  llm: '大模型榜单 LLM AI benchmark model rankings',
  github: '开源项目 GitHub 热门仓库 trending repositories',
  images: '通用图库 照片 illustrations stock photography image search',
  mathematics: '数学 公式 图解 微积分 概率 几何 mathematics calculus geometry probability',
  physics: '物理 电磁学 力学 光学 physics electromagnetism mechanics optics',
  biology: '生物 细胞 基因 蛋白质 biology cells genes proteins',
};
function unitVector(vector) {
  if (!Array.isArray(vector) || !vector.length || vector.length > 4096 || !vector.every(Number.isFinite)) return null;
  const norm = Math.hypot(...vector);
  return norm > 0 && Number.isFinite(norm) ? vector.map(value => value / norm) : null;
}
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

const initial = () => ({ revision: 0, auto: false, semantic: false, knownBuiltins: builtins.map(key), sources: builtins.map(source => ({ ...source })) });

export class SourceWiki {
  constructor(root = '/data/source-wiki') {
    this.root = root;
    this.queue = new Map();
    this.vectors = new Map();
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
      const retained = new Set(sources.map(key));
      const suppressed = new Set(current.suppressed || []);
      for (const source of current.sources) if (!retained.has(key(source))) suppressed.add(key(source));
      for (const id of retained) suppressed.delete(id);
      let embedding = current.embedding;
      if (input.embedding) {
        const { url, model, apiKey } = input.embedding;
        if (!url && !model) embedding = undefined;
        else {
          let endpoint;
          try { endpoint = new URL(url); } catch { fail(422, '请输入完整的 HTTPS Embeddings 端点'); }
          if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.port ||
              endpoint.hash || endpoint.href.length > 1000 || typeof model !== 'string' || !model.trim() ||
              model.length > 180 || (apiKey && (typeof apiKey !== 'string' || !/^[!-~]{1,512}$/.test(apiKey))))
            fail(422, '向量端点、模型或密钥格式无效');
          embedding = { url: endpoint.href, model: model.trim(), apiKey: apiKey ||
            (endpoint.href === embedding?.url ? embedding.apiKey : '') };
        }
      }
      return { ...current, embedding, auto: input.auto === true, semantic: input.semantic === true, sources, suppressed: [...suppressed].slice(-320) };
    });
  }
  embeddingConfig(snapshot) {
    return snapshot.embedding || { url: process.env.WIKI_EMBEDDING_URL, model: process.env.WIKI_EMBEDDING_MODEL,
      apiKey: process.env.WIKI_EMBEDDING_KEY };
  }

  publicConfig(snapshot) {
    const { embedding, ...rest } = snapshot;
    const effective = this.embeddingConfig(snapshot);
    return { ...rest, semanticAvailable: !!(effective.url && effective.model),
      embedding: { url: embedding?.url || '', model: embedding?.model || '', hasKey: !!embedding?.apiKey } };
  }

  async semanticMatch(user, snapshot, prompt) {
    const { url, model, apiKey } = this.embeddingConfig(snapshot);
    if (!url || !model || !snapshot.semantic || typeof prompt !== 'string' || !prompt.trim()) return [];
    const sources = snapshot.sources.filter(source => source.enabled && (source.failures || 0) < 3);
    if (!sources.length) return [];
    const descriptions = sources.map(source => `${topicDescription[source.topic]} | ${source.title} | ${source.url}`);
    const fingerprint = createHash('sha256').update(JSON.stringify([url, model, apiKey, descriptions])).digest('hex');
    const cached = this.vectors.get(user);
    const index = cached?.fingerprint === fingerprint ? cached.vectors : null;
    const query = prompt.trim().slice(0, 1800);
    const input = index ? [query] : [query, ...descriptions];
    const result = await sandbox('/wiki/embedding', user, undefined, null, { url, model, apiKey, input }, 3400);
    if (!Array.isArray(result.data) || result.data.length !== input.length) return [];
    const vectors = input.map((_, i) => unitVector(result.data.find(item => item.index === i)?.embedding));
    const [queryVector, ...built] = vectors;
    const sourceVectors = index || built;
    if (!queryVector || sourceVectors.some(vector => vector?.length !== queryVector.length)) return [];
    if (!index) {
      if (this.vectors.size >= 16) this.vectors.delete(this.vectors.keys().next().value);
      this.vectors.set(user, { fingerprint, vectors: built });
    }
    return sources.map((source, i) => ({
      source, score: sourceVectors[i].reduce((sum, value, j) => sum + value * queryVector[j], 0),
    })).filter(item => item.score >= 0.42).sort((a, b) => b.score - a.score).slice(0, 4).map(item => item.source);
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
        if (sources.length >= 80 || current.suppressed?.includes(key(source)) || sources.some(item => key(item) === key(source))) continue;
        sources.push({ ...source, origin: 'agent', addedAt: new Date().toISOString() });
        changed = true;
      }
      return changed ? { ...current, sources } : current;
    });
  }
}

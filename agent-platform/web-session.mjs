// Per-turn guard for web_search / image_search / web_fetch. A new WebSession is
// created for every user turn. It exists to stop genuine failure loops, not to
// ration ordinary research: re-phrased searches and empty results are normal.
export const WEB_LIMITS = Object.freeze({
  // Requests that actually returned something, per kind and turn.
  requests: { search: 60, fetch: 80, image: 40 },
  // Consecutive hard errors (source unreachable, HTTP errors) before stopping that kind.
  failures: 5,
  // The same normalized request repeated this many times in a row.
  repeats: 4,
  // Hard ceiling on all attempts of one kind (including empty results), against runaway loops.
  attempts: { search: 150, fetch: 150, image: 120 },
});

const unavailable = (notice, stopRetry) => ({ status: 'unavailable', results: [], images: [], stopRetry, notice });
const isEmpty = (kind, result) => kind !== 'fetch' && (result?.status === 'empty' || !(result?.results?.length || result?.images?.length));

export class WebSession {
  constructor(limits = WEB_LIMITS) {
    this.limits = limits; this.cache = new Map();
    this.used = { search: 0, fetch: 0, image: 0 }; this.attempts = { search: 0, fetch: 0, image: 0 };
    this.failures = { search: 0, fetch: 0, image: 0 }; this.last = { key: '', repeats: 0 };
  }
  async run(kind, key, operation) {
    const cacheKey = kind + ':' + String(key).trim().replace(/\s+/g, ' ');
    this.last = this.last.key === cacheKey ? { key: cacheKey, repeats: this.last.repeats + 1 } : { key: cacheKey, repeats: 1 };
    const cached = this.cache.get(cacheKey);
    if (cached) {
      if (this.last.repeats < this.limits.repeats) return cached;
      const result = await cached;
      return { ...result, stopRetry: true, notice: '同一请求已连续重复 ' + this.last.repeats + ' 次，结果不会变化。请换关键词或来源，或基于已核实内容作答。' };
    }
    if (this.failures[kind] >= this.limits.failures)
      return unavailable('来源已连续失败 ' + this.failures[kind] + ' 次，本轮停止此类检索。基于已核实来源作答并说明未能核实的部分；用户继续追问后会重新开始。', true);
    if (this.used[kind] >= this.limits.requests[kind] || this.attempts[kind] >= this.limits.attempts[kind])
      return unavailable('本轮此类检索已达上限（' + this.used[kind] + ' 次有效请求）。基于已核实来源作答并说明未能核实的部分；用户继续追问后会开启新额度。', true);
    this.attempts[kind]++; this.used[kind]++;
    const task = (async () => {
      try {
        const result = await operation();
        this.failures[kind] = 0; // the source answered, even if it found nothing
        if (isEmpty(kind, result)) { this.used[kind]--; return { status: 'empty', results: [], images: [], ...result, stopRetry: false }; }
        return result;
      } catch {
        this.used[kind]--; this.cache.delete(cacheKey); // allow a later retry of the same request
        const failures = ++this.failures[kind], stopRetry = failures >= this.limits.failures;
        return unavailable('来源连接失败（本轮连续第 ' + failures + ' 次）。' + (stopRetry ? '停止此类检索，基于已核实来源作答并说明限制。' : '可以换一个来源或稍后重试。'), stopRetry);
      }
    })();
    this.cache.set(cacheKey, task); return task;
  }
}

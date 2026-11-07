import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  faviconCandidates, noteFaviconError, noteFaviconLoad, resetFaviconCache, rowSiteUrl, rowSiteUrls, siteHost, siteKey, watchFavicon,
} from '../web/src/services/site-icon.mjs';

test('page URLs become a host, never the path or a full URL', () => {
  assert.equal(siteHost('https://vuejs.org/guide/introduction.html'), 'vuejs.org');
  assert.equal(siteHost('http://EN.Wikipedia.org/wiki/Favicon'), 'en.wikipedia.org');
  assert.equal(siteHost('https://github.com.'), 'github.com');
  for (const raw of ['', 'github.com', 'not a url', 'javascript:alert(1)', 'data:image/png,xx', 'file:///etc/passwd', 'https://[::1]/']) {
    assert.equal(siteHost(raw), '');
  }
});

test('favicon chain is the site file, then Google, then DuckDuckGo, using the host only', () => {
  const list = faviconCandidates(siteHost('https://User:secret@vuejs.org/guide?q=1'));
  assert.deepEqual(list, [
    'https://vuejs.org/favicon.ico',
    'https://www.google.com/s2/favicons?domain=vuejs.org&sz=32',
    'https://icons.duckduckgo.com/ip3/vuejs.org.ico',
  ]);
  assert.equal(list.some(item => item.includes('/api/image') || item.includes('guide') || item.includes('https%3A')), false);
  assert.deepEqual(faviconCandidates(''), []);
});

test('a failed candidate is skipped once per host and exhaustion stays cached', () => {
  resetFaviconCache();
  const host = 'vuejs.org';
  const seen = [];
  const stopA = watchFavicon(host, (state) => seen.push(['a', state.src, state.failed]));
  const stopB = watchFavicon(host, (state) => seen.push(['b', state.src, state.failed]));
  assert.equal(seen[0][1], 'https://vuejs.org/favicon.ico');
  assert.equal(seen[1][1], 'https://vuejs.org/favicon.ico');
  noteFaviconError(host, 'https://vuejs.org/favicon.ico');
  noteFaviconError(host, 'https://vuejs.org/favicon.ico');
  assert.equal(seen.at(-1)[1], 'https://www.google.com/s2/favicons?domain=vuejs.org&sz=32');
  noteFaviconLoad(host, 'https://www.google.com/s2/favicons?domain=vuejs.org&sz=32', { width: 32, height: 32 });
  noteFaviconError(host, 'https://www.google.com/s2/favicons?domain=vuejs.org&sz=32');
  assert.equal(seen.at(-1)[1], 'https://www.google.com/s2/favicons?domain=vuejs.org&sz=32');
  stopA(); stopB();

  resetFaviconCache();
  const list = faviconCandidates('missing.example');
  const stopMiss = watchFavicon('missing.example', () => {});
  for (const src of list) noteFaviconError('missing.example', src);
  stopMiss();
  let later;
  watchFavicon('missing.example', (state) => { later = state; });
  assert.deepEqual(later, { src: '', failed: true });
  noteFaviconError('missing.example', list[0]);
  assert.deepEqual(later, { src: '', failed: true });
});

test('Google’s 16×16 globe is a miss and does not fall through to another placeholder', () => {
  resetFaviconCache();
  const host = 'missing.example';
  watchFavicon(host, () => {});
  noteFaviconError(host, faviconCandidates(host)[0]);
  const view = noteFaviconLoad(host, faviconCandidates(host)[1], { width: 16, height: 16 });
  assert.deepEqual(view, { src: '', failed: true });
  assert.equal(noteFaviconLoad(host, faviconCandidates(host)[1], { width: 32, height: 32 }).failed, true);
});

test('web and search rows use a page URL; image search stays without a site', () => {
  assert.equal(rowSiteUrl({ name: 'web_fetch', args: { url: 'https://github.com/torvalds' } }), 'https://github.com/torvalds');
  assert.equal(rowSiteUrl({
    name: 'web_search',
    args: JSON.stringify({ query: 'favicon' }),
    result: JSON.stringify({ results: [{ title: 'Vue', url: 'https://vuejs.org/guide/' }, { title: 'MDN', url: 'https://developer.mozilla.org/en-US/docs/Web' }] }),
  }), 'https://vuejs.org/guide/');
  assert.equal(rowSiteUrl({ name: 'web_search', args: { query: 'cats' } }), '');
  assert.equal(rowSiteUrl({
    name: 'image_search',
    args: { query: 'mountain' },
    result: { results: [{ url: 'https://images.example/a.jpg', sourceUrl: 'https://example.com/photo' }] },
  }), '');
  assert.equal(rowSiteUrl({ name: 'read', args: { path: '/workspace/a.txt' } }), '');
});

test('a search row yields one URL per distinct result host, in rank order', () => {
  const block = {
    name: 'web_search',
    args: { query: '第二类曲线积分' },
    result: {
      results: [
        { url: 'https://zh.wikipedia.org/wiki/曲线积分' },
        { url: 'https://www.zhihu.com/question/1' },
        { url: 'https://zh.wikipedia.org/wiki/格林公式' },
        { url: 'https://mathworld.wolfram.com/LineIntegral.html' },
      ],
    },
  };
  assert.deepEqual(rowSiteUrls(block), [
    'https://zh.wikipedia.org/wiki/曲线积分',
    'https://www.zhihu.com/question/1',
    'https://mathworld.wolfram.com/LineIntegral.html',
  ]);
  assert.equal(rowSiteUrl(block), 'https://zh.wikipedia.org/wiki/曲线积分');
  // A fetch keeps its direct page first, then any pages its result mentions.
  assert.deepEqual(rowSiteUrls({ name: 'web_fetch', args: { url: 'https://example.com/a' }, result: { results: [{ url: 'https://cdn.example.net/b' }] } }),
    ['https://example.com/a', 'https://cdn.example.net/b']);
  assert.deepEqual(rowSiteUrls({ name: 'image_search', args: { query: 'x' } }), []);
  // www. and bare host deduplicate to a single siteKey so icon stacks never show duplicates.
  assert.equal(siteKey('https://www.news.cn/politics/2026'), 'news.cn');
  assert.equal(siteKey('https://news.cn/world/2026'), 'news.cn');
  assert.deepEqual(rowSiteUrls({
    name: 'web_search',
    args: { query: 'news' },
    result: {
      results: [
        { url: 'https://www.news.cn/politics/1.htm' },
        { url: 'https://news.cn/world/2.htm' },
        { url: 'https://m.thepaper.cn/newsDetail_1' },
        { url: 'https://www.thepaper.cn/newsDetail_2' },
      ],
    },
  }), [
    'https://www.news.cn/politics/1.htm',
    'https://m.thepaper.cn/newsDetail_1',
  ]);
});

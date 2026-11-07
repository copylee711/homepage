// Site icons load in the page, not through /api/image. That proxy only fetches
// <origin>/favicon.ico inside the sandbox (and the dev mock returns 404), so
// missing favicon files become the globe. The first candidate is
// https://<host>/favicon.ico. gateway.mjs img-src includes https:, so the page
// can request it directly; a miss still falls through Google, then DuckDuckGo.

const states = new Map();

export function siteHost(raw) {
  try {
    const site = new URL(String(raw || ''));
    if (site.protocol !== 'http:' && site.protocol !== 'https:') return '';
    const host = site.hostname.replace(/\.$/, '').toLowerCase();
    if (!host || host.includes(':') || host.includes('/') || host.includes('%')) return '';
    return host;
  } catch {
    return '';
  }
}

export function faviconCandidates(host) {
  if (!host) return [];
  const domain = encodeURIComponent(host);
  return [
    `https://${host}/favicon.ico`,
    `https://www.google.com/s2/favicons?domain=${domain}&sz=32`,
    `https://icons.duckduckgo.com/ip3/${domain}.ico`,
  ];
}

function readJson(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch { return null; }
}

function httpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim()) ? value.trim() : '';
}

// web_fetch carries the page on args.url. web_search only has a query; the
// pages are its ranked result list, so one icon per distinct result host.
// image_search has no single site.
export function rowSiteUrls(block) {
  const name = String(block?.name || '').toLowerCase();
  if (name !== 'web_fetch' && name !== 'fetch' && name !== 'web_search') return [];
  const args = readJson(block?.args) || {};
  const result = readJson(block?.result);
  const entries = Array.isArray(result?.results) && result.results.length ? result.results : result?.url ? [result] : [];
  const out = [];
  const add = value => {
    const page = httpUrl(value);
    const host = page ? siteHost(page) : '';
    if (!host || out.some(item => siteHost(item) === host)) return;
    out.push(page);
  };
  if (name !== 'web_search') add(args.url);
  for (const entry of entries) add(entry?.sourceUrl || entry?.url);
  if (!out.length) add(args.url);
  return out.slice(0, 8);
}

export function rowSiteUrl(block) {
  return rowSiteUrls(block)[0] || '';
}

function snapshot(state) {
  return { src: state.failed ? '' : state.src, failed: state.failed };
}

function emit(state) {
  const view = snapshot(state);
  for (const fn of state.listeners) fn(view);
}

function ensure(host) {
  let state = states.get(host);
  if (!state) {
    const list = faviconCandidates(host);
    state = { list, index: 0, src: list[0] || '', failed: list.length === 0, loaded: false, listeners: new Set() };
    states.set(host, state);
  }
  return state;
}

export function watchFavicon(host, fn) {
  if (!host) {
    fn({ src: '', failed: true });
    return () => {};
  }
  const state = ensure(host);
  state.listeners.add(fn);
  fn(snapshot(state));
  return () => state.listeners.delete(fn);
}

export function noteFaviconError(host, src) {
  const state = states.get(host);
  if (!state || state.failed || state.loaded || state.src !== src) return snapshot(state || { src: '', failed: true });
  if (state.index < state.list.length - 1) {
    state.index += 1;
    state.src = state.list[state.index];
  } else {
    state.src = '';
    state.failed = true;
  }
  emit(state);
  return snapshot(state);
}

// Unknown domains still "load": Google's sz=32 reply is a 16×16 globe PNG with
// HTTP 404, and Chrome fires load for that body. A real icon at this size is
// larger (the samples are 18, 32 or 64). Treat the 16×16 result as a miss and
// stop, instead of continuing to DuckDuckGo's own placeholder square.
export function isPlaceholderFavicon(src, info = {}) {
  const width = info.width || 0;
  const height = info.height || 0;
  return typeof src === 'string' && src.startsWith('https://www.google.com/s2/favicons?') && width === 16 && height === 16;
}

export function noteFaviconLoad(host, src, info = {}) {
  const state = states.get(host);
  if (!state || state.failed || state.src !== src) return snapshot(state || { src: '', failed: true });
  if (isPlaceholderFavicon(src, info)) {
    state.src = '';
    state.failed = true;
    emit(state);
    return snapshot(state);
  }
  state.loaded = true;
  emit(state);
  return snapshot(state);
}

export function resetFaviconCache() {
  states.clear();
}

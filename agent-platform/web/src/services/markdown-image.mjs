/* Choose a Markdown image URL and fall back when an https source fails.
   The renderer builds elements with the DOM API. Nothing parses the image tag
   as HTML, so there is no sanitizer pass that could drop referrerpolicy.
   Load errors are handled by a capturing listener on the wrapper, not an
   inline onerror attribute. */

import { isWsFilePath, safeHref } from './markdown-url.mjs';

const failures = new Map();

export function resetMarkdownImageFailures() {
  failures.clear();
}

export function markdownImageFailure(url) {
  return failures.get(url) || '';
}

export function noteMarkdownImageError(url, phase) {
  if (typeof url !== 'string' || !url) return 'placeholder';
  if (phase === 'proxy' || failures.get(url) === 'proxy') {
    failures.set(url, 'proxy');
    return 'placeholder';
  }
  failures.set(url, 'direct');
  return 'proxy';
}

export function clearMarkdownImageFailure(url) {
  failures.delete(url);
}

export function proxyImageUrl(safe) {
  return '/api/image?url=' + encodeURIComponent(safe);
}

export function workspaceImageUrl(raw, project = 'default') {
  const clean = String(raw).trim();
  const path = clean.startsWith('/workspace/') || clean.startsWith('workspace/')
    ? clean.replace(/^\/?workspace\//, '')
    : project + '/' + clean;
  return '/api/image?path=' + encodeURIComponent(path);
}

function publicHttpUrl(safe) {
  let url;
  try { url = new URL(safe); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol)) return null;
  const host = url.hostname;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || /^[\d.]+$/.test(host) || host.includes(':')) return null;
  return url;
}

/* failure is the cached stage for this URL: '' | 'direct' | 'proxy'.
   Omit it to read the shared cache. */
export function selectMarkdownImage(raw, project = 'default', failure) {
  if (isWsFilePath(raw)) return { kind: 'workspace', src: workspaceImageUrl(raw, project) };
  const safe = safeHref(raw);
  const url = safe ? publicHttpUrl(safe) : null;
  if (!url) return { kind: 'blocked', src: null };
  if (url.protocol === 'http:') return { kind: 'http', src: proxyImageUrl(safe) };
  const direct = url.href;
  const proxy = proxyImageUrl(direct);
  const stage = failure === undefined ? (failures.get(direct) || '') : failure;
  if (stage === 'proxy') return { kind: 'https', phase: 'placeholder', src: null, direct, proxy };
  if (stage === 'direct') return { kind: 'https', phase: 'proxy', src: proxy, direct, proxy };
  return { kind: 'https', phase: 'direct', src: direct, direct, proxy };
}

export function imageUrl(raw, project = 'default') {
  return selectMarkdownImage(raw, project).src;
}

function el(doc, tag, className, text) {
  const element = doc.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function makeImg(doc, label) {
  const img = el(doc, 'img');
  const alt = label || '图片';
  img.alt = alt;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  img.setAttribute('alt', alt);
  img.setAttribute('loading', 'lazy');
  img.setAttribute('decoding', 'async');
  img.setAttribute('referrerpolicy', 'no-referrer');
  return img;
}

function showImageFailure(doc, anchor, label) {
  anchor.classList.add('is-failed');
  anchor.removeAttribute('data-image-preview');
  anchor.setAttribute('aria-label', '重新加载图片：' + (label || '图片'));
  anchor.replaceChildren(el(doc, 'span', null, '图片加载失败 · 点击重试'));
}

function bindLegacyRetry(doc, anchor, img, src, label) {
  let retries = 0;
  anchor.addEventListener('error', (event) => {
    if (event.target !== img) return;
    if (retries < 2) {
      const attempt = ++retries;
      setTimeout(() => { if (anchor.isConnected) img.src = src + '&retry=' + attempt; }, attempt * 1200 + Math.random() * 600);
      return;
    }
    showImageFailure(doc, anchor, label);
  }, true);
  anchor.addEventListener('click', (event) => {
    if (!anchor.classList.contains('is-failed')) return;
    event.preventDefault();
    retries = 0;
    anchor.classList.remove('is-failed');
    anchor.dataset.imagePreview = src;
    anchor.setAttribute('aria-label', '放大图片：' + (label || '图片'));
    anchor.replaceChildren(img);
    img.src = src + '&retry=' + Date.now();
  });
}

function showHttps(doc, anchor, img, plan, label, phase) {
  if (phase === 'placeholder') {
    anchor.href = plan.direct;
    showImageFailure(doc, anchor, label);
    return;
  }
  const src = phase === 'proxy' ? plan.proxy : plan.direct;
  img.dataset.imageDirect = plan.direct;
  img.dataset.imageProxy = plan.proxy;
  img.dataset.imagePhase = phase === 'proxy' ? 'proxy' : 'direct';
  anchor.classList.remove('is-failed');
  anchor.href = src;
  anchor.dataset.imagePreview = src;
  anchor.setAttribute('aria-label', '放大图片：' + (label || '图片'));
  anchor.replaceChildren(img);
  img.src = src;
}

function bindHttps(doc, anchor, img, plan, label) {
  anchor.addEventListener('error', (event) => {
    if (event.target !== img || anchor.classList.contains('is-failed')) return;
    const phase = img.dataset.imagePhase === 'proxy' ? 'proxy' : 'direct';
    const next = noteMarkdownImageError(plan.direct, phase);
    showHttps(doc, anchor, img, plan, label, next === 'proxy' ? 'proxy' : 'placeholder');
  }, true);
  anchor.addEventListener('click', (event) => {
    if (!anchor.classList.contains('is-failed')) return;
    event.preventDefault();
    clearMarkdownImageFailure(plan.direct);
    showHttps(doc, anchor, img, plan, label, 'direct');
  });
  showHttps(doc, anchor, img, plan, label, plan.phase);
}

export function createMarkdownImage(doc, raw, label, project = 'default') {
  const plan = selectMarkdownImage(raw, project);
  if (plan.kind === 'blocked' || (plan.kind !== 'https' && !plan.src)) {
    return el(doc, 'span', 'md-blocked-link', label || '图片地址不可用');
  }
  const anchor = el(doc, 'a', 'md-image');
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  if (plan.kind === 'https') {
    bindHttps(doc, anchor, makeImg(doc, label), plan, label);
    return anchor;
  }
  const img = makeImg(doc, label);
  anchor.href = plan.src;
  anchor.dataset.imagePreview = plan.src;
  anchor.setAttribute('aria-label', '放大图片：' + (label || '图片'));
  bindLegacyRetry(doc, anchor, img, plan.src, label);
  anchor.append(img);
  img.src = plan.src;
  return anchor;
}

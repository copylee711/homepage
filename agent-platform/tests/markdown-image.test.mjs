import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  clearMarkdownImageFailure, createMarkdownImage, imageUrl, markdownImageFailure,
  noteMarkdownImageError, resetMarkdownImageFailures, selectMarkdownImage,
} from '../web/src/services/markdown-image.mjs';

const DIRECT = 'https://cdn.example/iris.png';
const OTHER = 'https://cdn.example/other.png';

function createDocument() {
  function createElement(tag) {
    const element = {
      tagName: tag.toUpperCase(),
      attrs: {},
      dataset: {},
      childNodes: [],
      parent: null,
      _listeners: [],
      textContent: '',
    };
    let className = '';
    element.classList = {
      add(token) {
        const parts = new Set(className.split(/\s+/).filter(Boolean));
        parts.add(token);
        className = [...parts].join(' ');
        element.attrs.class = className;
      },
      remove(token) {
        className = className.split(/\s+/).filter((part) => part && part !== token).join(' ');
        element.attrs.class = className;
      },
      contains(token) { return className.split(/\s+/).includes(token); },
    };
    Object.defineProperty(element, 'className', {
      get() { return className; },
      set(value) { className = String(value || ''); element.attrs.class = className; },
    });
    Object.defineProperty(element, 'isConnected', { get() { return Boolean(element.parent); } });
    element.setAttribute = (name, value) => { element.attrs[name] = String(value); };
    element.getAttribute = (name) => (Object.prototype.hasOwnProperty.call(element.attrs, name) ? element.attrs[name] : null);
    element.removeAttribute = (name) => {
      delete element.attrs[name];
      if (name === 'data-image-preview') delete element.dataset.imagePreview;
    };
    element.addEventListener = (type, fn, capture) => {
      element._listeners.push({ type, fn, capture: capture === true });
    };
    element.append = (...nodes) => {
      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        node.parent = element;
        element.childNodes.push(node);
      }
    };
    element.replaceChildren = (...nodes) => {
      for (const child of element.childNodes) child.parent = null;
      element.childNodes = [];
      element.append(...nodes);
    };
    return element;
  }
  return { createElement };
}

function fire(target, type) {
  const chain = [];
  for (let node = target; node; node = node.parent) chain.push(node);
  const event = { type, target, preventDefault() { this.defaultPrevented = true; } };
  for (const node of chain.reverse()) {
    for (const listener of node._listeners || []) {
      if (listener.type === type && listener.capture) listener.fn(event);
    }
  }
  for (const listener of target._listeners || []) {
    if (listener.type === type && !listener.capture) listener.fn(event);
  }
  return event;
}

function imgOf(anchor) {
  return anchor.childNodes.find((node) => node.tagName === 'IMG');
}

describe('markdown image urls', { concurrency: 1 }, () => {
  beforeEach(() => resetMarkdownImageFailures());

  test('https images use the source url; http, workspace, data and blob stay on the old path', () => {
    const https = selectMarkdownImage(DIRECT, 'demo');
    assert.equal(https.kind, 'https');
    assert.equal(https.phase, 'direct');
    assert.equal(https.src, DIRECT);
    assert.equal(https.proxy, '/api/image?url=' + encodeURIComponent(DIRECT));
    assert.equal(imageUrl(DIRECT, 'demo'), DIRECT);

    const http = selectMarkdownImage('http://cdn.example/a.png?x=1', 'demo');
    assert.equal(http.kind, 'http');
    assert.equal(http.src, '/api/image?url=' + encodeURIComponent('http://cdn.example/a.png?x=1'));
    assert.equal(http.src.includes(DIRECT) , false);

    assert.equal(selectMarkdownImage('shot.png', 'demo').src, '/api/image?path=' + encodeURIComponent('demo/shot.png'));
    assert.equal(selectMarkdownImage('./shot.png', 'demo').kind, 'workspace');
    assert.equal(selectMarkdownImage('/workspace/demo/shot.png').src, '/api/image?path=' + encodeURIComponent('demo/shot.png'));
    assert.equal(selectMarkdownImage('workspace/demo/shot.png').src, '/api/image?path=' + encodeURIComponent('demo/shot.png'));

    for (const raw of [
      'data:image/png;base64,aaaa',
      'blob:https://cdn.example/11111111-1111-4111-8111-111111111111',
      'javascript:alert(1)',
      'https://localhost/a.png',
      'https://files.local/a.png',
      'https://secret.internal/a.png',
      'https://127.0.0.1/a.png',
      'https://10.1.2.3/a.png',
      'http://127.0.0.1/a.png',
      'https://user:secret@cdn.example/a.png',
      'https://[::1]/a.png',
      'not a url',
    ]) {
      const plan = selectMarkdownImage(raw);
      assert.equal(plan.kind, 'blocked', raw);
      assert.equal(plan.src, null, raw);
    }
  });

  test('a failed https url is remembered and is not loaded again', () => {
    assert.equal(noteMarkdownImageError(DIRECT, 'direct'), 'proxy');
    assert.equal(noteMarkdownImageError(DIRECT, 'direct'), 'proxy');
    assert.equal(markdownImageFailure(DIRECT), 'direct');
    const proxy = selectMarkdownImage(DIRECT);
    assert.equal(proxy.phase, 'proxy');
    assert.equal(proxy.src, proxy.proxy);
    assert.equal(selectMarkdownImage(DIRECT, 'demo', '').phase, 'direct');

    assert.equal(noteMarkdownImageError(DIRECT, 'proxy'), 'placeholder');
    assert.equal(noteMarkdownImageError(DIRECT, 'direct'), 'placeholder');
    assert.equal(selectMarkdownImage(DIRECT).phase, 'placeholder');
    assert.equal(selectMarkdownImage(DIRECT).src, null);
    assert.equal(selectMarkdownImage(OTHER).phase, 'direct');

    clearMarkdownImageFailure(DIRECT);
    assert.equal(selectMarkdownImage(DIRECT).phase, 'direct');
    assert.equal(selectMarkdownImage(DIRECT, 'demo', 'proxy').phase, 'placeholder');
    assert.equal(markdownImageFailure(DIRECT), '');
  });

  test('the image element keeps referrerpolicy and falls back without an inline onerror', () => {
    const doc = createDocument();
    const anchor = createMarkdownImage(doc, DIRECT, '鸢尾', 'demo');
    const img = imgOf(anchor);
    assert.equal(img.getAttribute('referrerpolicy'), 'no-referrer');
    assert.equal(img.referrerPolicy, 'no-referrer');
    assert.equal(img.getAttribute('loading'), 'lazy');
    assert.equal(img.loading, 'lazy');
    assert.equal(img.getAttribute('onerror'), null);
    assert.equal(anchor.getAttribute('onerror'), null);
    assert.equal(img._listeners.some((listener) => listener.type === 'error'), false);
    assert.equal(anchor._listeners.some((listener) => listener.type === 'error' && listener.capture), true);
    assert.equal(img.src, DIRECT);
    assert.equal(img.dataset.imagePhase, 'direct');

    const scheduled = [];
    const originalTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms) => { scheduled.push({ fn, ms }); return 0; };
    try {
      fire(img, 'error');
      assert.equal(scheduled.length, 0);
    } finally {
      globalThis.setTimeout = originalTimeout;
    }
    assert.equal(img.src, '/api/image?url=' + encodeURIComponent(DIRECT));
    assert.equal(img.dataset.imagePhase, 'proxy');
    assert.equal(anchor.dataset.imagePreview, img.src);
    assert.equal(markdownImageFailure(DIRECT), 'direct');

    const second = createMarkdownImage(doc, DIRECT, '鸢尾', 'demo');
    assert.equal(imgOf(second).src, img.src);
    assert.equal(imgOf(second).dataset.imagePhase, 'proxy');

    fire(img, 'error');
    assert.equal(anchor.classList.contains('is-failed'), true);
    assert.equal(anchor.className.includes('md-image'), true);
    assert.equal(imgOf(anchor), undefined);
    assert.equal(anchor.childNodes[0].textContent, '图片加载失败 · 点击重试');
    assert.equal(anchor.dataset.imagePreview, undefined);
    assert.equal(markdownImageFailure(DIRECT), 'proxy');

    const cached = createMarkdownImage(doc, DIRECT, '鸢尾', 'demo');
    assert.equal(cached.classList.contains('is-failed'), true);
    assert.equal(imgOf(cached), undefined);
    assert.equal(selectMarkdownImage(OTHER).phase, 'direct');

    const click = fire(cached, 'click');
    assert.equal(click.defaultPrevented, true);
    assert.equal(imgOf(cached).src, DIRECT);
    assert.equal(imgOf(cached).dataset.imagePhase, 'direct');
    assert.equal(cached.classList.contains('is-failed'), false);
    assert.equal(markdownImageFailure(DIRECT), '');
  });

  test('http and workspace images keep the proxy url and the delayed retry', () => {
    const doc = createDocument();
    const http = createMarkdownImage(doc, 'http://cdn.example/a.png', '旧图', 'demo');
    const httpImg = imgOf(http);
    const httpSrc = '/api/image?url=' + encodeURIComponent('http://cdn.example/a.png');
    assert.equal(httpImg.src, httpSrc);
    assert.equal(httpImg.getAttribute('referrerpolicy'), 'no-referrer');
    assert.equal(httpImg.getAttribute('onerror'), null);
    assert.equal(httpImg.dataset.imageDirect, undefined);

    const workspace = createMarkdownImage(doc, '/workspace/demo/shot.png', '文件');
    assert.equal(imgOf(workspace).src, '/api/image?path=' + encodeURIComponent('demo/shot.png'));

    const blocked = createMarkdownImage(doc, 'data:image/png;base64,aaaa', '');
    assert.equal(blocked.tagName, 'SPAN');
    assert.equal(blocked.className, 'md-blocked-link');
    assert.equal(blocked.textContent, '图片地址不可用');
    assert.equal(createMarkdownImage(doc, 'blob:https://cdn.example/uuid', '').className, 'md-blocked-link');

    const scheduled = [];
    const originalTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms) => { scheduled.push({ fn, ms }); return 0; };
    try {
      fire(httpImg, 'error');
      fire(httpImg, 'error');
      assert.equal(httpImg.src, httpSrc);
      assert.equal(scheduled.length, 2);
      assert.ok(scheduled[0].ms >= 1200);
      http.parent = {};
      scheduled[0].fn();
      assert.equal(httpImg.src, httpSrc + '&retry=1');
      fire(httpImg, 'error');
    } finally {
      globalThis.setTimeout = originalTimeout;
    }
    assert.equal(http.classList.contains('is-failed'), true);
    assert.equal(http.childNodes[0].textContent, '图片加载失败 · 点击重试');
  });

  test('markdown rendering does not parse image html or attach an onerror attribute', () => {
    const root = new URL('../web/src/', import.meta.url);
    const markdown = readFileSync(new URL('services/markdown.js', root), 'utf8');
    const image = readFileSync(new URL('services/markdown-image.mjs', root), 'utf8');
    const view = readFileSync(new URL('components/MarkdownView.vue', root), 'utf8');
    assert.equal(markdown.includes('DOMPurify'), false);
    assert.equal(image.includes('DOMPurify'), false);
    assert.equal(view.includes('DOMPurify'), false);
    assert.equal(/\sonerror\s*=/.test(markdown + image + view), false);
    assert.match(markdown, /createMarkdownImage/);
    assert.match(image, /addEventListener\('error'/);
    assert.match(image, /referrerpolicy/);
  });
});

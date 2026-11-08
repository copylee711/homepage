// Runs inside the user's disposable browser container and drives one real
// Chromium page with Playwright. It talks to the host broker over
// newline-delimited JSON on stdin/stdout, so no port is ever exposed.
//
// The picture follows the approach used by noVNC-style remote desktops: the
// page pushes a frame whenever it actually changed (CDP screencast), each frame
// is acknowledged before the next one is produced, and input is applied the
// moment it arrives instead of being polled for.
//
// Host -> here:  {"id":7,"op":"goto","url":"https://example.com/"}
// Here -> host:  {"type":"result","id":7,"ok":true,"value":{...}}
//                {"type":"frame","seq":12,"mime":"image/jpeg","data":"<base64>"}
import { createHash } from 'node:crypto';

let chromium = null;
for (const candidate of ['playwright-core', '/usr/local/lib/node_modules/playwright-core/index.mjs']) {
  try { ({ chromium } = await import(candidate)); break; } catch {}
}

const QUALITY = 62;
const MAX_WIDTH = 1440;
const MAX_HEIGHT = 1000;
// Chromium keeps a few frames unacknowledged; acking about 60ms after arrival
// caps the stream near 16 fps, which is smooth on a page and cheap on one CPU.
const ACK_PACE_MS = 60;

let browser = null;
let context = null;
let page = null;
let cdp = null;
let viewport = { width: 1280, height: 800 };
let seq = 0;
let lastHash = '';
let closed = false;
let navigating = false;
let cachedTitle = '';
let ready = null;
const history = { stack: [], index: -1 };

function send(value) {
  return new Promise(resolve => {
    if (closed) return resolve();
    try {
      if (process.stdout.write(JSON.stringify(value) + '\n')) return resolve();
      process.stdout.once('drain', resolve);
    } catch { resolve(); }
  });
}

function reply(id, ok, value) {
  return send({ type: 'result', id, ok, ...(ok ? { value } : { error: value }) });
}

function fail(id, message) {
  return reply(id, false, String(message || '浏览器操作失败').slice(0, 500));
}

function cleanUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('请输入网址');
  if (text.length > 4000) throw new Error('网址过长');
  if (/^about:blank$/i.test(text)) return 'about:blank';
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : 'https://' + text;
  let url;
  try { url = new URL(withScheme); } catch { throw new Error('网址格式无效'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只支持 http 与 https 网页');
  if (url.username || url.password) throw new Error('网址不能包含账号密码');
  return url.href;
}

function pageUrl() {
  try { return page ? page.url() : ''; } catch { return ''; }
}

async function pageTitle() {
  try {
    cachedTitle = await Promise.race([page.title(), new Promise(r => setTimeout(() => r(''), 800))]) || '';
  } catch { cachedTitle = ''; }
  return cachedTitle;
}

function trackNavigation(url, mode) {
  if (!url || url === 'about:blank') return;
  if (mode === 'back') { history.index = Math.max(0, history.index - 1); return; }
  if (mode === 'forward') { history.index = Math.min(history.stack.length - 1, history.index + 1); return; }
  if (history.stack[history.index] === url) return;
  history.stack = history.stack.slice(0, history.index + 1);
  history.stack.push(url);
  if (history.stack.length > 60) history.stack.shift();
  history.index = history.stack.length - 1;
}

async function emitFrame(base64, width, height) {
  const hash = createHash('sha1').update(base64).digest('hex');
  if (hash === lastHash) return;
  lastHash = hash;
  seq += 1;
  await send({
    type: 'frame',
    seq,
    mime: 'image/jpeg',
    data: base64,
    url: pageUrl(),
    title: cachedTitle,
    width: width || viewport.width,
    height: height || viewport.height,
    canBack: history.index > 0,
    canForward: history.index >= 0 && history.index < history.stack.length - 1,
    loading: navigating,
  });
}

async function startScreencast() {
  const session = await context.newCDPSession(page);
  cdp = session;
  session.on('Page.screencastFrame', async params => {
    const arrivedAt = Date.now();
    const width = Number(params.metadata?.deviceWidth) || viewport.width;
    const height = Number(params.metadata?.deviceHeight) || viewport.height;
    try { await emitFrame(params.data, width, height); } catch {}
    setTimeout(() => {
      if (closed || session !== cdp) return;
      session.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
    }, Math.max(0, arrivedAt + ACK_PACE_MS - Date.now()));
  });
  await session.send('Page.enable');
  await session.send('Page.startScreencast', {
    format: 'jpeg',
    quality: QUALITY,
    maxWidth: Math.min(MAX_WIDTH, viewport.width),
    maxHeight: Math.min(MAX_HEIGHT, viewport.height),
    everyNthFrame: 1,
  });
}

async function restartScreencast() {
  try { await cdp?.send('Page.stopScreencast'); } catch {}
  try { await cdp?.detach(); } catch {}
  cdp = null;
  lastHash = '';
  try { await startScreencast(); } catch {}
}

function attach(target) {
  page = target;
  cachedTitle = '';
  target.on('framenavigated', frame => {
    if (frame === target.mainFrame()) { void pageTitle(); }
  });
  target.on('load', () => { navigating = false; void pageTitle(); });
  target.on('close', () => { if (page === target) { page = context?.pages()[0] || null; } });
  void restartScreencast();
}

async function navigate(url, waitUntil = 'domcontentloaded') {
  const target = cleanUrl(url);
  if (!page || page.isClosed()) throw new Error('浏览器页面已关闭');
  navigating = true;
  const response = await page.goto(target, { waitUntil, timeout: 30000 });
  trackNavigation(pageUrl(), 'goto');
  navigating = false;
  return { url: pageUrl(), title: await pageTitle(), status: response ? response.status() : 0 };
}

function keyName(raw) {
  const key = String(raw || '');
  if (key === ' ') return 'Space';
  if (key === 'Esc') return 'Escape';
  if (key === 'Del') return 'Delete';
  return key;
}

async function input(command) {
  const kind = String(command.kind || '');
  const x = Math.max(0, Math.min(viewport.width, Math.round(Number(command.x) || 0)));
  const y = Math.max(0, Math.min(viewport.height, Math.round(Number(command.y) || 0)));
  const button = ['right', 'middle'].includes(command.button) ? command.button : 'left';
  if (kind === 'mouse') {
    const action = String(command.action || '');
    if (action === 'move') {
      await page.mouse.move(x, y);
      return {};
    }
    if (action === 'down') {
      await page.mouse.move(x, y);
      await page.mouse.down({ button, clickCount: Math.max(1, Math.min(3, Number(command.clickCount) || 1)) });
      return {};
    }
    if (action === 'up') {
      await page.mouse.up({ button, clickCount: Math.max(1, Math.min(3, Number(command.clickCount) || 1)) });
      return {};
    }
    throw new Error('鼠标动作无效');
  }
  if (kind === 'click' || kind === 'dblclick') {
    await page.mouse.click(x, y, { button, clickCount: kind === 'dblclick' ? 2 : 1 });
    return {};
  }
  if (kind === 'wheel') {
    const dx = Math.max(-4000, Math.min(4000, Number(command.dx) || 0));
    const dy = Math.max(-4000, Math.min(4000, Number(command.dy) || 0));
    await page.mouse.move(x, y);
    await page.mouse.wheel(dx, dy);
    return {};
  }
  if (kind === 'text') {
    const text = String(command.text || '');
    if (!text) return {};
    if (text.length > 20000) throw new Error('输入内容过长');
    // Long blocks (pasted text) go in as one edit; typing keeps key events.
    if (text.length > 60) await page.keyboard.insertText(text);
    else await page.keyboard.type(text, { delay: 0 });
    return {};
  }
  if (kind === 'key') {
    const key = keyName(command.key);
    if (!key) return {};
    const action = String(command.action || 'press');
    const modifiers = Array.isArray(command.modifiers)
      ? command.modifiers.filter(m => ['Control', 'Shift', 'Alt', 'Meta'].includes(m)) : [];
    if (action === 'down' || action === 'up') {
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) {
        if (action === 'down') await page.keyboard.down(key); else await page.keyboard.up(key);
        return {};
      }
      for (const modifier of modifiers.slice().reverse()) await page.keyboard.down(modifier);
      try {
        if (action === 'down') await page.keyboard.down(key); else await page.keyboard.up(key);
      } finally {
        for (const modifier of modifiers) await page.keyboard.up(modifier);
      }
      return {};
    }
    for (const modifier of modifiers) await page.keyboard.down(modifier);
    try { await page.keyboard.press(key); } finally {
      for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier);
    }
    return {};
  }
  throw new Error('浏览器输入类型无效');
}

async function handle(command) {
  const op = String(command.op || '');
  if (op === 'state') {
    return { url: pageUrl(), title: await pageTitle(), width: viewport.width, height: viewport.height,
      canBack: history.index > 0, canForward: history.index >= 0 && history.index < history.stack.length - 1 };
  }
  if (op === 'goto' || op === 'open') return navigate(command.url);
  if (op === 'back') {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
    trackNavigation(pageUrl(), 'back');
    return { url: pageUrl(), title: await pageTitle() };
  }
  if (op === 'forward') {
    await page.goForward({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
    trackNavigation(pageUrl(), 'forward');
    return { url: pageUrl(), title: await pageTitle() };
  }
  if (op === 'reload') {
    navigating = true;
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
    navigating = false;
    return { url: pageUrl(), title: await pageTitle() };
  }
  if (op === 'resize') {
    viewport = {
      width: Math.max(320, Math.min(1920, Math.round(Number(command.width) || viewport.width))),
      height: Math.max(320, Math.min(1400, Math.round(Number(command.height) || viewport.height))),
    };
    await page.setViewportSize(viewport);
    await restartScreencast();
    return { width: viewport.width, height: viewport.height };
  }
  if (op === 'input') return input(command);
  if (op === 'text') {
    return { text: String(await page.evaluate(() => document.body?.innerText || '')).slice(0, 200000) };
  }
  throw new Error('浏览器操作无效');
}

async function start() {
  if (!chromium) {
    await send({ type: 'fatal', error: '浏览器组件不可用' });
    process.exit(3);
  }
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
  const args = [
    '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-breakpad',
    '--mute-audio', '--no-first-run', '--no-default-browser-check', '--disable-sync',
    '--disable-background-networking', '--disable-features=Translate,MediaRouter',
    '--renderer-process-limit=2', '--js-flags=--max-old-space-size=192',
    '--force-device-scale-factor=1', '--lang=zh-CN', '--hide-scrollbars=false',
  ];
  if (proxy) args.push('--proxy-server=' + proxy);
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args, timeout: 45000 });
  context = await browser.newContext({
    viewport, deviceScaleFactor: 1, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
    acceptDownloads: false, javaScriptEnabled: true,
  });
  context.on('page', target => { attach(target); });
  const first = await context.newPage();
  attach(first);
  await first.goto('about:blank');
  history.stack = [];
  history.index = -1;
  await send({ type: 'ready', width: viewport.width, height: viewport.height });
}

async function stop() {
  closed = true;
  try { await browser?.close(); } catch {}
  process.exit(0);
}

let buffer = '';
// Commands run strictly in order: a click followed by typing must never race,
// and a command that arrives while Chromium is still starting simply waits.
let queue = Promise.resolve();

function enqueue(command, id) {
  queue = queue.then(async () => {
    await ready;
    const value = await handle(command);
    await reply(id, true, value);
  }).catch(async error => {
    await fail(id, error?.message);
  });
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let command;
    try { command = JSON.parse(line); } catch { continue; }
    const id = Number(command.id) || 0;
    if (command.op === 'close') { void stop(); return; }
    if (!id) continue;
    enqueue(command, id);
  }
});
process.stdin.on('end', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });

ready = start().catch(async error => {
  await send({ type: 'fatal', error: String(error?.message || error).slice(0, 400) });
  process.exit(4);
});

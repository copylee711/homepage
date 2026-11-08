// Runs inside the user's disposable browser container. Plays the part the PTY
// helper plays for the terminal: it drives one real Chromium page with
// Playwright and talks to the host broker over newline-delimited JSON on
// stdin/stdout, so no network port is ever exposed to the sandbox.
//
// Host -> here:  {"id":7,"op":"goto","url":"https://example.com/"}
// Here -> host:  {"type":"result","id":7,"ok":true,"value":{...}}
//                {"type":"frame","seq":12,"data":"<base64 jpeg>","url":...,"title":...}
import { createHash } from 'node:crypto';

let chromium = null;
for (const candidate of ['playwright-core', '/usr/local/lib/node_modules/playwright-core/index.mjs']) {
  try { ({ chromium } = await import(candidate)); break; } catch {}
}

const JPEG_QUALITY = 58;
const FRAME_IDLE_MS = 2500;   // nobody is watching: keep the tab alive, cheaply
const FRAME_WATCH_MS = 300;   // a pane is polling: near live video
const WATCH_WINDOW_MS = 5000;

let browser = null;
let context = null;
let page = null;
let viewport = { width: 1280, height: 800 };
let seq = 0;
let lastHash = '';
let watchUntil = 0;
let closed = false;
let pendingFrame = false;
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

function isBlank(text) {
  return !text || text === 'about:blank';
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

// A polling pane keeps the frame loop at video rate; otherwise it drops back
// so an idle tab costs almost nothing.
function watch() {
  watchUntil = Date.now() + WATCH_WINDOW_MS;
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

function attach(target) {
  page = target;
  cachedTitle = '';
  target.on('framenavigated', frame => {
    if (frame === target.mainFrame()) { watch(); void pageTitle(); }
  });
  target.on('load', () => { navigating = false; watch(); void pageTitle(); });
  target.on('domcontentloaded', () => { watch(); });
  target.on('close', () => { watch(); });
  watch();
}

async function frameLoop() {
  while (!closed) {
    const interval = Date.now() < watchUntil ? FRAME_WATCH_MS : FRAME_IDLE_MS;
    await new Promise(resolve => setTimeout(resolve, interval));
    if (closed || !page || pendingFrame || page.isClosed()) continue;
    pendingFrame = true;
    try {
      const data = await page.screenshot({ type: 'jpeg', quality: JPEG_QUALITY, scale: 'css', timeout: 5000 });
      const hash = createHash('sha1').update(data).digest('hex');
      if (hash === lastHash) continue;
      lastHash = hash;
      seq += 1;
      await send({
        type: 'frame',
        seq,
        mime: 'image/jpeg',
        data: data.toString('base64'),
        url: pageUrl(),
        title: cachedTitle,
        width: viewport.width,
        height: viewport.height,
        canBack: history.index > 0,
        canForward: history.index >= 0 && history.index < history.stack.length - 1,
        loading: navigating,
      });
    } catch {
      // A screenshot during navigation or a closed tab is not an error.
    } finally {
      pendingFrame = false;
    }
  }
}

async function navigate(url, waitUntil = 'domcontentloaded') {
  const target = cleanUrl(url);
  if (!page || page.isClosed()) throw new Error('浏览器页面已关闭');
  navigating = true;
  watch();
  const response = await page.goto(target, { waitUntil, timeout: 30000 });
  trackNavigation(pageUrl(), 'goto');
  navigating = false;
  watch();
  return { url: pageUrl(), title: await pageTitle(), status: response ? response.status() : 0 };
}

async function handle(command) {
  const op = String(command.op || '');
  if (op === 'watch') { watch(); return { ok: true }; }
  if (op === 'state') {
    return { url: pageUrl(), title: await pageTitle(), width: viewport.width, height: viewport.height,
      canBack: history.index > 0, canForward: history.index >= 0 && history.index < history.stack.length - 1 };
  }
  if (op === 'goto' || op === 'open') return navigate(command.url);
  if (op === 'back') {
    watch();
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
    trackNavigation(pageUrl(), 'back');
    return { url: pageUrl(), title: await pageTitle() };
  }
  if (op === 'forward') {
    watch();
    await page.goForward({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
    trackNavigation(pageUrl(), 'forward');
    return { url: pageUrl(), title: await pageTitle() };
  }
  if (op === 'reload') {
    navigating = true;
    watch();
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
    watch();
    return { width: viewport.width, height: viewport.height };
  }
  if (op === 'input') return input(command);
  if (op === 'text') {
    // The readable text of the page, for the "复制正文" action.
    return { text: String(await page.evaluate(() => document.body?.innerText || '')).slice(0, 200000) };
  }
  throw new Error('浏览器操作无效');
}

async function input(command) {
  watch();
  const kind = String(command.kind || '');
  const x = Math.max(0, Math.min(viewport.width, Math.round(Number(command.x) || 0)));
  const y = Math.max(0, Math.min(viewport.height, Math.round(Number(command.y) || 0)));
  if (kind === 'click' || kind === 'dblclick') {
    await page.mouse.click(x, y, { button: 'left', clickCount: kind === 'dblclick' ? 2 : 1 });
    return { x, y };
  }
  if (kind === 'move') { await page.mouse.move(x, y); return { x, y }; }
  if (kind === 'wheel') {
    const dx = Math.max(-4000, Math.min(4000, Number(command.dx) || 0));
    const dy = Math.max(-4000, Math.min(4000, Number(command.dy) || 0));
    await page.mouse.move(x, y);
    await page.mouse.wheel(dx, dy);
    return { x, y };
  }
  if (kind === 'text') {
    const text = String(command.text || '');
    if (!text) return {};
    if (text.length > 20000) throw new Error('输入内容过长');
    await page.keyboard.type(text, { delay: 0 });
    return {};
  }
  if (kind === 'key') {
    const key = String(command.key || '').slice(0, 40);
    if (!key) return {};
    const modifiers = Array.isArray(command.modifiers)
      ? command.modifiers.filter(m => ['Control', 'Shift', 'Alt', 'Meta'].includes(m)) : [];
    for (const modifier of modifiers) await page.keyboard.down(modifier);
    try { await page.keyboard.press(key); } finally {
      for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier);
    }
    return {};
  }
  throw new Error('浏览器输入类型无效');
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
    '--force-device-scale-factor=1', '--lang=zh-CN',
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
  void frameLoop();
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

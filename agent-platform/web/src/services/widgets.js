import { post } from './api';
// Explicit, closed iris-widget fences are executable artifacts. Normal HTML
// fences remain code. Widgets have an opaque origin and no network privileges.
function cleanTitle(value) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 60); }
function widgetTitle(html, label) {
  if (cleanTitle(label)) return cleanTitle(label);
  try {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const title = cleanTitle(parsed.querySelector('title')?.textContent);
    if (title) return title;
    const heading = cleanTitle(parsed.querySelector('h1, h2, h3')?.textContent);
    if (heading) return heading;
  } catch {}
  return '交互组件';
}
// Content height comes from the widget document, not from the iframe viewport.
// Accept later reports so a chart can grow or shrink after it finishes drawing.
export function bindWidgetFrame(frame) {
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('scrolling', 'no');
  frame.dataset.widgetFrame = '';
  frame.style.overflow = 'hidden';
  if (!frame.style.height) frame.style.height = '120px';
  if (frame.dataset.widgetSized === '1') return frame;
  frame.dataset.widgetSized = '1';
  let applied = 0;
  const onHeight = (event) => {
    if (!frame.isConnected) { window.removeEventListener('message', onHeight); return; }
    if (event.source !== frame.contentWindow) return;
    const data = event.data;
    if (!data || data.type !== 'iris-widget-height') return;
    const height = Number(data.height);
    if (!Number.isFinite(height) || height < 32) return;
    const next = Math.min(4000, Math.ceil(height));
    if (Math.abs(next - applied) < 2) return;
    applied = next;
    frame.style.height = next + 'px';
  };
  window.addEventListener('message', onHeight);
  return frame;
}
export function widget(doc, html, label) {
  const wrap=doc.createElement('section');wrap.className='md-widget';wrap.dataset.widgetSource=html;
  const titleText=widgetTitle(html, label);
  const refresh=doc.createElement('button');refresh.type='button';refresh.className='md-widget-refresh';refresh.dataset.widgetAction='refresh';
  refresh.title='刷新组件';refresh.setAttribute('aria-label','刷新组件');
  refresh.innerHTML='<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 3v5h-5M3 21v-5h5M3 12a9 9 0 0 1 15.7-6L21 8M21 12a9 9 0 0 1-15.7 6L3 16"/></svg>';
  const frame=doc.createElement('iframe');frame.title=titleText;
  // A short placeholder. A tall floor becomes the document viewport, and a
  // scrollHeight report of that viewport then locks in a tall empty card.
  frame.style.height='120px';
  bindWidgetFrame(frame);
  wrap.append(refresh,frame);
  queueMicrotask(()=>{if(frame.isConnected)void runWidget(frame,html);});
  return wrap;
}
export function broadcastWidgetTheme(theme) {
  if (typeof document === 'undefined') return;
  const t = theme === 'dark' ? 'dark' : 'light';
  document.querySelectorAll('iframe[data-widget-frame]').forEach((frame) => {
    try { frame.contentWindow?.postMessage({ type: 'iris-theme', theme: t }, '*'); } catch {}
  });
}
export async function runWidget(frame,html) {
  try {
    const result=await post('/api/widgets',{html});
    if(!frame.isConnected)return;
    const theme=document.documentElement.dataset.theme==='dark'?'dark':'light';
    frame.src=result.url+(result.url.includes('?')?'&':'?')+'theme='+theme;
  }
  catch {const message=frame.ownerDocument.createElement('p');message.className='status-error';message.textContent='组件加载失败，请点击刷新。';frame.replaceWith(message);}
}

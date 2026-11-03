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
export function widget(doc, html, label) {
  const wrap=doc.createElement('section');wrap.className='md-widget';wrap.dataset.widgetSource=html;
  const heading=doc.createElement('div');heading.className='md-widget-head';
  const title=doc.createElement('strong');title.textContent=widgetTitle(html, label);heading.append(title);
  // One action only: reload the widget. A pause toggle was noise the widget
  // rarely needed, so it stays out of the card.
  const button=doc.createElement('button');button.type='button';button.className='md-widget-refresh';button.dataset.widgetAction='restart';button.title='重新运行';button.setAttribute('aria-label','重新运行');
  button.innerHTML='<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>';
  heading.append(button);
  const frame=doc.createElement('iframe');frame.title=title.textContent;frame.setAttribute('sandbox','allow-scripts');frame.setAttribute('referrerpolicy','no-referrer');frame.setAttribute('scrolling','no');
  frame.dataset.widgetFrame='';frame.style.height='360px';frame.style.overflow='hidden';
  // The widget document posts its own height so the card can grow to fit the
  // whole visual instead of trapping it behind an inner scrollbar.
  const onHeight=(event)=>{
    if(!frame.isConnected){window.removeEventListener('message',onHeight);return;}
    if(event.source!==frame.contentWindow)return;
    const data=event.data;
    if(!data||data.type!=='iris-widget-height')return;
    const height=Number(data.height);
    if(!Number.isFinite(height)||height<40)return;
    frame.style.height=Math.min(960,Math.ceil(height))+'px';
  };
  window.addEventListener('message',onHeight);
  wrap.append(heading,frame);
  queueMicrotask(()=>{if(frame.isConnected)void runWidget(frame,html);});
  return wrap;
}
export async function runWidget(frame,html) {
  try {
    const result=await post('/api/widgets',{html});
    if(!frame.isConnected)return;
    const theme=document.documentElement.dataset.theme==='dark'?'dark':'light';
    frame.src=result.url+(result.url.includes('?')?'&':'?')+'theme='+theme;
  }
  catch {const message=frame.ownerDocument.createElement('p');message.className='status-error';message.textContent='组件加载失败，请点击重新运行。';frame.replaceWith(message);}
}

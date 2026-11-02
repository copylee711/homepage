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
  for(const [action,text]of [['restart','重新运行'],['pause','暂停组件']]){const button=doc.createElement('button');button.type='button';button.className='btn btn-quiet btn-sm';button.dataset.widgetAction=action;button.textContent=text;heading.append(button);}
  const frame=doc.createElement('iframe');frame.title=title.textContent;frame.setAttribute('sandbox','allow-scripts');frame.setAttribute('referrerpolicy','no-referrer');
  frame.dataset.widgetFrame='';frame.style.height='480px';
  // The widget document posts its own height so the card can grow to fit the
  // whole visual instead of trapping it behind an inner scrollbar.
  const onHeight=(event)=>{
    if(!frame.isConnected){window.removeEventListener('message',onHeight);return;}
    if(event.source!==frame.contentWindow)return;
    const data=event.data;
    if(!data||data.type!=='iris-widget-height')return;
    const height=Number(data.height);
    if(!Number.isFinite(height)||height<40)return;
    frame.style.height=Math.min(4000,Math.ceil(height))+'px';
  };
  window.addEventListener('message',onHeight);
  wrap.append(heading,frame);
  queueMicrotask(()=>{if(frame.isConnected)void runWidget(frame,html);});
  const details=doc.createElement('details'),summary=doc.createElement('summary'),pre=doc.createElement('pre');summary.textContent='查看组件代码';pre.textContent=html;details.append(summary,pre);wrap.append(details);return wrap;
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

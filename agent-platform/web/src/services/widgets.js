import { post } from './api';
// Explicit, closed iris-widget fences are executable artifacts. Normal HTML
// fences remain code. Widgets have an opaque origin and no network privileges.
export function widget(doc, html) {
  const wrap=doc.createElement('section');wrap.className='md-widget';wrap.dataset.widgetSource=html;
  const heading=doc.createElement('div');heading.className='md-widget-head';
  const title=doc.createElement('strong');title.textContent='交互组件';heading.append(title);
  for(const [action,label]of [['restart','重新运行'],['pause','暂停组件']]){const button=doc.createElement('button');button.type='button';button.className='btn btn-quiet btn-sm';button.dataset.widgetAction=action;button.textContent=label;heading.append(button);}
  const frame=doc.createElement('iframe');frame.title='交互组件';frame.setAttribute('sandbox','allow-scripts');frame.setAttribute('referrerpolicy','no-referrer');
  frame.dataset.widgetFrame='';wrap.append(heading,frame);
  queueMicrotask(()=>{if(frame.isConnected)void runWidget(frame,html);});
  const details=doc.createElement('details'),summary=doc.createElement('summary'),pre=doc.createElement('pre');summary.textContent='查看组件代码';pre.textContent=html;details.append(summary,pre);wrap.append(details);return wrap;
}
export async function runWidget(frame,html) {
  try {const result=await post('/api/widgets',{html});if(frame.isConnected)frame.src=result.url;}
  catch {const message=frame.ownerDocument.createElement('p');message.className='status-error';message.textContent='组件加载失败，请点击重新运行。';frame.replaceWith(message);}
}

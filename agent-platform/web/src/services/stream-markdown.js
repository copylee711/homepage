import { renderMarkdown } from './markdown.js';

// Commit completed top-level blocks; keep the latest two blocks mutable so
// tables/lists and unfinished fences can still change shape as tokens arrive.
export function stableBoundary(source) {
  if (/^ {0,3}\[\^?\d+\]:/m.test(source)) return 0;
  const boundaries = []; let fence = null, math = false, offset = 0;
  for (const line of source.split('\n')) {
    const hit = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (hit) { if (!fence) fence = hit[1]; else if (hit[1][0] === fence[0] && hit[1].length >= fence.length) fence = null; }
    if (!fence && /^\s*\$\$\s*$/.test(line)) math = !math;
    offset += line.length + 1;
    if (!fence && !math && !line.trim()) boundaries.push(offset);
  }
  return boundaries.length > 2 ? boundaries.at(-3) : 0;
}
export function streamingMarkdown(host, doc = document, options = {}) {
  let stable = '', tail = doc.createElement('div'); tail.className = 'md-stream-tail'; host.append(tail);
  function keepWidgets(fragment) {
    const old=new Map(Array.from(tail.querySelectorAll('[data-widget-source]')).map(el=>[el.dataset.widgetSource,el]));
    for(const el of fragment.querySelectorAll('[data-widget-source]')) { const prior=old.get(el.dataset.widgetSource);if(prior){el.replaceWith(prior);old.delete(el.dataset.widgetSource);} }
    return fragment;
  }
  return (source, streaming, latestOptions=options) => {
    options=latestOptions;
    if (!streaming) { host.replaceChildren(renderMarkdown(source, doc, { ...options, sources: false })); stable = ''; tail = null; return; }
    if (!tail || !source.startsWith(stable)) { host.replaceChildren(); stable = ''; tail = doc.createElement('div'); tail.className = 'md-stream-tail'; host.append(tail); }
    const boundary = stableBoundary(source), prefix = source.slice(0, boundary);
    if (boundary > stable.length && prefix.startsWith(stable)) {
      host.insertBefore(keepWidgets(renderMarkdown(prefix.slice(stable.length), doc, { ...options, streaming: true })), tail); stable = prefix;
    }
    tail.replaceChildren(keepWidgets(renderMarkdown(source.slice(stable.length), doc, { ...options, streaming: true })));
  };
}

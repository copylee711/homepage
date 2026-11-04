/* Safe Markdown rendering. Builds DOM nodes only: untrusted HTML is never parsed or executed. */

import { splitInlineMath, extractDisplayMath, renderMathInto } from './math.js';
import { highlightInto } from './highlight.js';
import { widget } from './widgets.js';
import { isWsFilePath, safeHref } from './markdown-url.mjs';
import { createMarkdownImage, imageUrl as markdownImageUrl } from './markdown-image.mjs';

export { isWsFilePath, safeHref };

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+#.-]*)[^`~]*$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
const HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const UL = /^( {0,3})([-+*])[ \t]+(.*)$/;
const OL = /^( {0,3})(\d{1,9})[.)][ \t]+(.*)$/;
const SEPARATOR = /^ {0,3}\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/;

export function isDeliverableExt(path) {
  return /\.(docx?|xlsx?|pptx?|pdf|zip|tar|gz|7z|rar)$/i.test(String(path || '').trim());
}

function deliverableInfo(fileName) {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  switch (ext) {
    case 'docx':
    case 'doc':
      return { type: 'Word 文档', color: '#2b579a', bg: 'rgba(43,87,154,0.12)', badge: 'DOCX' };
    case 'xlsx':
    case 'xls':
    case 'csv':
      return { type: 'Excel 表格', color: '#217346', bg: 'rgba(33,115,70,0.12)', badge: 'XLSX' };
    case 'pptx':
    case 'ppt':
      return { type: 'PPT 演示文稿', color: '#d24726', bg: 'rgba(210,71,38,0.12)', badge: 'PPTX' };
    case 'pdf':
      return { type: 'PDF 文档', color: '#e23838', bg: 'rgba(226,56,56,0.12)', badge: 'PDF' };
    case 'zip':
    case 'tar':
    case 'gz':
    case '7z':
    case 'rar':
      return { type: '压缩文件包', color: '#7c3aed', bg: 'rgba(124,58,237,0.12)', badge: 'ZIP' };
    default:
      return { type: '交付文件', color: '#2563eb', bg: 'rgba(37,99,235,0.12)', badge: ext.toUpperCase() || 'FILE' };
  }
}

export function deliverableCard(doc, filePath, label) {
  const clean = filePath.trim();
  const name = label || clean.split('/').pop() || clean;
  const info = deliverableInfo(clean);
  const card = node(doc, 'div', 'md-deliverable-card');
  card.setAttribute('data-ws-file', clean);
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');
  card.setAttribute('title', `点击打开交付文件：${clean}`);

  const iconWrap = node(doc, 'div', 'md-deliverable-icon');
  iconWrap.style.setProperty('--card-color', info.color);
  iconWrap.style.setProperty('--card-bg', info.bg);
  iconWrap.innerHTML = `<span class="md-deliverable-badge">${info.badge}</span>`;

  const infoWrap = node(doc, 'div', 'md-deliverable-info');
  const title = node(doc, 'strong', 'md-deliverable-title', name);
  const subtitle = node(doc, 'span', 'md-deliverable-sub', info.type + ' · 可在工作区查看或下载');
  infoWrap.append(title, subtitle);

  const action = node(doc, 'span', 'md-deliverable-action');
  action.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>打开</span>';

  card.append(iconWrap, infoWrap, action);
  return card;
}

function node(doc, tag, className, text) {
  const element = doc.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function link(doc, href, label, className = '') {
  if (isWsFilePath(href)) {
    const cleanPath = href.trim();
    const anchor = node(doc, 'a', (className ? className + ' ' : '') + 'md-ws-link', label);
    anchor.setAttribute('href', '#');
    anchor.setAttribute('data-ws-file', cleanPath);
    anchor.setAttribute('title', `点击在工作区中定位并查看此文件：${cleanPath}`);
    return anchor;
  }
  const safe = safeHref(href);
  if (!safe) return node(doc, 'span', 'md-blocked-link', label);
  const anchor = node(doc, 'a', className || null, label);
  anchor.setAttribute('href', safe);
  anchor.setAttribute('target', '_blank');
  anchor.setAttribute('rel', 'noopener noreferrer');
  return anchor;
}
function text(doc, value) { return doc.createTextNode(String(value)); }

let activeProject='default';
export function imageUrl(raw, project = activeProject) {
  return markdownImageUrl(raw, project);
}
function image(doc, raw, label) {
  return createMarkdownImage(doc, raw, label, activeProject);
}

let activeFootnotes = null;
let activeStreaming = false;
export function renderMarkdown(value, doc = globalThis.document, options = {}) {
  const fragment = doc.createDocumentFragment();
  const { text: raw, sources } = splitSourceBlocks(value);
  const prevCitations=activeCitations;activeCitations=new Map((options.citations||(options.sources?collectSources(raw, [], sources):[])).map(s=>[s.url,s]));
  const prevFootnotes = activeFootnotes,prevProject=activeProject,prevStreaming=activeStreaming;activeProject=options.project||'default';activeStreaming=options.streaming===true;
  activeFootnotes = extractFootnoteMap(raw);
  const cleaned = activeFootnotes.size ? raw.replace(FOOTNOTE_DEF, '') : raw;
  const lines = cleaned.split('\n');
  // Pull `$$ … $$` display math out first so the block parser never splits a formula.
  const segments = extractDisplayMath(lines);
  for (const segment of segments) {
    if (segment.type === 'math') {
      const block = node(doc, 'div', 'md-math-block');
      renderMathInto(block, segment.tex, true);
      fragment.append(block);
    } else {
      renderBlocks(segment.lines, fragment, doc);
    }
  }
  // Optionally append a deduplicated sources list for citation markers.
  if (options.sources) {
    const sources = collectSources(String(value ?? ''));
    if (sources.length) fragment.append(sourcesList(sources, doc));
  }
  activeFootnotes = prevFootnotes;activeProject=prevProject;activeStreaming=prevStreaming;activeCitations=prevCitations;
  return fragment;
}

/* ---------- Citations (ported from dsh-better-display) ---------- */
const CITATION = /\[\[?\^?(\d{1,3})\]?\]\((https?:\/\/[^\s)]+)(?:\s+["']([^"']*)["'])?\)/g;
const FOOTNOTE_DEF = /^ {0,3}\[\^?(\d{1,3})\]:[ \t]*(https?:\/\/\S+)(?:[ \t]+["']?([^"'\n]*)["']?)?[ \t]*$/gm;
function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } }
function extractFootnoteMap(rawText) {
  const map = new Map();
  for (const m of String(rawText ?? '').matchAll(FOOTNOTE_DEF)) {
    const safe = safeHref(m[2]);
    if (safe) map.set(m[1], { label: m[1], url: safe, title: (m[3] || '').trim(), host: hostOf(safe) });
  }
  return map;
}
// A dedicated fence contributes to the source panel without emitting body links.
export function splitSourceBlocks(text) {
  const sources = [];
  const body = [];
  let fence;
  for (const line of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (match && match[1][0] === fence.marker[0] && match[1].length >= fence.marker.length && !match[2].trim()) {
        if (!fence.sources) body.push(line);
        fence = undefined;
      } else if (fence.sources) {
        const value = line.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, '');
        const link = linkAt(value, 0, false);
        if (link && link.end === value.length && sources.length < 30) sources.push({ url: link.href, title: link.label });
      } else body.push(line);
    } else if (match) {
      fence = { marker: match[1], sources: line.match(FENCE)?.[2]?.toLowerCase() === 'iris-sources' };
      if (!fence.sources) body.push(line);
    } else body.push(line);
  }
  return { text: body.join('\n'), sources };
}

export function collectSources(text, metadata = [], additional = []) {
  const byUrl=new Map(),used=new Set();let next=1;
  const str=String(text??'').replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[ \t]*$/gm,'').replace(/`[^`\n]*`/g,'');
  const footnotes=extractFootnoteMap(str),meta=new Map(metadata.map(item=>[safeHref(item.url),item]));
  function add(url,label,title){const safe=safeHref(url);if(!safe||!/^https?:/.test(safe))return;
    if(byUrl.has(safe))return;let number=/^\d{1,3}$/.test(label)?label:'';while(used.has(String(next)))next++;if(!number||used.has(number))number=String(next++);used.add(number);
    const extra=meta.get(safe)||{};byUrl.set(safe,{...extra,label:number,url:safe,title:extra.title||title||(!/^\d+$/.test(label)?label:'')||hostOf(safe),host:hostOf(safe)});
  }
  for(let i=0;i<str.length;i++){
    if(str[i]==='!'&&str[i+1]==='['){const image=linkAt(str,i,true);if(image)i=image.end-1;continue;}
    if(str[i]!=='[')continue;const found=linkAt(str,i,false);
    if(found){if(!/^(?:下载|download|打开工作区)/i.test(found.label))add(found.href,found.label.replace(/[\[\]^]/g,''),found.title);i=found.end-1;continue;}
    const match=str.slice(i).match(/^\[\^?(\d{1,3})\]/);if(match&&footnotes.has(match[1])){const item=footnotes.get(match[1]);add(item.url,item.label,item.title);}
  }
  for (const item of additional) {
    const url = safeHref(item.url);
    if (!url || !/^https?:/.test(url) || byUrl.has(url)) continue;
    const extra = meta.get(url) || {};
    byUrl.set(url, { ...extra, url, host: hostOf(url), title: item.title || extra.title || hostOf(url), label: '' });
  }
  return [...byUrl.values()];
}
export function citationBadge(doc,source){
  const badge=link(doc,source.url,source.label,'md-citation');badge.setAttribute('aria-label','引用 '+source.label+'：'+(source.title||source.host));badge.title=source.title||source.host;
  if(source.label.length===1)badge.classList.add('is-single');
  badge.title = source.title || source.host;
  const popup=node(doc,'span','md-citation-preview');popup.append(node(doc,'span','md-citation-host',source.host),node(doc,'strong',null,source.title||source.host));if(source.snippet)popup.append(node(doc,'span','md-citation-snippet',String(source.snippet).slice(0,240)));badge.append(popup);return badge;
}
let activeCitations=null;
function sourcesList(sources, doc) {
  const wrap = node(doc, 'div', 'md-sources');
  wrap.append(node(doc, 'span', 'md-sources-title', '来源'));
  for (const source of sources) {
    const pill = link(doc, source.url, '', 'md-source');
    pill.textContent = '';
    pill.append(node(doc, 'span', 'md-source-label', source.label));
    pill.append(node(doc, 'span', 'md-source-title', source.title || source.host));
    if (source.title && source.host && source.title !== source.host) {
      pill.append(node(doc, 'span', 'md-source-host', source.host));
    }
    wrap.append(pill);
  }
  return wrap;
}

// Unfinished iris-widget fences are still streaming in: show a quiet placeholder
// instead of dumping the half-written HTML source into the transcript.
function widgetPending(doc) {
  const wrap = node(doc, 'section', 'md-widget md-widget-pending');
  const head = node(doc, 'div', 'md-widget-head');
  head.append(node(doc, 'strong', null, '正在创建组件…'));
  wrap.append(head);
  return wrap;
}

function renderBlocks(lines, parent, doc) {
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[1], info = (fence[2] || '').trim(), language = info.toLowerCase(), body = [];
      index += 1;
      while (index < lines.length && !new RegExp('^ {0,3}' + marker[0] + '{' + marker.length + ',}[ \\t]*$').test(lines[index])) {
        body.push(lines[index]); index += 1;
      }
      const closed=index < lines.length;
      if (closed) index += 1;
      if (language === 'iris-sources') continue;
      if (/^iris-widget(\s|$)/.test(language)) {
        if (!closed) {
          if (activeStreaming) { parent.append(widgetPending(doc)); continue; }
        } else if (body.join('\n').length <= 64000) {
          parent.append(widget(doc, body.join('\n'), info.slice('iris-widget'.length).trim()));
          continue;
        }
      }
      parent.append(codeBlock(doc, body.join('\n'), language));
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      const level = Math.min(4, Math.max(1, heading[1].length));
      const element = node(doc, 'h' + level, 'md-heading');
      renderInline(heading[2].replace(/[ \t]+#+[ \t]*$/, ''), element, doc);
      parent.append(element);
      index += 1;
      continue;
    }
    if (HR.test(line)) { parent.append(node(doc, 'hr', 'md-rule')); index += 1; continue; }
    const quote = line.match(QUOTE);
    if (quote) {
      const inner = [];
      while (index < lines.length) {
        const match = lines[index].match(QUOTE);
        if (match) { inner.push(match[1]); index += 1; continue; }
        if (!lines[index].trim() && index + 1 < lines.length && QUOTE.test(lines[index + 1])) { inner.push(''); index += 1; continue; }
        break;
      }
      const block = node(doc, 'blockquote', 'md-quote');
      renderBlocks(inner, block, doc);
      parent.append(block);
      continue;
    }
    const tableEnd = tableAt(lines, index);
    if (tableEnd > index) {
      parent.append(renderTable(lines.slice(index, tableEnd), doc));
      index = tableEnd;
      continue;
    }
    if (UL.test(line) || OL.test(line)) {
      const parsed = renderList(lines, index, doc);
      parent.append(parsed.element); index = parsed.index;
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !blockStart(lines, index)) {
      paragraph.push(lines[index]); index += 1;
    }
    const element = node(doc, 'p', 'md-paragraph');
    renderInline(paragraph.join('\n'), element, doc);
    parent.append(element);
  }
}

function blockStart(lines, index) {
  const line = lines[index];
  if (FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || UL.test(line) || OL.test(line)) return true;
  return tableAt(lines, index) > index;
}

function codeBlock(doc, code, language) {
  const wrapper = node(doc, 'div', 'code-block');
  const head = node(doc, 'div', 'code-head');
  head.append(node(doc, 'span', 'code-language', language || '文本'));
  const copy = node(doc, 'button', 'code-copy', '复制');
  copy.setAttribute('type', 'button');
  copy.setAttribute('aria-label', '复制代码');
  copy.setAttribute('data-copy-code', '');
  head.append(copy);
  const pre = doc.createElement('pre');
  const body = doc.createElement('code');
  if (language) body.className = 'language-' + language.replace(/[^a-z0-9_-]/g, '');
  try { highlightInto(body, code, language); } catch { body.textContent = code; }
  pre.append(body);
  wrapper.append(head, pre);
  return wrapper;
}

function splitRow(line) {
  const value = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cell = '', escaped = false;
  for (const character of value) {
    if (escaped) { cell += character; escaped = false; continue; }
    if (character === '\\') { escaped = true; cell += character; continue; }
    if (character === '|') { cells.push(cell.trim()); cell = ''; continue; }
    cell += character;
  }
  cells.push(cell.trim());
  return cells;
}
function tableAt(lines, index) {
  if (index + 1 >= lines.length || !lines[index].includes('|') || !lines[index + 1].includes('-')) return 0;
  if (!SEPARATOR.test(lines[index + 1])) return 0;
  const header = splitRow(lines[index]), separator = splitRow(lines[index + 1]);
  if (header.length !== separator.length || !separator.every(cell => /^:?-{2,}:?$/.test(cell))) return 0;
  let end = index + 2;
  while (end < lines.length && lines[end].trim() && lines[end].includes('|')) end += 1;
  return end;
}
function alignment(cell) {
  if (cell.startsWith(':') && cell.endsWith(':')) return 'center';
  if (cell.endsWith(':')) return 'right';
  return '';
}
function renderTable(lines, doc) {
  const header = splitRow(lines[0]), separator = splitRow(lines[1]);
  const wrap = node(doc, 'div', 'md-table-wrap');
  const scroller = node(doc, 'div', 'md-table-scroll');
  const table = doc.createElement('table');
  const thead = doc.createElement('thead'), headRow = doc.createElement('tr');
  header.forEach((cell, index) => {
    const th = doc.createElement('th');
    const align = alignment(separator[index]);
    if (align) th.className = 'align-' + align;
    renderInline(cell, th, doc);
    headRow.append(th);
  });
  thead.append(headRow);
  const tbody = doc.createElement('tbody');
  for (const line of lines.slice(2)) {
    const row = doc.createElement('tr');
    splitRow(line).slice(0, header.length).forEach((cell, index) => {
      const td = doc.createElement('td');
      const align = alignment(separator[index]);
      if (align) td.className = 'align-' + align;
      renderInline(cell, td, doc);
      row.append(td);
    });
    tbody.append(row);
  }
  table.append(thead, tbody);
  const bar = node(doc, 'div', 'md-table-bar');
  const toggle = node(doc, 'button', 'md-table-wrap-toggle', '换行');
  toggle.type = 'button';
  toggle.dataset.tableWrap = '';
  toggle.setAttribute('aria-pressed', 'true');
  toggle.setAttribute('aria-label', '单元格换行');
  toggle.title = '切换换行/单行显示';
  bar.append(toggle);
  scroller.append(table);
  wrap.append(bar, scroller);
  return wrap;
}

function renderList(lines, index, doc) {
  const first = lines[index].match(OL) || lines[index].match(UL);
  const ordered = !!lines[index].match(OL);
  const baseIndent = first[1].length;
  const list = doc.createElement(ordered ? 'ol' : 'ul');
  if (ordered && Number(first[2]) !== 1) list.setAttribute('start', first[2]);
  while (index < lines.length) {
    const match = (ordered ? lines[index].match(OL) : lines[index].match(UL));
    if (!match || match[1].length !== baseIndent) break;
    const itemLines = [match[3]];
    index += 1;
    while (index < lines.length) {
      if (!lines[index].trim()) {
        const look = lines[index + 1] || '';
        if (look && (/^ {2,}\S/.test(look) || UL.test(look) || OL.test(look))) { itemLines.push(''); index += 1; continue; }
        break;
      }
      const indent = (lines[index].match(/^ */) || [''])[0].length;
      if (indent >= baseIndent + 2) {
        itemLines.push(lines[index].slice(Math.min(indent, baseIndent + 2)));
        index += 1; continue;
      }
      break;
    }
    const item = doc.createElement('li');
    const task = (itemLines[0] || '').match(/^\[([ xX])\][ \t]+(.*)$/);
    if (task) {
      const box = doc.createElement('input');
      box.setAttribute('type', 'checkbox');
      box.setAttribute('disabled', '');
      box.setAttribute('aria-label', task[1].toLowerCase() === 'x' ? '已完成' : '未完成');
      if (task[1].toLowerCase() === 'x') box.setAttribute('checked', '');
      box.className = 'md-task';
      item.className = 'md-task-item';
      item.append(box, text(doc, ' '));
      itemLines[0] = task[2];
    }
    renderBlocks(itemLines, item, doc);
    list.append(item);
    while (index < lines.length && !lines[index].trim()) {
      const next = lines[index + 1];
      if (!next) break;
      const nextMatch = (ordered ? next.match(OL) : next.match(UL));
      if (nextMatch && nextMatch[1].length === baseIndent) { index += 1; break; }
      break;
    }
  }
  return { element: list, index };
}

function escapedAt(value, index, marker) {
  let count = 0;
  for (let i = index - 1; i >= 0 && value[i] === '\\'; i -= 1) count += 1;
  return count % 2 === 1;
}
function findMarker(value, marker, from) {
  let position = value.indexOf(marker, from);
  while (position >= 0) {
    if (!escapedAt(value, position, marker)) return position;
    position = value.indexOf(marker, position + marker.length);
  }
  return -1;
}
function bracketEnd(value, start) {
  let depth = 0;
  for (let i = start; i < value.length; i += 1) {
    if (escapedAt(value, i)) continue;
    if (value[i] === '[') depth += 1;
    else if (value[i] === ']') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}
function linkAt(value, index, image) {
  const labelStart = index + (image ? 2 : 1);
  const close = bracketEnd(value, index + (image ? 1 : 0));
  if (close < 0 || value[close + 1] !== '(') return null;
  let depth = 0, end = -1;
  for (let i = close + 2; i < value.length; i += 1) {
    if (escapedAt(value, i)) continue;
    if (value[i] === '(') depth += 1;
    else if (value[i] === ')') { if (depth === 0) { end = i; break; } depth -= 1; }
  }
  if (end < 0) return null;
  const target = value.slice(close + 2, end).trim();
  const match = target.match(/^(\S+?)(?:[ \t]+["'](.*)["'])?$/);
  if (!match) return null;
  return { label: value.slice(labelStart, close), href: match[1], title: match[2], end: end + 1 };
}
function trimUrl(value) {
  let result = value.replace(/[.,;:!?]+$/, '');
  while (/[)\]}]$/.test(result)) result = result.slice(0, -1);
  return result;
}

export function renderInline(value, parent, doc = globalThis.document, depth = 0) {
  if (depth > 8) { parent.append(text(doc, value)); return; }
  let buffer = '';
  const flush = () => { if (buffer) { parent.append(text(doc, buffer)); buffer = ''; } };
  let index = 0;
  while (index < value.length) {
    const character = value[index];
    // LaTeX delimiters must be checked before Markdown backslash escapes, which
    // would otherwise swallow \( as a literal paren.
    if (value.startsWith('\\(', index)) {
      const end = value.indexOf('\\)', index + 2);
      if (end > index) { flush(); const span = node(doc, 'span', 'md-math-inline'); renderMathInto(span, value.slice(index + 2, end), false); parent.append(span); index = end + 2; continue; }
    }
    if (value.startsWith('\\[', index)) {
      const end = value.indexOf('\\]', index + 2);
      if (end > index) { flush(); const span = node(doc, 'span', 'md-math-inline'); renderMathInto(span, value.slice(index + 2, end), true); parent.append(span); index = end + 2; continue; }
    }
    if (character === '\\' && index + 1 < value.length && /[\\`*_{}[\]()#+\-.!|~>]/.test(value[index + 1])) {
      buffer += value[index + 1]; index += 2; continue;
    }
    if (character === '\n') { flush(); parent.append(doc.createElement('br')); index += 1; continue; }
    if (character === '`') {
      let size = 1;
      while (value[index + size] === '`') size += 1;
      const marker = '`'.repeat(size);
      const close = value.indexOf(marker, index + size);
      if (close >= 0) {
        let content = value.slice(index + size, close);
        if (content.startsWith(' ') && content.endsWith(' ') && content.trim()) content = content.slice(1, -1);
        flush();
        const codeElement = node(doc, 'code', 'md-code', content);
        if (isWsFilePath(content)) {
          codeElement.classList.add('md-ws-file');
          codeElement.setAttribute('data-ws-file', content.trim());
          codeElement.setAttribute('title', `点击在工作区中定位并查看此文件：${content.trim()}`);
        }
        parent.append(codeElement);
        index = close + size;
        continue;
      }
    }
    // Inline math $…$: opener followed by non-space, closer preceded by non-space, not a price.
    if (character === '$' && value[index + 1] !== '$' && value[index + 1] !== undefined && !/\s/.test(value[index + 1])) {
      let end = -1;
      for (let i = index + 1; i < value.length; i += 1) {
        if (value[i] === '\\') { i += 1; continue; }
        if (value[i] === '$' && !/\s/.test(value[i - 1]) && !/\d/.test(value[i + 1] || '')) { end = i; break; }
      }
      if (end > index + 1) {
        flush();
        const span = node(doc, 'span', 'md-math-inline');
        renderMathInto(span, value.slice(index + 1, end), false);
        parent.append(span); index = end + 1; continue;
      }
    }
    if (character === '!' && value[index + 1] === '[') {
      const found = linkAt(value, index, true);
      if (found) {
        flush();
        parent.append(image(doc, found.href, found.label));
        index = found.end; continue;
      }
    }
    if (character === '[') {
      const found = linkAt(value, index, false);
      if (found) {
        const citeMatch = found.label.trim().match(/^\[?\^?(\d{1,3})\]?$/);
        const source = activeCitations?.get(safeHref(found.href));
        if (citeMatch && safeHref(found.href) || source?.label && !parent.closest('td, th')) {
          // Strip redundant surrounding parentheses: e.g. `( [10](...) )` or `（[10](...)）`
          const leftParen = buffer.match(/[（(]\s*$/);
          if (leftParen) {
            buffer = buffer.slice(0, -leftParen[0].length);
          }
          flush();
          parent.append(citationBadge(doc, source || { label: citeMatch[1], url: found.href, title: found.title || hostOf(found.href), host: hostOf(found.href) }));
          let nextIndex = found.end;
          if (leftParen) {
            const after = value.slice(nextIndex).match(/^\s*[）)]/);
            if (after) nextIndex += after[0].length;
          }
          index = nextIndex;
          continue;
        } else if (isDeliverableExt(found.href) || isDeliverableExt(found.label)) {
          flush();
          parent.append(deliverableCard(doc, found.href, found.label));
          index = found.end;
          continue;
        } else {
          const anchor = link(doc, found.href, '', 'md-link');
          if (found.title) anchor.setAttribute('title', found.title);
          renderInline(found.label, anchor, doc, depth + 1);
          parent.append(anchor);
        }
        index = found.end; continue;
      }
      const fnMatch = value.slice(index).match(/^\[\^?(\d{1,3})\]/);
      if (fnMatch && activeFootnotes && activeFootnotes.has(fnMatch[1])) {
        const leftParen = buffer.match(/[（(]\s*$/);
        if (leftParen) {
          buffer = buffer.slice(0, -leftParen[0].length);
        }
        flush();
        const fn = activeFootnotes.get(fnMatch[1]);
        parent.append(citationBadge(doc, activeCitations?.get(fn.url) || fn));
        let nextIndex = index + fnMatch[0].length;
        if (leftParen) {
          const after = value.slice(nextIndex).match(/^\s*[）)]/);
          if (after) nextIndex += after[0].length;
        }
        index = nextIndex;
        continue;
      }
    }
    if (character === '<') {
      const auto = value.slice(index).match(/^<((?:https?:\/\/|mailto:)[^>\s]+)>/i);
      if (auto) {
        flush(); const anchor = link(doc, auto[1], auto[1], 'md-link');
        parent.append(anchor); index += auto[0].length; continue;
      }
    }
    const strong = value.startsWith('**', index) ? '**' : (value.startsWith('__', index) ? '__' : '');
    if (strong) {
      const close = findMarker(value, strong, index + 2);
      if (close > index + 2) {
        flush();
        const element = node(doc, 'strong');
        renderInline(value.slice(index + 2, close), element, doc, depth + 1);
        parent.append(element); index = close + 2; continue;
      }
    }
    if (value.startsWith('~~', index)) {
      const close = findMarker(value, '~~', index + 2);
      if (close > index + 2) {
        flush(); const element = node(doc, 'del');
        renderInline(value.slice(index + 2, close), element, doc, depth + 1);
        parent.append(element); index = close + 2; continue;
      }
    }
    if (character === '*' || character === '_') {
      const before = index > 0 ? value[index - 1] : '';
      if (character === '_' && /[A-Za-z0-9]/.test(before)) { buffer += character; index += 1; continue; }
      const close = findMarker(value, character, index + 1);
      if (close > index + 1 && !/\s/.test(value[index + 1]) && !/\s/.test(value[close - 1])) {
        flush(); const element = node(doc, 'em');
        renderInline(value.slice(index + 1, close), element, doc, depth + 1);
        parent.append(element); index = close + 1; continue;
      }
    }
    if (character === 'h' && (value.startsWith('http://', index) || value.startsWith('https://', index)) &&
      !/[A-Za-z0-9]/.test(index > 0 ? value[index - 1] : '')) {
      let end = index;
      while (end < value.length && !/[\s<>"']/.test(value[end])) end += 1;
      const href = trimUrl(value.slice(index, end));
      if (href.length > 8 && safeHref(href)) {
        flush(); parent.append(link(doc, href, href, 'md-link'));
        index += href.length; continue;
      }
    }
    buffer += character; index += 1;
  }
  flush();
}

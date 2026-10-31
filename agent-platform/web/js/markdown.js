/* Safe Markdown rendering. Builds DOM nodes only: untrusted HTML is never parsed or executed. */

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+#.-]*)[^`~]*$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
const HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const UL = /^( {0,3})([-+*])[ \t]+(.*)$/;
const OL = /^( {0,3})(\d{1,9})[.)][ \t]+(.*)$/;
const SEPARATOR = /^ {0,3}\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/;

export function safeHref(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  if (!/^(?:https?:\/\/|mailto:)/i.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) return null;
  if ((url.protocol === 'http:' || url.protocol === 'https:') && (url.username || url.password)) return null;
  if (url.protocol === 'mailto:' && /[?&](?:body|cc|bcc)=/i.test(value)) return null;
  return url.href;
}

function node(doc, tag, className, text) {
  const element = doc.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function link(doc, href, label, className = '') {
  const safe = safeHref(href);
  if (!safe) return node(doc, 'span', 'md-blocked-link', label);
  const anchor = node(doc, 'a', className || null, label);
  anchor.setAttribute('href', safe);
  anchor.setAttribute('target', '_blank');
  anchor.setAttribute('rel', 'noopener noreferrer');
  return anchor;
}
function text(doc, value) { return doc.createTextNode(String(value)); }

export function renderMarkdown(value, doc = globalThis.document) {
  const fragment = doc.createDocumentFragment();
  const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n');
  renderBlocks(lines, fragment, doc);
  return fragment;
}

function renderBlocks(lines, parent, doc) {
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[1], language = (fence[2] || '').toLowerCase(), body = [];
      index += 1;
      while (index < lines.length && !new RegExp('^ {0,3}' + marker[0] + '{' + marker.length + ',}[ \\t]*$').test(lines[index])) {
        body.push(lines[index]); index += 1;
      }
      if (index < lines.length) index += 1;
      parent.append(codeBlock(doc, body.join('\n'), language));
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      const level = Math.min(4, Math.max(2, heading[1].length));
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
  body.textContent = code;
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
  table.append(thead, tbody); wrap.append(table);
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
        flush(); parent.append(node(doc, 'code', 'md-code', content)); index = close + size; continue;
      }
    }
    if (character === '!' && value[index + 1] === '[') {
      const found = linkAt(value, index, true);
      if (found) {
        flush();
        parent.append(link(doc, found.href, '图片：' + (found.label || '预览'), 'md-image-link'));
        index = found.end; continue;
      }
    }
    if (character === '[') {
      const found = linkAt(value, index, false);
      if (found) {
        flush();
        const anchor = link(doc, found.href, '', 'md-link');
        renderInline(found.label, anchor, doc, depth + 1);
        parent.append(anchor); index = found.end; continue;
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

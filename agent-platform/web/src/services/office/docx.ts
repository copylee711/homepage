// DOCX preview: docx-preview draws the document, and we stamp every paragraph
// with a bookmark before rendering so the produced DOM can be mapped back to
// the source element the reader clicked.
import JSZip from 'jszip';
import { officeFormat, parseXml, tidy, type OfficeElementInfo, type OfficeRenderResult } from './shared';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const MARKER = 'irisel';

interface ParagraphMeta {
  style: string;
  topLevel: boolean;
  table: number;
  row: number;
  cell: number;
  ordinal: number;
}

function paragraphText(node: Element) {
  let text = '';
  for (const child of Array.from(node.getElementsByTagNameNS(W_NS, 't'))) text += child.textContent || '';
  return tidy(text, 2000);
}

/** Insert a unique bookmark at the start of every w:p so the renderer emits a
    span we can find again. The modified zip never leaves memory. */
function markParagraphs(xml: string) {
  let index = 0;
  const marked = xml.replace(/<w:p(?=[\s/>])[^>]*?(\/?)>/g, (match: string, selfClose: string) => {
    index += 1;
    const id = 900000 + index;
    const mark = `<w:bookmarkStart w:id="${id}" w:name="${MARKER}${index}"/><w:bookmarkEnd w:id="${id}"/>`;
    return selfClose ? `${match.slice(0, -2)}>${mark}</w:p>` : `${match}${mark}`;
  });
  return { xml: marked, count: index };
}

function collectMeta(xml: string) {
  const doc = parseXml(xml);
  const body = doc.getElementsByTagNameNS(W_NS, 'body')[0];
  const tables = Array.from(doc.getElementsByTagNameNS(W_NS, 'tbl'));
  const paragraphs = Array.from(doc.getElementsByTagNameNS(W_NS, 'p'));
  const metas: ParagraphMeta[] = [];
  let topOrdinal = 0;
  for (const paragraph of paragraphs) {
    const style = (paragraph.getElementsByTagNameNS(W_NS, 'pStyle')[0]?.getAttribute('w:val')
      || paragraph.getElementsByTagNameNS(W_NS, 'pStyle')[0]?.getAttribute('val')
      || '').trim();
    const table = (() => {
      let node: Element | null = paragraph.parentElement;
      while (node && node.localName !== 'tbl') node = node.parentElement;
      return node;
    })();
    const topLevel = !table && paragraph.parentElement === body;
    if (topLevel) topOrdinal += 1;
    let row = 0, cell = 0;
    if (table) {
      const tr = (() => {
        let node: Element | null = paragraph.parentElement;
        while (node && node.localName !== 'tr') node = node.parentElement;
        return node;
      })();
      if (tr) {
        row = Array.from(tr.parentElement?.children || []).filter(n => n.localName === 'tr').indexOf(tr) + 1;
        const tc = (() => {
          let node: Element | null = paragraph.parentElement;
          while (node && node.localName !== 'tc') node = node.parentElement;
          return node;
        })();
        if (tc) cell = Array.from(tc.parentElement?.children || []).filter(n => n.localName === 'tc').indexOf(tc) + 1;
      }
    }
    metas.push({ style, topLevel, table: table ? tables.indexOf(table) + 1 : 0, row, cell, ordinal: topOrdinal });
  }
  return metas;
}

function expandTableBorders(xml: string) {
  const doc = parseXml(xml);
  const children = (node: Element, name: string) =>
    Array.from(node.children).filter(child => child.namespaceURI === W_NS && child.localName === name);
  const child = (node: Element, name: string) => children(node, name)[0];
  const element = (name: string) => doc.createElementNS(W_NS, 'w:' + name);
  for (const table of Array.from(doc.getElementsByTagNameNS(W_NS, 'tbl'))) {
    const props = child(table, 'tblPr');
    const borders = props && child(props, 'tblBorders');
    if (!borders) continue;
    const rows = children(table, 'tr');
    rows.forEach((row, rowIndex) => {
      const cells = children(row, 'tc');
      cells.forEach((cell, cellIndex) => {
        const edges = [
          ['top', rowIndex === 0 ? 'top' : 'insideH'],
          ['bottom', rowIndex === rows.length - 1 ? 'bottom' : 'insideH'],
          ['left', cellIndex === 0 ? 'left' : 'insideV'],
          ['right', cellIndex === cells.length - 1 ? 'right' : 'insideV'],
        ];
        const cellProps = child(cell, 'tcPr') || cell.insertBefore(element('tcPr'), cell.firstChild);
        const cellBorders = child(cellProps, 'tcBorders') || cellProps.appendChild(element('tcBorders'));
        for (const [side, source] of edges) {
          const alias = side === 'left' ? 'start' : side === 'right' ? 'end' : side;
          if (child(cellBorders, side) || child(cellBorders, alias)) continue;
          const border = child(borders, source) || (side === source ? child(borders, alias) : undefined);
          if (!border) continue;
          const edge = element(side);
          for (const attr of Array.from(border.attributes)) edge.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
          cellBorders.appendChild(edge);
        }
      });
    });
    // docx-preview otherwise applies every outer edge to every cell.
    borders.remove();
  }
  return new XMLSerializer().serializeToString(doc);
}

export async function renderDocx(buffer: ArrayBuffer, host: HTMLElement): Promise<OfficeRenderResult> {
  const zip = await JSZip.loadAsync(buffer);
  const part = zip.file('word/document.xml');
  if (!part) throw new Error('不是有效的 Word 文档');
  const original = await part.async('string');
  const metas = collectMeta(original);
  const { xml } = markParagraphs(original);
  zip.file('word/document.xml', expandTableBorders(xml));
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });

  const { renderAsync } = await import('docx-preview');
  await renderAsync(blob, host, host, {
    className: 'iris-docx',
    inWrapper: true,
    breakPages: true,
    ignoreLastRenderedPageBreak: true,
    useBase64URL: true,
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true,
    renderEndnotes: true,
    ignoreWidth: false,
    ignoreHeight: false,
    hideWrapperOnPrint: true,
    experimental: false,
  });

  // docx-preview hangs list markers on a negative text-indent, which puts them
  // outside the paragraph box; move that indent into padding so the selection
  // outline encloses the bullet too, without moving any text.
  const lists = Array.from(host.querySelectorAll('p[class*="iris-docx-num-"]')) as HTMLElement[];
  const indents = lists.map(paragraph => {
    const style = getComputedStyle(paragraph);
    return { paragraph, margin: parseFloat(style.marginLeft) || 0, padding: parseFloat(style.paddingLeft) || 0 };
  });
  for (const item of indents) {
    if (item.margin <= 0) continue;
    item.paragraph.style.paddingLeft = (item.padding + item.margin) + 'px';
    item.paragraph.style.marginLeft = '0px';
  }

  const pages = Array.from(host.querySelectorAll('section.iris-docx'));
  const elements = new Map<string, OfficeElementInfo>();
  const renderedTables = new Map<number, Set<HTMLTableElement>>();
  const marks = host.querySelectorAll(`span[id^="${MARKER}"]`);
  for (const mark of Array.from(marks)) {
    const paragraph = mark.closest('p');
    if (!paragraph) continue;
    const index = Number(mark.id.slice(MARKER.length)) - 1;
    const meta = metas[index];
    if (!meta) continue;
    const table = paragraph.closest('table');
    if (table && meta.table) {
      if (!renderedTables.has(meta.table)) renderedTables.set(meta.table, new Set());
      renderedTables.get(meta.table)!.add(table);
    }
    const page = (() => {
      const section = paragraph.closest('section.iris-docx');
      const at = section ? pages.indexOf(section) : -1;
      return at >= 0 ? at + 1 : 0;
    })();
    paragraph.setAttribute('data-iris-page', String(page));
    if (paragraph.hasAttribute('data-iris-el')) continue;
    const id = 'docx-' + (index + 1);
    paragraph.setAttribute('data-iris-el', id);
    const text = tidy(paragraph.textContent || '', 2000);
    const heading = /^(heading|标题)\s*\d|^title$|^副标题|^subtitle/i.test(meta.style);
    const kind = meta.table ? '表格单元格' : heading ? '标题' : text ? '段落' : '空段落';
    const label = meta.table
      ? `表格 ${meta.table} · 第 ${meta.row} 行第 ${meta.cell} 列`
      : heading
        ? `标题「${text.slice(0, 16) || meta.style}」`
        : `第 ${meta.ordinal} 段`;
    const detail = [meta.style && `样式 ${meta.style}`, page > 0 && `第 ${page} 页`].filter(Boolean).join(' · ');
    elements.set(id, {
      id, label, kind, text, detail,
      page: page ? `第 ${page} 页` : undefined,
      value: text,
      edit: { kind: 'docx', paragraph: index + 1 },
    });
  }

  for (const [index, tables] of renderedTables) {
    const id = 'docx-table-' + index;
    const label = '表格 ' + index + '（整表）';
    const rows = [...tables].flatMap(table => Array.from(table.rows));
    const text = tidy(rows.map(row => Array.from(row.cells, cell => tidy(cell.textContent)).join(' ｜ ')).join('\n'));
    elements.set(id, { id, label, text, kind: '表格', detail: rows.length + ' 行 · 可引用整表样式' });
    for (const table of tables) {
      const button = host.ownerDocument.createElement('button');
      button.type = 'button';
      button.className = 'op-table-select';
      button.dataset.irisEl = id;
      button.textContent = '选中整表';
      button.setAttribute('aria-label', '选中表格 ' + index);
      button.setAttribute('aria-pressed', 'false');
      table.before(button);
    }
  }

  const notes: string[] = [];
  if (!elements.size) notes.push('这份文档没有可识别的段落。');
  return { format: 'docx', elements, pages: pages.length || 1, notes };
}

/** The page width in CSS pixels, used to fit the page to the pane. */
export function docxPageWidth(host: HTMLElement) {
  const page = host.querySelector('section.iris-docx') as HTMLElement | null;
  return page ? page.offsetWidth || page.getBoundingClientRect().width : 0;
}

export { officeFormat };

// XLSX preview: the workbook is parsed straight from its OOXML parts (sheet
// XML, shared strings, styles), then drawn as a windowed grid so a large sheet
// stays responsive. Every cell keeps its reference (B4) for quoting.
import JSZip from 'jszip';
import { parseXml, relAttr, type OfficeElementInfo, type OfficeRenderResult } from './shared';

const S_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const DEFAULT_ROW = 20;
const MAX_ROWS = 4000;
const MAX_COLS = 80;
const WINDOW = 60;

interface CellData {
  ref: string;
  row: number;
  col: number;
  value: string;
  raw: number | string | null;
  formula?: string;
  styleId: number;
  numeric: boolean;
}

interface SheetData {
  name: string;
  state: string;
  widths: number[];
  heights: Map<number, number>;
  rows: Map<number, Map<number, CellData>>;
  merges: { r1: number; c1: number; r2: number; c2: number }[];
  maxRow: number;
  maxCol: number;
}

export interface Workbook {
  sheets: SheetData[];
  /** CSS declarations for each resolved cell style, indexed by style id. */
  styles: string[];
  date1904: boolean;
}

const BUILTIN: Record<number, string> = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%',
  11: '0.00E+00', 12: '# ?/?', 13: '# ??/??', 14: 'm/d/yyyy', 15: 'd-mmm-yy', 16: 'd-mmm',
  17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss',
  22: 'm/d/yyyy h:mm', 37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)', 45: 'mm:ss',
  46: '[h]:mm:ss', 47: 'mmss.0', 48: '##0.0E+0', 49: '@',
};

const colName = (index: number) => {
  let name = '';
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};
const colIndex = (name: string) => {
  let index = 0;
  for (const ch of name.toUpperCase()) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index;
};
const refParts = (ref: string) => {
  const match = /^([A-Z]+)(\d+)$/i.exec(ref.trim());
  return match ? { col: colIndex(match[1]), row: Number(match[2]) } : null;
};

function normalizeTarget(base: string, target: string) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = (base + '/' + target).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

async function readRels(zip: JSZip, part: string) {
  const at = part.lastIndexOf('/');
  const dir = at >= 0 ? part.slice(0, at) : '';
  const name = part.slice(at + 1);
  const file = zip.file(`${dir ? dir + '/' : ''}_rels/${name}.rels`);
  const map = new Map<string, string>();
  if (!file) return map;
  const doc = parseXml(await file.async('string'));
  for (const rel of Array.from(doc.getElementsByTagName('Relationship'))) {
    const id = rel.getAttribute('Id') || '';
    const target = rel.getAttribute('Target') || '';
    if (!id || !target) continue;
    map.set(id, normalizeTarget(dir, target));
  }
  return map;
}

function themePalette(xml: string | null) {
  if (!xml) return [] as string[];
  const doc = parseXml(xml);
  const scheme = doc.getElementsByTagName('a:clrScheme')[0];
  if (!scheme) return [];
  const order = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
  const found = new Map<string, string>();
  for (const child of Array.from(scheme.children)) {
    const srgb = child.getElementsByTagName('a:srgbClr')[0]?.getAttribute('val');
    const sys = child.getElementsByTagName('a:sysClr')[0]?.getAttribute('lastClr');
    const value = srgb || sys;
    if (value) found.set(child.localName, '#' + value.slice(-6).toLowerCase());
  }
  return order.map(name => found.get(name) || '');
}

function applyTint(hex: string, tint: number) {
  if (!tint || !/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const rgb = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16));
  const out = rgb.map(channel => {
    const value = tint < 0 ? channel * (1 + tint) : channel + (255 - channel) * tint;
    return Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, '0');
  });
  return '#' + out.join('');
}

function xmlColor(node: Element | null | undefined, theme: string[]) {
  if (!node) return '';
  const rgb = node.getAttribute('rgb');
  if (rgb && /^[0-9a-f]{6,8}$/i.test(rgb)) return '#' + rgb.slice(-6).toLowerCase();
  const themeIndex = node.getAttribute('theme');
  if (themeIndex != null && themeIndex !== '') {
    const base = theme[Number(themeIndex)] || '';
    return applyTint(base, Number(node.getAttribute('tint') || 0));
  }
  return '';
}

interface ResolvedStyle { css: string; numFmtId: number }

function resolveStyles(xml: string | null, theme: string[], custom: Map<number, string>) {
  // Indexed by cellXfs position: a cell's `s` attribute is that index.
  const out: ResolvedStyle[] = [];
  if (!xml) return [{ css: '', numFmtId: 0 }];
  const doc = parseXml(xml);
  const fonts = Array.from(doc.getElementsByTagNameNS(S_NS, 'font')).map(font => {
    const decl: string[] = [];
    const name = font.getElementsByTagNameNS(S_NS, 'name')[0]?.getAttribute('val') || '';
    if (name) decl.push(`font-family:"${name.replace(/"/g, '')}",var(--office-font)`);
    const size = Number(font.getElementsByTagNameNS(S_NS, 'sz')[0]?.getAttribute('val') || 0);
    decl.push(`font-size:${size ? Math.round(size * 1.333) : 15}px`);
    if (font.getElementsByTagNameNS(S_NS, 'b')[0]?.getAttribute('val') !== '0' && font.getElementsByTagNameNS(S_NS, 'b').length) decl.push('font-weight:700');
    if (font.getElementsByTagNameNS(S_NS, 'i').length) decl.push('font-style:italic');
    if (font.getElementsByTagNameNS(S_NS, 'u').length) decl.push('text-decoration:underline');
    const color = xmlColor(font.getElementsByTagNameNS(S_NS, 'color')[0], theme);
    if (color) decl.push(`color:${color}`);
    return decl.join(';');
  });
  const fills = Array.from(doc.getElementsByTagNameNS(S_NS, 'fill')).map(fill => {
    const pattern = fill.getElementsByTagNameNS(S_NS, 'patternFill')[0];
    const fg = pattern ? xmlColor(pattern.getElementsByTagNameNS(S_NS, 'fgColor')[0], theme) : '';
    return fg && pattern?.getAttribute('patternType') === 'solid' ? `background:${fg}` : '';
  });
  const borders = Array.from(doc.getElementsByTagNameNS(S_NS, 'border')).map(border => {
    const decl: string[] = [];
    for (const side of ['left', 'right', 'top', 'bottom']) {
      const edge = border.getElementsByTagNameNS(S_NS, side)[0];
      const style = edge?.getAttribute('style');
      if (!style) continue;
      const color = xmlColor(edge.getElementsByTagNameNS(S_NS, 'color')[0], theme) || '#c9ced8';
      const width = style === 'thick' ? 2 : style === 'medium' ? 1.5 : 1;
      decl.push(`border-${side}:${width}px solid ${color}`);
    }
    return decl.join(';');
  });
  const xfs = Array.from(doc.getElementsByTagNameNS(S_NS, 'cellXfs')[0]?.children || []).filter(n => n.localName === 'xf');
  for (const xf of xfs) {
    const fontId = Number(xf.getAttribute('fontId') || 0);
    const fillId = Number(xf.getAttribute('fillId') || 0);
    const borderId = Number(xf.getAttribute('borderId') || 0);
    const numFmtId = Number(xf.getAttribute('numFmtId') || 0);
    const alignment = xf.getElementsByTagNameNS(S_NS, 'alignment')[0];
    const decl: string[] = [];
    if (fonts[fontId]) decl.push(fonts[fontId]);
    if (fills[fillId]) decl.push(fills[fillId]);
    if (borders[borderId]) decl.push(borders[borderId]);
    const horizontal = alignment?.getAttribute('horizontal');
    if (horizontal === 'center' || horizontal === 'centerContinuous') decl.push('text-align:center');
    else if (horizontal === 'right') decl.push('text-align:right');
    else if (horizontal === 'left') decl.push('text-align:left');
    const vertical = alignment?.getAttribute('vertical');
    if (vertical === 'center') decl.push('vertical-align:middle');
    else if (vertical === 'top') decl.push('vertical-align:top');
    if (alignment?.getAttribute('wrapText') === '1') decl.push('white-space:pre-wrap');
    out.push({ css: decl.filter(Boolean).join(';'), numFmtId });
  }
  void custom;
  return out;
}

function isDateFormat(code: string) {
  const stripped = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
  return /[ymdhs]/i.test(stripped) && !/[#0]/.test(stripped.replace(/[ymdhs]/gi, ''));
}

function pad(value: number, size = 2) {
  return String(value).padStart(size, '0');
}

function formatDate(date: Date, code: string) {
  const withTime = /[hs]/i.test(code);
  const month = date.getMonth() + 1, day = date.getDate(), year = date.getFullYear();
  if (withTime && !/[ymd]/i.test(code)) {
    const hour = date.getHours();
    return `${pad(code.includes('AM/PM') ? hour % 12 || 12 : hour)}:${pad(date.getMinutes())}${code.includes('ss') ? ':' + pad(date.getSeconds()) : ''}`;
  }
  if (/yyyy/i.test(code)) return `${year}-${pad(month)}-${pad(day)}`;
  if (/yy/i.test(code) && /mmm/i.test(code)) return `${pad(month)}月 ${String(year).slice(2)}`;
  return `${pad(month)}-${pad(day)}`;
}

function generalNumber(value: number) {
  if (!Number.isFinite(value)) return '#NUM!';
  if (Number.isInteger(value)) return String(value);
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 1e12 || abs < 1e-9)) return value.toExponential(4).replace('e', 'E');
  return String(Number(value.toPrecision(12)));
}

export function formatCellValue(raw: number | string | null, code: string, date1904 = false) {
  if (raw == null) return '';
  if (typeof raw !== 'number') return String(raw);
  const format = (code || 'General').split(';')[Math.max(0, raw < 0 ? 1 : 0)] || 'General';
  if (format === 'General' || format === '@') return generalNumber(raw);
  if (isDateFormat(format)) return formatDate(excelDate(raw, date1904), format);
  const percent = format.includes('%');
  const grouped = format.includes(',');
  // "¥#,##0" has no decimal part but still rounds to an integer.
  const decimals = /\.(0+)/.exec(format)?.[1].length ?? (/[#0]/.test(format) ? 0 : -1);
  let value = percent ? raw * 100 : raw;
  let text: string;
  if (decimals >= 0) {
    text = Math.abs(value).toFixed(decimals);
    if (grouped) {
      const [whole, fraction] = text.split('.');
      text = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? '.' + fraction : '');
    }
  } else {
    text = generalNumber(Math.abs(value));
  }
  if (value < 0) text = '-' + text;
  if (percent) text += '%';
  const symbol = /[¥$€£]/.exec(format)?.[0] || (/\\u00a5/.test(format) ? '¥' : '');
  if (symbol) text = symbol + text;
  return text;
}

function excelDate(serial: number, date1904: boolean) {
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const date = new Date(base + Math.round(serial * 86400000));
  return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds());
}

export async function parseXlsx(buffer: ArrayBuffer): Promise<Workbook> {
  const zip = await JSZip.loadAsync(buffer);
  const workbookPart = zip.file('xl/workbook.xml');
  if (!workbookPart) throw new Error('不是有效的 Excel 文件');
  const workbook = parseXml(await workbookPart.async('string'));
  const rels = await readRels(zip, 'xl/workbook.xml');
  const theme = themePalette(await zip.file('xl/theme/theme1.xml')?.async('string') || null);

  const custom = new Map<number, string>();
  const stylesXml = await zip.file('xl/styles.xml')?.async('string') || null;
  if (stylesXml) {
    const styles = parseXml(stylesXml);
    for (const fmt of Array.from(styles.getElementsByTagNameNS(S_NS, 'numFmt'))) {
      const id = Number(fmt.getAttribute('numFmtId') || 0);
      const code = fmt.getAttribute('formatCode') || '';
      if (id && code) custom.set(id, code);
    }
  }
  const styles = resolveStyles(stylesXml, theme, custom);

  const shared: string[] = [];
  const sharedFile = zip.file('xl/sharedStrings.xml');
  if (sharedFile) {
    const strings = parseXml(await sharedFile.async('string'));
    for (const si of Array.from(strings.getElementsByTagNameNS(S_NS, 'si'))) {
      shared.push(Array.from(si.getElementsByTagNameNS(S_NS, 't')).map(node => node.textContent || '').join(''));
    }
  }

  const date1904 = workbook.getElementsByTagNameNS(S_NS, 'workbookPr')[0]?.getAttribute('date1904') === '1';
  const sheets: SheetData[] = [];
  for (const sheet of Array.from(workbook.getElementsByTagNameNS(S_NS, 'sheet'))) {
    const state = sheet.getAttribute('state') || 'visible';
    if (state === 'veryHidden') continue;
    const name = sheet.getAttribute('name') || 'Sheet';
    const target = rels.get(relAttr(sheet));
    const file = target ? zip.file(target) : null;
    if (!file) { sheets.push({ name, state, widths: [], heights: new Map(), rows: new Map(), merges: [], maxRow: 0, maxCol: 0 }); continue; }
    const doc = parseXml(await file.async('string'));

    const widths: number[] = [];
    for (const col of Array.from(doc.getElementsByTagNameNS(S_NS, 'col'))) {
      if (col.getAttribute('hidden') === '1') continue;
      const min = Number(col.getAttribute('min') || 0);
      const max = Math.min(Number(col.getAttribute('max') || min), MAX_COLS);
      const width = Number(col.getAttribute('width') || 8.43);
      const px = Math.max(28, Math.min(420, Math.round(width * 7.2 + 8)));
      for (let at = min; at <= max && at <= MAX_COLS; at += 1) widths[at - 1] = px;
    }
    const heights = new Map<number, number>();
    const rows = new Map<number, Map<number, CellData>>();
    const merges: { r1: number; c1: number; r2: number; c2: number }[] = [];
    let maxRow = 0, maxCol = 0;

    for (const row of Array.from(doc.getElementsByTagNameNS(S_NS, 'row'))) {
      const rowIndex = Number(row.getAttribute('r') || 0);
      if (!rowIndex || rowIndex > MAX_ROWS) continue;
      if (row.getAttribute('hidden') === '1') continue;
      const height = Number(row.getAttribute('ht') || 0);
      if (height) heights.set(rowIndex, Math.max(16, Math.min(300, Math.round(height * 1.333))));
      const cells = new Map<number, CellData>();
      for (const cell of Array.from(row.getElementsByTagNameNS(S_NS, 'c'))) {
        const parts = refParts(cell.getAttribute('r') || '');
        if (!parts || parts.col > MAX_COLS) continue;
        const type = cell.getAttribute('t') || 'n';
        const styleId = Number(cell.getAttribute('s') || 0);
        const formula = cell.getElementsByTagNameNS(S_NS, 'f')[0]?.textContent || undefined;
        let raw: number | string | null = null;
        if (type === 'inlineStr') {
          raw = Array.from(cell.getElementsByTagNameNS(S_NS, 't')).map(node => node.textContent || '').join('');
        } else {
          const value = cell.getElementsByTagNameNS(S_NS, 'v')[0]?.textContent ?? '';
          if (type === 's') raw = shared[Number(value)] ?? '';
          else if (type === 'str') raw = value;
          else if (type === 'b') raw = value === '1' ? 'TRUE' : 'FALSE';
          else if (type === 'e') raw = value || '#ERROR!';
          else if (value === '') raw = null;
          else raw = Number(value);
        }
        const numFmtId = styles[styleId]?.numFmtId ?? 0;
        const code = custom.get(numFmtId) || BUILTIN[numFmtId] || 'General';
        const numeric = typeof raw === 'number';
        const text = formatCellValue(raw, code, date1904);
        cells.set(parts.col, {
          ref: cell.getAttribute('r') || `${colName(parts.col)}${rowIndex}`,
          row: rowIndex, col: parts.col, value: text, raw, formula, styleId, numeric,
        });
        maxRow = Math.max(maxRow, rowIndex);
        maxCol = Math.max(maxCol, parts.col);
      }
      if (cells.size) rows.set(rowIndex, cells);
    }

    const mergeNode = doc.getElementsByTagNameNS(S_NS, 'mergeCell');
    for (const merge of Array.from(mergeNode)) {
      const [from, to] = (merge.getAttribute('ref') || '').split(':');
      const a = refParts(from || ''), b = refParts(to || from || '');
      if (!a || !b) continue;
      merges.push({ r1: a.row, c1: a.col, r2: b.row, c2: b.col });
      maxRow = Math.max(maxRow, b.row);
      maxCol = Math.max(maxCol, b.col);
    }

    const dimension = doc.getElementsByTagNameNS(S_NS, 'dimension')[0]?.getAttribute('ref') || '';
    const dimEnd = refParts(dimension.split(':').pop() || '');
    if (dimEnd) { maxRow = Math.max(maxRow, Math.min(dimEnd.row, MAX_ROWS)); maxCol = Math.max(maxCol, Math.min(dimEnd.col, MAX_COLS)); }

    sheets.push({ name, state, widths, heights, rows, merges, maxRow: Math.min(maxRow, MAX_ROWS), maxCol: Math.min(maxCol, MAX_COLS) });
  }

  if (!sheets.length) throw new Error('这个工作簿没有可见的工作表');
  return { sheets, styles: styles.map(style => style.css), date1904 };
}

function styleClass(book: Workbook, styleId: number) {
  return book.styles[styleId] ? ` ixs-${styleId}` : '';
}

function checkedWidth(widths: number[], col: number) {
  return widths[col - 1] || 64;
}

function rowHeight(sheet: SheetData, row: number) {
  return sheet.heights.get(row) || DEFAULT_ROW;
}

function buildOffsets(sheet: SheetData) {
  const offsets = new Array(sheet.maxRow + 2);
  offsets[1] = 0;
  for (let row = 1; row <= sheet.maxRow; row += 1) offsets[row + 1] = offsets[row] + rowHeight(sheet, row);
  return offsets;
}

export function renderSheet(host: HTMLElement, book: Workbook, sheetIndex: number): OfficeRenderResult {
  const sheet = book.sheets[Math.max(0, Math.min(sheetIndex, book.sheets.length - 1))];
  host.replaceChildren();
  const elements = new Map<string, OfficeElementInfo>();
  const notes: string[] = [];
  const style = document.createElement('style');
  style.textContent = book.styles.map((css, id) => css ? `.ixs-${id}{${css}}` : '').join('');
  host.appendChild(style);

  const scroll = document.createElement('div');
  scroll.className = 'ix-scroll';
  const table = document.createElement('table');
  table.className = 'ix-table';
  const colspan = sheet.maxCol + 1;

  const colgroup = document.createElement('colgroup');
  const rowHead = document.createElement('col');
  rowHead.style.width = '46px';
  colgroup.appendChild(rowHead);
  for (let col = 1; col <= sheet.maxCol; col += 1) {
    const node = document.createElement('col');
    node.style.width = checkedWidth(sheet.widths, col) + 'px';
    colgroup.appendChild(node);
  }
  table.appendChild(colgroup);

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headRow.appendChild(document.createElement('th'));
  for (let col = 1; col <= sheet.maxCol; col += 1) {
    const th = document.createElement('th');
    th.className = 'ix-colhead';
    th.textContent = colName(col);
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  table.appendChild(tbody);
  scroll.appendChild(table);
  host.appendChild(scroll);

  const spans = new Map<string, { rowspan: number; colspan: number }>();
  const covered = new Set<string>();
  for (const merge of sheet.merges) {
    spans.set(`${merge.r1}:${merge.c1}`, { rowspan: merge.r2 - merge.r1 + 1, colspan: merge.c2 - merge.c1 + 1 });
    for (let row = merge.r1; row <= merge.r2; row += 1) {
      for (let col = merge.c1; col <= merge.c2; col += 1) {
        if (row !== merge.r1 || col !== merge.c1) covered.add(`${row}:${col}`);
      }
    }
  }

  const offsets = buildOffsets(sheet);
  const total = offsets[sheet.maxRow + 1] || 0;

  const makeCell = (row: number, col: number) => {
    const cell = sheet.rows.get(row)?.get(col);
    const ref = `${colName(col)}${row}`;
    const id = `xlsx-${sheetIndex}-${ref}`;
    const td = document.createElement('td');
    td.dataset.irisEl = id;
    td.dataset.ref = ref;
    td.className = 'ix-cell' + styleClass(book, cell?.styleId || 0);
    if (cell?.numeric) td.classList.add('is-number');
    td.textContent = cell?.value || '';
    if (cell) {
      td.title = cell.formula ? `=${cell.formula.replace(/^=/, '')}` : cell.value;
      const detail = cell.formula ? `公式 =${cell.formula.replace(/^=/, '')}` : '';
      elements.set(id, {
        id,
        label: `${sheet.name}!${ref}`,
        kind: '单元格',
        text: cell.value || (cell.formula ? `=${cell.formula}` : ''),
        detail: [detail, cell.numeric ? '数值' : '文本'].filter(Boolean).join(' · '),
        page: sheet.name,
        value: cell.raw == null ? '' : String(cell.raw),
        edit: { kind: 'xlsx', sheet: sheet.name, ref },
      });
    } else {
      elements.set(id, {
        id, label: `${sheet.name}!${ref}`, kind: '单元格', text: '', detail: '空单元格', page: sheet.name,
        value: '',
        edit: { kind: 'xlsx', sheet: sheet.name, ref },
      });
    }
    return td;
  };

  const renderWindow = (start: number, end: number) => {
    tbody.replaceChildren();
    const before = document.createElement('tr');
    before.className = 'ix-spacer';
    const beforeCell = document.createElement('td');
    beforeCell.colSpan = colspan;
    beforeCell.style.height = (offsets[start] || 0) + 'px';
    before.appendChild(beforeCell);
    if (start > 1) tbody.appendChild(before);

    for (let row = start; row <= end; row += 1) {
      const tr = document.createElement('tr');
      tr.style.height = rowHeight(sheet, row) + 'px';
      const head = document.createElement('th');
      head.className = 'ix-rownum';
      head.textContent = String(row);
      tr.appendChild(head);
      for (let col = 1; col <= sheet.maxCol; col += 1) {
        if (covered.has(`${row}:${col}`)) continue;
        const td = makeCell(row, col);
        const span = spans.get(`${row}:${col}`);
        if (span && span.rowspan + row - 1 <= end) {
          td.rowSpan = span.rowspan;
          td.colSpan = span.colspan;
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }

    const after = document.createElement('tr');
    after.className = 'ix-spacer';
    const afterCell = document.createElement('td');
    afterCell.colSpan = colspan;
    afterCell.style.height = Math.max(0, total - (offsets[end + 1] || total)) + 'px';
    after.appendChild(afterCell);
    if (end < sheet.maxRow) tbody.appendChild(after);
  };

  const windowStart = (scrollTop: number) => {
    let low = 1, high = Math.max(1, sheet.maxRow);
    while (low < high) {
      const mid = (low + high) >> 1;
      if (offsets[mid + 1] <= scrollTop) low = mid + 1;
      else high = mid;
    }
    return low;
  };

  let lastStart = -1;
  const paint = () => {
    const start = Math.max(1, windowStart(scroll.scrollTop) - 4);
    if (start === lastStart) return;
    lastStart = start;
    const end = Math.min(sheet.maxRow, start + WINDOW);
    renderWindow(start, end);
  };
  renderWindow(1, Math.min(sheet.maxRow, WINDOW));
  lastStart = 1;
  scroll.addEventListener('scroll', paint, { passive: true });

  if (sheet.state === 'hidden') notes.push('这个工作表在原文件里是隐藏的。');
  if (sheet.maxRow >= MAX_ROWS) notes.push(`仅预览前 ${MAX_ROWS} 行。`);
  if (sheet.maxCol >= MAX_COLS) notes.push(`仅预览前 ${MAX_COLS} 列。`);
  return { format: 'xlsx', elements, pages: book.sheets.length, notes };
}

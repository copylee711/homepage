// Shared shapes for the Office preview renderers. Each renderer turns a file
// into DOM inside a host element and returns an index of the selectable
// elements it produced, keyed by the `data-iris-el` id it stamped on the node.

export type OfficeFormat = 'docx' | 'xlsx' | 'pptx';

export interface OfficeElementInfo {
  /** Id stamped on the rendered node; also the key in the element map. */
  id: string;
  /** Short human label shown in the selection bar and the composer chip. */
  label: string;
  /** Element category: 段落 / 标题 / 表格单元格 / 工作表 / 文本框 / 图片 … */
  kind: string;
  /** The element's text, which is what the agent receives. */
  text: string;
  /** Style, formula or position hint shown under the label. */
  detail?: string;
  /** Which page / slide / sheet the element belongs to. */
  page?: string;
  /** Raw value used when the reader edits the element (display text may be formatted). */
  value?: string;
  /** Where a reader edit is written back: paragraph N, sheet!ref, slide N shape M. */
  edit?: { kind: 'docx' | 'xlsx' | 'pptx'; paragraph?: number; sheet?: string; ref?: string; slide?: number; shape?: number };
}

export interface OfficeRenderResult {
  format: OfficeFormat;
  elements: Map<string, OfficeElementInfo>;
  /** Page, slide or sheet count. */
  pages: number;
  notes?: string[];
}

export function officeFormat(name: string): OfficeFormat | null {
  const ext = (String(name || '').split('.').pop() || '').toLowerCase();
  if (ext === 'docx') return 'docx';
  if (ext === 'xlsx' || ext === 'xlsm') return 'xlsx';
  if (ext === 'pptx' || ext === 'potx') return 'pptx';
  return null;
}

export function officeLabel(name: string): string {
  const format = officeFormat(name);
  if (format === 'docx') return 'Word 文档';
  if (format === 'xlsx') return 'Excel 表格';
  if (format === 'pptx') return 'PowerPoint 演示文稿';
  return 'Office 文档';
}

/** Squash a run of whitespace the way a reader would see it. */
export function tidy(value: string | null | undefined, limit = 4000) {
  const text = String(value || '').replace(/ /g, ' ').replace(/ /g, ' ').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}

export function localName(node: Element) {
  return node.localName || node.nodeName.replace(/^.*:/, '');
}

export function childrenNamed(node: Element, ns: string, name: string): Element[] {
  const out: Element[] = [];
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 1 && (child as Element).localName === name && (!ns || (child as Element).namespaceURI === ns)) out.push(child as Element);
  }
  return out;
}

export function firstNamed(node: Element | null | undefined, ns: string, name: string): Element | null {
  if (!node) return null;
  return childrenNamed(node, ns, name)[0] || null;
}

export function parseXml(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('文档 XML 无法解析');
  return doc;
}

/** r:id / r:embed style attributes, which DOMParser exposes by qualified name. */
export function relAttr(node: Element | null | undefined, name = 'id') {
  if (!node) return '';
  return node.getAttribute('r:' + name) || node.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', name) || '';
}

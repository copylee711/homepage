// PPTX preview: slides are parsed from PresentationML and drawn as positioned
// HTML. Placeholder geometry is inherited from the slide layout and master the
// way PowerPoint does it, so a typical deck lands in the right place.
import JSZip from 'jszip';
import { childrenNamed, firstNamed, parseXml, relAttr, tidy, type OfficeElementInfo, type OfficeRenderResult } from './shared';

const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const EMU = 9525; // 1 CSS pixel at 96 dpi

interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  size?: number;
  color?: string;
}

interface Para {
  align: string;
  level: number;
  runs: Run[];
  bullet: boolean;
}

interface TableCell {
  text: string;
  colspan: number;
  fill?: string;
  bold?: boolean;
  align?: string;
  /** Run size in points, before the slide is scaled to the pane. */
  size?: number;
}

interface Box {
  x: number; y: number; w: number; h: number;
}

interface Shape {
  kind: 'text' | 'image' | 'table' | 'shape';
  box: Box;
  fill?: string;
  line?: string;
  rounded?: boolean;
  anchor?: string;
  paras?: Para[];
  src?: string;
  table?: { cols: number[]; rows: { height: number; cells: TableCell[] }[] };
  text: string;
  label: string;
  selectable: boolean;
  id: string;
}

export interface PptxSlide {
  width: number;
  height: number;
  background: string;
  shapes: Shape[];
}

export interface PptxDeck {
  slides: PptxSlide[];
  revoke: () => void;
}

interface PlaceholderDefault {
  box?: Box;
  size?: number;
  anchor?: string;
}

const px = (emu: number) => Math.round(emu / EMU);

function attrSize(node: Element | null) {
  const value = Number(node?.getAttribute('sz') || 0);
  return value ? value / 100 : 0;
}

function solidColor(node: Element | null | undefined): string {
  if (!node) return '';
  const srgb = node.getElementsByTagName('a:srgbClr')[0]?.getAttribute('val');
  if (srgb) return '#' + srgb.slice(-6).toLowerCase();
  const preset = node.getElementsByTagName('a:prstClr')[0]?.getAttribute('val');
  if (preset === 'black') return '#000000';
  if (preset === 'white') return '#ffffff';
  return '';
}

function shapeFill(spPr: Element | null) {
  if (!spPr) return '';
  const solid = firstNamed(spPr, A_NS, 'solidFill');
  if (solid) return solidColor(solid);
  return '';
}

function xmlBox(xfrm: Element | null): Box | undefined {
  if (!xfrm) return undefined;
  const off = firstNamed(xfrm, A_NS, 'off');
  const ext = firstNamed(xfrm, A_NS, 'ext');
  if (!off || !ext) return undefined;
  return {
    x: px(Number(off.getAttribute('x') || 0)),
    y: px(Number(off.getAttribute('y') || 0)),
    w: px(Number(ext.getAttribute('cx') || 0)),
    h: px(Number(ext.getAttribute('cy') || 0)),
  };
}

function phKey(shape: Element) {
  const ph = shape.getElementsByTagName('p:ph')[0];
  if (!ph) return '';
  return ph.getAttribute('idx') != null ? 'idx:' + ph.getAttribute('idx') : 'type:' + (ph.getAttribute('type') || 'body');
}

function phType(shape: Element) {
  return shape.getElementsByTagName('p:ph')[0]?.getAttribute('type') || '';
}

function placeholderDefaults(doc: Document | null): Map<string, PlaceholderDefault> {
  const map = new Map<string, PlaceholderDefault>();
  if (!doc) return map;
  for (const shape of Array.from(doc.getElementsByTagName('p:sp'))) {
    const key = phKey(shape);
    if (!key) continue;
    const box = xmlBox(firstNamed(firstNamed(shape, P_NS, 'spPr'), A_NS, 'xfrm'));
    const bodyPr = firstNamed(firstNamed(shape, P_NS, 'txBody'), A_NS, 'bodyPr');
    const lst = firstNamed(firstNamed(shape, P_NS, 'txBody'), A_NS, 'lstStyle');
    const size = attrSize(firstNamed(firstNamed(lst, A_NS, 'lvl1pPr'), A_NS, 'defRPr'))
      || attrSize(shape.getElementsByTagName('a:defRPr')[0]);
    map.set(key, { box, size: size || undefined, anchor: bodyPr?.getAttribute('anchor') || undefined });
  }
  return map;
}

function parseParagraphs(txBody: Element | null, fallbackSize: number, defaultAlign = 'l', defaultBullet = false): Para[] {
  if (!txBody) return [];
  const out: Para[] = [];
  for (const paragraph of childrenNamed(txBody, A_NS, 'p')) {
    const pPr = firstNamed(paragraph, A_NS, 'pPr');
    const level = Number(pPr?.getAttribute('lvl') || 0);
    const bullet = !!(pPr && (firstNamed(pPr, A_NS, 'buChar') || firstNamed(pPr, A_NS, 'buAutoNum')));
    const runs: Run[] = [];
    for (const child of Array.from(paragraph.children)) {
      if (child.localName === 'r' || child.localName === 'fld') {
        const rPr = firstNamed(child as Element, A_NS, 'rPr');
        const color = solidColor(firstNamed(rPr, A_NS, 'solidFill'));
        runs.push({
          text: firstNamed(child as Element, A_NS, 't')?.textContent || '',
          bold: rPr?.getAttribute('b') === '1',
          italic: rPr?.getAttribute('i') === '1',
          underline: rPr?.getAttribute('u') === 'sng',
          size: attrSize(rPr) || fallbackSize,
          color: color || undefined,
        });
      } else if (child.localName === 'br') {
        runs.push({ text: '\n' });
      }
    }
    out.push({
      align: pPr?.getAttribute('algn') || defaultAlign,
      level,
      runs,
      bullet: bullet || (defaultBullet && !(pPr && firstNamed(pPr, A_NS, 'buNone'))),
    });
  }
  return out;
}

const paraText = (paras: Para[]) => tidy(paras.map(para => para.runs.map(run => run.text).join('')).join('\n'), 2000);

function tableCellText(cell: Element) {
  return Array.from(cell.getElementsByTagName('a:p')).map(paragraph =>
    Array.from(paragraph.getElementsByTagName('a:t')).map(node => node.textContent || '').join('')).join('\n').trim();
}

export async function parsePptx(buffer: ArrayBuffer): Promise<PptxDeck> {
  const zip = await JSZip.loadAsync(buffer);
  const presentationPart = zip.file('ppt/presentation.xml');
  if (!presentationPart) throw new Error('不是有效的 PowerPoint 文件');
  const presentation = parseXml(await presentationPart.async('string'));
  const size = presentation.getElementsByTagName('p:sldSz')[0];
  const width = size ? px(Number(size.getAttribute('cx') || 12192000)) : 1280;
  const height = size ? px(Number(size.getAttribute('cy') || 6858000)) : 720;

  const rels = new Map<string, string>();
  const relFile = zip.file('ppt/_rels/presentation.xml.rels');
  if (relFile) {
    const relDoc = parseXml(await relFile.async('string'));
    for (const rel of Array.from(relDoc.getElementsByTagName('Relationship'))) {
      const target = (rel.getAttribute('Target') || '').replace(/^\.\.\//, '').replace(/^\//, '');
      rels.set(rel.getAttribute('Id') || '', target.startsWith('ppt/') ? target : 'ppt/' + target);
    }
  }

  const layoutCache = new Map<string, Map<string, PlaceholderDefault>>();
  const masterCache = new Map<string, Map<string, PlaceholderDefault>>();
  const readDoc = async (path: string) => {
    const file = zip.file(path);
    return file ? parseXml(await file.async('string')) : null;
  };

  const layoutFor = async (slidePath: string) => {
    const at = slidePath.lastIndexOf('/');
    const relFile = zip.file(`${slidePath.slice(0, at)}/_rels/${slidePath.slice(at + 1)}.rels`);
    if (!relFile) return { layout: null as Document | null, master: null as Document | null };
    const doc = parseXml(await relFile.async('string'));
    let layoutPath = '', masterPath = '';
    for (const rel of Array.from(doc.getElementsByTagName('Relationship'))) {
      const type = rel.getAttribute('Type') || '';
      const target = (rel.getAttribute('Target') || '').replace(/\.\.\//g, '');
      if (type.endsWith('/slideLayout')) layoutPath = 'ppt/' + target;
      if (type.endsWith('/slideMaster')) masterPath = 'ppt/' + target;
    }
    const layout = layoutPath ? await readDoc(layoutPath) : null;
    let master: Document | null = null;
    if (!masterPath && layoutPath) {
      const at2 = layoutPath.lastIndexOf('/');
      const rel2 = zip.file(`${layoutPath.slice(0, at2)}/_rels/${layoutPath.slice(at2 + 1)}.rels`);
      if (rel2) {
        const doc2 = parseXml(await rel2.async('string'));
        for (const rel of Array.from(doc2.getElementsByTagName('Relationship'))) {
          if ((rel.getAttribute('Type') || '').endsWith('/slideMaster')) masterPath = 'ppt/' + (rel.getAttribute('Target') || '').replace(/\.\.\//g, '');
        }
      }
    }
    if (masterPath) master = await readDoc(masterPath);
    return { layout, master };
  };

  const urls: string[] = [];
  const slides: PptxSlide[] = [];
  const ids = Array.from(presentation.getElementsByTagName('p:sldId'));
  let slideIndex = 0;
  for (const id of ids) {
    slideIndex += 1;
    const path = rels.get(relAttr(id));
    const doc = path ? await readDoc(path) : null;
    if (!doc || !path) continue;
    const { layout, master } = await layoutFor(path);
    const layoutDefaults = (() => {
      const key = path + '|layout';
      if (!layoutCache.has(key)) layoutCache.set(key, placeholderDefaults(layout));
      return layoutCache.get(key)!;
    })();
    const masterKey = path + '|master';
    if (!masterCache.has(masterKey)) masterCache.set(masterKey, placeholderDefaults(master));
    const masterDefaults = masterCache.get(masterKey)!;

    const bg = firstNamed(firstNamed(doc.getElementsByTagName('p:cSld')[0], P_NS, 'bg'), P_NS, 'bgPr');
    const background = solidColor(firstNamed(bg, A_NS, 'solidFill')) || '#ffffff';

    const shapes: Shape[] = [];
    let shapeIndex = 0;

    const relsForSlide = new Map<string, string>();
    {
      const at = path.lastIndexOf('/');
      const relFile = zip.file(`${path.slice(0, at)}/_rels/${path.slice(at + 1)}.rels`);
      if (relFile) {
        const relDoc = parseXml(await relFile.async('string'));
        for (const rel of Array.from(relDoc.getElementsByTagName('Relationship'))) {
          const target = (rel.getAttribute('Target') || '').replace(/\.\.\//g, '');
          relsForSlide.set(rel.getAttribute('Id') || '', target.startsWith('ppt/') ? target : 'ppt/' + target);
        }
      }
    }

    const slideMedia = new Map<string, string>();
    for (const [rid, target] of relsForSlide) {
      if (!/\.(png|jpe?g|gif|svg|webp|bmp)$/i.test(target)) continue;
      const file = zip.file(target);
      if (!file) continue;
      const bytes = await file.async('uint8array');
      const ext = (target.split('.').pop() || 'png').toLowerCase();
      const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/png';
      const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mime }));
      urls.push(url);
      slideMedia.set(rid, url);
    }

    const walk = (container: Element, originX: number, originY: number, kx: number, ky: number) => {
      for (const node of Array.from(container.children)) {
        if (node.localName === 'grpSp') {
          const grp = firstNamed(firstNamed(node, P_NS, 'grpSpPr'), A_NS, 'xfrm');
          const off = firstNamed(grp, A_NS, 'off');
          const ext = firstNamed(grp, A_NS, 'ext');
          const chOff = firstNamed(grp, A_NS, 'chOff');
          const chExt = firstNamed(grp, A_NS, 'chExt');
          const gx = px(Number(off?.getAttribute('x') || 0)), gy = px(Number(off?.getAttribute('y') || 0));
          const gw = px(Number(ext?.getAttribute('cx') || 0)), gh = px(Number(ext?.getAttribute('cy') || 0));
          const cx = px(Number(chExt?.getAttribute('cx') || 0)) || gw || 1;
          const cy = px(Number(chExt?.getAttribute('cy') || 0)) || gh || 1;
          const cox = px(Number(chOff?.getAttribute('x') || 0)), coy = px(Number(chOff?.getAttribute('y') || 0));
          const rx = (gw || cx) / cx, ry = (gh || cy) / cy;
          walk(node, originX + kx * (gx - cox * rx), originY + ky * (gy - coy * ry), kx * rx, ky * ry);
          continue;
        }
        if (node.localName !== 'sp' && node.localName !== 'pic' && node.localName !== 'graphicFrame') continue;
        shapeIndex += 1;
        const key = phKey(node);
        const inherited = (key && layoutDefaults.get(key)) || (key && masterDefaults.get(key)) || undefined;
        const own = xmlBox(firstNamed(firstNamed(node, P_NS, 'spPr'), A_NS, 'xfrm'))
          || xmlBox(firstNamed(firstNamed(node, P_NS, 'grpSpPr'), A_NS, 'xfrm'));
        const type = phType(node);
        const box = own || inherited?.box || (type === 'title' || type === 'ctrTitle'
          ? { x: Math.round(width * 0.06), y: Math.round(height * 0.05), w: Math.round(width * 0.88), h: Math.round(height * 0.16) }
          : { x: Math.round(width * 0.06), y: Math.round(height * 0.25), w: Math.round(width * 0.88), h: Math.round(height * 0.6) });
        const scaled: Box = {
          x: Math.round(originX + box.x * kx),
          y: Math.round(originY + box.y * ky),
          w: Math.round(box.w * kx),
          h: Math.round(box.h * ky),
        };

        if (node.localName === 'pic') {
          const blip = node.getElementsByTagName('a:blip')[0];
          const src = slideMedia.get(relAttr(blip, 'embed')) || '';
          if (!src) continue;
          shapes.push({ kind: 'image', box: scaled, src, text: '', label: `图片 ${shapeIndex}`, selectable: true, id: `pptx-${slideIndex}-${shapeIndex}` });
          continue;
        }

        if (node.localName === 'graphicFrame') {
          const tbl = node.getElementsByTagName('a:tbl')[0];
          if (!tbl) continue;
          const cols = Array.from(tbl.getElementsByTagName('a:gridCol')).map(col => px(Number(col.getAttribute('w') || 0)));
          const rows = Array.from(tbl.getElementsByTagName('a:tr')).map(row => ({
            height: px(Number(row.getAttribute('h') || 0)),
            cells: Array.from(row.getElementsByTagName('a:tc')).map(cell => {
              const run = cell.getElementsByTagName('a:rPr')[0];
              return {
                text: tableCellText(cell),
                colspan: Number(cell.getAttribute('gridSpan') || 1),
                fill: solidColor(cell.getElementsByTagName('a:solidFill')[0]),
                align: firstNamed(firstNamed(cell, A_NS, 'txBody'), A_NS, 'p')?.getAttribute('algn') || undefined,
                size: attrSize(run) || 18,
                bold: run?.getAttribute('b') === '1',
              };
            }),
          }));
          const text = tidy(rows.map(row => row.cells.map(cell => cell.text).join(' | ')).join('\n'), 2000);
          shapes.push({
            kind: 'table', box: scaled, table: { cols, rows }, text,
            label: `表格 ${shapeIndex}`, selectable: true, id: `pptx-${slideIndex}-${shapeIndex}`,
          });
          continue;
        }

        const spPr = firstNamed(node, P_NS, 'spPr');
        const txBody = firstNamed(node, P_NS, 'txBody');
        const fallback = (inherited?.size || (type === 'title' || type === 'ctrTitle' ? 36 : 18));
        const heading = /title|ctrTitle|subTitle/.test(type);
        const paras = parseParagraphs(txBody, fallback, heading ? 'ctr' : 'l', !!key && !heading);
        const fill = shapeFill(spPr);
        const line = solidColor(firstNamed(firstNamed(spPr, A_NS, 'ln'), A_NS, 'solidFill'));
        const geometry = firstNamed(spPr, A_NS, 'prstGeom')?.getAttribute('prst');
        const text = paraText(paras);
        const hasGeometry = !!fill || !!line;
        if (!text && !hasGeometry) continue;
        shapes.push({
          kind: text ? 'text' : 'shape',
          box: scaled,
          fill: fill || undefined,
          line: line || undefined,
          rounded: geometry === 'roundRect',
          anchor: firstNamed(txBody, A_NS, 'bodyPr')?.getAttribute('anchor') || inherited?.anchor || 't',
          paras,
          text,
          label: heading ? `标题 ${shapeIndex}` : text ? `文本框 ${shapeIndex}` : `形状 ${shapeIndex}`,
          selectable: !!text,
          id: `pptx-${slideIndex}-${shapeIndex}`,
        });
      }
    };
    walk(firstNamed(doc.getElementsByTagName('p:cSld')[0], P_NS, 'spTree') || doc.documentElement, 0, 0, 1, 1);
    slides.push({ width, height, background, shapes });
  }

  if (!slides.length) throw new Error('这个演示文稿没有可显示的幻灯片');
  return { slides, revoke: () => { for (const url of urls) URL.revokeObjectURL(url); } };
}

const ALIGN: Record<string, string> = { l: 'left', ctr: 'center', r: 'right', just: 'justify', dist: 'justify' };

export function renderPptxSlide(host: HTMLElement, deck: PptxDeck, index: number): OfficeRenderResult {
  host.replaceChildren();
  const slide = deck.slides[Math.max(0, Math.min(index, deck.slides.length - 1))];
  const elements = new Map<string, OfficeElementInfo>();
  if (!slide) return { format: 'pptx', elements, pages: deck.slides.length };

  const stage = document.createElement('div');
  stage.className = 'px-stage';
  const scale = Math.min(1, Math.max(0.3, (host.clientWidth - 28) / slide.width));
  stage.style.height = Math.round(slide.height * scale) + 'px';

  const page = document.createElement('div');
  page.className = 'px-slide';
  page.style.width = slide.width + 'px';
  page.style.height = slide.height + 'px';
  page.style.background = slide.background;
  page.style.zoom = String(scale);
  stage.appendChild(page);

  for (const shape of slide.shapes) {
    const node = document.createElement('div');
    node.className = `px-shape is-${shape.kind}`;
    node.style.left = shape.box.x + 'px';
    node.style.top = shape.box.y + 'px';
    node.style.width = Math.max(2, shape.box.w) + 'px';
    node.style.height = Math.max(2, shape.box.h) + 'px';
    if (shape.fill) node.style.background = shape.fill;
    if (shape.line) node.style.border = `1px solid ${shape.line}`;
    if (shape.rounded) node.style.borderRadius = Math.round(Math.min(shape.box.w, shape.box.h) * 0.08) + 'px';

    if (shape.kind === 'image' && shape.src) {
      const img = document.createElement('img');
      img.src = shape.src;
      img.alt = '';
      img.draggable = false;
      node.appendChild(img);
    } else if (shape.kind === 'table' && shape.table) {
      const table = document.createElement('table');
      table.className = 'px-table';
      const colgroup = document.createElement('colgroup');
      for (const width of shape.table.cols) {
        const col = document.createElement('col');
        col.style.width = width + 'px';
        colgroup.appendChild(col);
      }
      table.appendChild(colgroup);
      for (const row of shape.table.rows) {
        const tr = document.createElement('tr');
        if (row.height) tr.style.height = row.height + 'px';
        for (const cell of row.cells) {
          const td = document.createElement('td');
          td.textContent = cell.text;
          if (cell.colspan > 1) td.colSpan = cell.colspan;
          if (cell.fill) td.style.background = cell.fill;
          if (cell.align) td.style.textAlign = ALIGN[cell.align] || 'left';
          if (cell.size) td.style.fontSize = (cell.size * 1.333).toFixed(1) + 'px';
          if (cell.bold) td.style.fontWeight = '700';
          tr.appendChild(td);
        }
        table.appendChild(tr);
      }
      node.appendChild(table);
    } else if (shape.paras?.length) {
      const body = document.createElement('div');
      body.className = 'px-text';
      body.style.justifyContent = shape.anchor === 'ctr' ? 'center' : shape.anchor === 'b' ? 'flex-end' : 'flex-start';
      for (const para of shape.paras) {
        const line = document.createElement('div');
        line.className = 'px-para';
        line.style.textAlign = ALIGN[para.align] || 'left';
        if (para.level) line.style.paddingLeft = para.level * 18 + 'px';
        if (para.bullet && shape.text) {
          const bullet = document.createElement('span');
          bullet.className = 'px-bullet';
          bullet.textContent = para.level ? '–' : '•';
          line.appendChild(bullet);
        }
        for (const run of para.runs) {
          if (run.text === '\n') { line.appendChild(document.createElement('br')); continue; }
          if (!run.text) continue;
          const span = document.createElement('span');
          span.textContent = run.text;
          const size = run.size || 18;
          span.style.fontSize = (size * 1.333).toFixed(1) + 'px';
          if (run.bold) span.style.fontWeight = '700';
          if (run.italic) span.style.fontStyle = 'italic';
          if (run.underline) span.style.textDecoration = 'underline';
          if (run.color) span.style.color = run.color;
          line.appendChild(span);
        }
        body.appendChild(line);
      }
      node.appendChild(body);
    }

    if (shape.selectable) {
      node.dataset.irisEl = shape.id;
      elements.set(shape.id, {
        id: shape.id,
        label: `第 ${index + 1} 张 · ${shape.label}`,
        kind: shape.kind === 'image' ? '图片' : shape.kind === 'table' ? '表格' : '文本框',
        text: shape.text,
        detail: `${slide.width}×${slide.height} · 第 ${index + 1} / ${deck.slides.length} 张`,
        page: `第 ${index + 1} 张`,
        value: shape.text,
        edit: shape.kind === 'text' ? { kind: 'pptx', slide: index + 1, shape: Number(shape.id.split('-').pop()) } : undefined,
      });
    }
    page.appendChild(node);
  }

  host.appendChild(stage);
  const notes: string[] = [];
  if (!elements.size) notes.push('这张幻灯片没有可引用的文字或图片。');
  return { format: 'pptx', elements, pages: deck.slides.length, notes };
}

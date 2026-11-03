export interface ImportedSkill {
  id: string;
  description: string;
  content: string;
  enabled: boolean;
}

export function slugSkillId(value: string) {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  return slug || 'skill';
}

export function parseSkillMarkdown(text: string, fallbackName: string): ImportedSkill {
  let body = String(text || '').replace(/^\uFEFF/, '');
  let id = slugSkillId(fallbackName);
  let description = '';
  const front = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (front) {
    const name = front[1].match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '');
    const desc = front[1].match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '');
    if (name) id = slugSkillId(name);
    if (desc) description = desc.slice(0, 300);
    body = body.slice(front[0].length);
  }
  body = body.trim().slice(0, 8000);
  if (!description) {
    const heading = body.split('\n').map(line => line.trim()).find(Boolean) || '个人技能';
    description = heading.replace(/^#+\s*/, '').slice(0, 300);
  }
  return { id, description, content: body, enabled: true };
}

function findEocd(view: DataView) {
  const min = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  return -1;
}

async function inflate(data: Uint8Array) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器无法解压 zip，请改用 Markdown 文件');
  }
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

// Reads .md entries from a zip (store or deflate). There is no server zip
// upload; the caller keeps the extracted markdown on the features config.
export async function markdownFromZip(buffer: ArrayBuffer): Promise<Array<{ name: string; text: string }>> {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const eocd = findEocd(view);
  if (eocd < 0) throw new Error('不是有效的 zip 文件');
  const count = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const files: Array<{ name: string; text: string }> = [];
  for (let n = 0; n < count; n++) {
    if (cursor + 46 > view.byteLength || view.getUint32(cursor, true) !== 0x02014b50) break;
    const method = view.getUint16(cursor + 10, true);
    const compSize = view.getUint32(cursor + 20, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const localOff = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen));
    cursor += 46 + nameLen + extraLen + commentLen;
    if (!/\.md$/i.test(name) || name.endsWith('/') || name.split('/').includes('__MACOSX')) continue;
    if (localOff + 30 > view.byteLength || view.getUint32(localOff, true) !== 0x04034b50) continue;
    const localName = view.getUint16(localOff + 26, true);
    const localExtra = view.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + localName + localExtra;
    const data = bytes.subarray(dataStart, dataStart + compSize);
    if (method === 0) files.push({ name: name.split('/').pop() || name, text: new TextDecoder().decode(data) });
    else if (method === 8) files.push({ name: name.split('/').pop() || name, text: await inflate(data) });
  }
  if (!files.length) throw new Error('zip 里没有可用的 Markdown（仅支持 store / deflate）');
  return files;
}

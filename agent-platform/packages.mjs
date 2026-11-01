import { mkdir, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fail, required } from './shared.mjs';

const root = process.env.PI_PACKAGES_ROOT || '/data/packages';
const file = root + '/installed.json';
const namePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
async function installed() {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
export async function packageCatalog(query = '') {
  if (typeof query !== 'string' || query.length > 100) fail(422, '搜索词过长');
  const response = await fetch('https://registry.npmjs.org/-/v1/search?size=24&text=' + encodeURIComponent('keywords:pi-package ' + query), { signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok) fail(502, 'npm 包目录暂时不可用');
  const data = await response.json();
  return { packages: (data.objects || []).map(({ package: item }) => ({ name: item.name, version: item.version,
    description: String(item.description || '').slice(0, 500), url: 'https://www.npmjs.com/package/' + encodeURIComponent(item.name) })),
    installed: (await installed()).map(({ name, version, integrity, resources }) => ({ name, version, integrity, resources: resources.map(({ kind, path }) => ({ kind, path })) })) };
}
export async function changePackage(input) {
  if (!namePattern.test(input.name || '') || !['install', 'remove'].includes(input.action)) fail(422, '包操作无效');
  let entries = await installed();
  if (input.action === 'remove') entries = entries.filter(item => item.name !== input.name);
  else {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.version || '')) fail(422, '请选择固定版本');
    if (entries.length >= 10 && !entries.some(item => item.name === input.name)) fail(409, '最多安装 10 个包');
    const response = await fetch((process.env.SANDBOX_URL || 'http://192.168.84.1:18082') + '/package', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + required('SANDBOX_SECRET') },
      body: JSON.stringify({ name: input.name, version: input.version }), signal: AbortSignal.timeout(45000), redirect: 'error' });
    const result = await response.json();
    if (!response.ok) fail(422, result.error || '包加载失败');
    const id = createHash('sha256').update(result.name + '@' + result.version + ':' + result.integrity).digest('hex');
    const resources = [];
    for (const [index, resource] of result.resources.entries()) {
      const directory = `${root}/${id}/${index}`;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const target = `${directory}/${resource.kind === 'skill' ? 'SKILL' : 'prompt-' + index}.md`;
      await writeFile(target, resource.text, { mode: 0o600 });
      resources.push({ kind: resource.kind, path: resource.path, file: target });
    }
    entries = entries.filter(item => item.name !== input.name);
    entries.push({ name: result.name, version: result.version, integrity: result.integrity, resources });
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID();
  await writeFile(temporary, JSON.stringify(entries), { mode: 0o600 });
  await rename(temporary, file);
  const active = new Set(entries.flatMap(item => item.resources.map(resource => resource.file.slice(root.length + 1).split('/')[0])));
  for (const directory of await readdir(root)) {
    if (/^[a-f0-9]{64}$/.test(directory) && !active.has(directory)) await rm(root + '/' + directory, { recursive: true, force: true });
  }
  return { ok: true };
}
export async function packageArguments() {
  return (await installed()).flatMap(item => item.resources.flatMap(resource => [resource.kind === 'skill' ? '--skill' : '--prompt-template', resource.file]));
}
export async function packageTextFiles() {
  return (await installed()).flatMap(item => item.resources.map(resource => resource.file));
}

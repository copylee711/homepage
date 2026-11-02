import { sandbox, sandboxTool } from './sandbox-client.mjs';
import { fail } from './shared.mjs';

export const MAX_UPLOAD = 256 * 1024;
export const MAX_PREVIEW = 64 * 1024;
export const MAX_DOWNLOAD = 15 * 1024 * 1024;
const snapshots = new Map();
export function invalidateWorkspace(user) {
  for (const key of snapshots.keys()) if (key.startsWith(user + ':')) snapshots.delete(key);
}
async function snapshot(user, key, task) {
  key = user + ':' + key;
  const cached = snapshots.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  const value = await task();
  snapshots.delete(key); snapshots.set(key, { value, expires: Date.now() + 2000 });
  while (snapshots.size > 32) snapshots.delete(snapshots.keys().next().value);
  return value;
}

function workspacePath(value, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > 1024 || /[\u0000\r\n]/.test(value)) fail(422, '工作区路径无效');
  if (!value && !allowEmpty) fail(422, '请选择文件或目录');
  return value;
}
export function fileName(path) {
  const name = String(path).replace(/\\/g, '/').split('/').filter(Boolean).pop();
  return name || 'workspace-file';
}
async function run(user, op, fields) {
  // A dedicated lease is issued for this operation. It is never renewed or cancelled,
  // so browsing files cannot stop an active model task.
  const token = (await sandbox('/lease', user)).token;
  return sandboxTool(token, { op, ...fields });
}

export async function listWorkspace(user, path, fresh = false) {
  if (fresh) invalidateWorkspace(user);
  workspacePath(path, true);
  const result = await snapshot(user, 'list:' + path, () => run(user, 'list', { path }));
  if (!path && Array.isArray(result?.entries)) {
    return { ...result, entries: result.entries.filter(item => item.name !== 'lost+found' && item.path !== 'lost+found') };
  }
  return result;
}
export async function previewWorkspace(user, path, limit, fresh = false) {
  if (fresh) invalidateWorkspace(user);
  const size = Math.min(1024 * 1024, Math.max(1024, Number(limit) || MAX_PREVIEW));
  workspacePath(path);
  const result = await snapshot(user, 'read:' + size + ':' + path, () => run(user, 'file-read', { path, limit: size }));
  return { ...result, name: fileName(path) };
}
export async function downloadWorkspace(user, path) {
  const result = await run(user, 'file-read', { path: workspacePath(path), limit: MAX_DOWNLOAD });
  if (result.truncated || result.size > MAX_DOWNLOAD) fail(413, '文件超过 15 MiB 下载上限，未下载截断内容');
  return { ...result, name: fileName(path) };
}
export async function uploadWorkspace(user, path, content, overwrite = false, revision, encoding) {
  invalidateWorkspace(user);
  workspacePath(path);
  if (typeof content !== 'string') fail(422, '请选择文件');
  const isBase64 = encoding === 'base64';
  if (isBase64) {
    const byteLen = Math.floor(content.length * 0.75);
    if (byteLen > 15 * 1024 * 1024) fail(413, '上传文件不能超过 15 MiB');
  } else {
    if (Buffer.byteLength(content, 'utf8') > MAX_UPLOAD) fail(413, '上传文件不能超过 256 KiB');
    if (content.includes('\u0000')) fail(422, '暂不支持上传二进制文件');
  }
  if (overwrite !== true && overwrite !== false) fail(422, '覆盖参数无效');
  if (revision !== undefined && (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision))) fail(422, '文件版本无效');
  const result = await run(user, 'file-write', { path, content, overwrite, revision, encoding });
  invalidateWorkspace(user);
  const size = isBase64 ? Math.floor(content.length * 0.75) : Buffer.byteLength(content, 'utf8');
  return { ...result, name: fileName(path), size, overwritten: overwrite };
}
export async function manageWorkspace(user, input) {
  invalidateWorkspace(user);
  if (!['mkdir', 'delete', 'move'].includes(input.action)) fail(422, '文件操作无效');
  workspacePath(input.path);
  if (input.action === 'move') workspacePath(input.destination);
  const result = await run(user, 'file-manage', { action: input.action, path: input.path, destination: input.destination });
  invalidateWorkspace(user);
  return result;
}

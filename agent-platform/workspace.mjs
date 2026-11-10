import { sandbox } from './sandbox-client.mjs';
import { fail } from './shared.mjs';

export const MAX_UPLOAD = 256 * 1024;
export const MAX_PREVIEW = 64 * 1024;
export const MAX_DOWNLOAD = 15 * 1024 * 1024;

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
  return sandbox('/files/operation', user, undefined, undefined, { op, ...fields }, 30000);
}

export async function listWorkspace(user, path) {
  return run(user, 'list', { path: workspacePath(path, true) });
}
export async function previewWorkspace(user, path, limit) {
  const size = Math.min(1024 * 1024, Math.max(1024, Number(limit) || MAX_PREVIEW));
  const result = await run(user, 'file-read', { path: workspacePath(path), limit: size });
  return { ...result, name: fileName(path) };
}
export async function downloadWorkspace(user, path) {
  const result = await run(user, 'file-read', { path: workspacePath(path), limit: MAX_DOWNLOAD });
  if (result.truncated || result.size > MAX_DOWNLOAD) fail(413, '文件超过 15 MiB 下载上限，未下载截断内容');
  return { ...result, name: fileName(path) };
}
export async function uploadWorkspace(user, path, content, overwrite = false, revision, encoding) {
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
  const size = isBase64 ? Math.floor(content.length * 0.75) : Buffer.byteLength(content, 'utf8');
  return { ...result, name: fileName(path), size, overwritten: overwrite };
}
export async function manageWorkspace(user, input) {
  if (!['mkdir', 'delete', 'move'].includes(input.action)) fail(422, '文件操作无效');
  workspacePath(input.path);
  if (input.action === 'move') workspacePath(input.destination);
  return run(user, 'file-manage', { action: input.action, path: input.path, destination: input.destination, recursive: input.recursive === true });
}

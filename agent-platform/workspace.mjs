import { sandbox, sandboxTool } from './sandbox-client.mjs';
import { fail } from './shared.mjs';

export const MAX_UPLOAD = 256 * 1024;
export const MAX_PREVIEW = 64 * 1024;
export const MAX_DOWNLOAD = 1024 * 1024;

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

export async function listWorkspace(user, path) {
  return run(user, 'list', { path: workspacePath(path, true) });
}
export async function previewWorkspace(user, path, limit) {
  const size = Math.min(MAX_DOWNLOAD, Math.max(1024, Number(limit) || MAX_PREVIEW));
  const result = await run(user, 'file-read', { path: workspacePath(path), limit: size });
  return { ...result, name: fileName(path) };
}
export async function downloadWorkspace(user, path) {
  const result = await run(user, 'file-read', { path: workspacePath(path), limit: MAX_DOWNLOAD });
  if (result.truncated || result.size > MAX_DOWNLOAD) fail(413, '文件超过 1 MiB 下载上限，未下载截断内容');
  return { ...result, name: fileName(path) };
}
export async function uploadWorkspace(user, path, content, overwrite = false) {
  workspacePath(path);
  if (typeof content !== 'string') fail(422, '请选择文本文件');
  if (Buffer.byteLength(content, 'utf8') > MAX_UPLOAD) fail(413, '上传文件不能超过 256 KiB');
  if (content.includes('\u0000')) fail(422, '暂不支持上传二进制文件');
  if (overwrite !== true && overwrite !== false) fail(422, '覆盖参数无效');
  const result = await run(user, 'file-write', { path, content, overwrite });
  return { ...result, name: fileName(path), size: Buffer.byteLength(content, 'utf8'), overwritten: overwrite };
}

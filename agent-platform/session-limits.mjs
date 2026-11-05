import { mkdir, readdir, stat } from 'node:fs/promises';
import { fail } from './shared.mjs';
const MIB = 1024 * 1024;
const MAX_SESSION_BYTES = 32 * MIB;
// Allow for writes between periodic quota checks.
export const MAX_SESSION_READ_BYTES = MAX_SESSION_BYTES + 4 * MIB;

export async function sessionCapacity(directory, thread, limits = {}) {
  // No default cap on the number of chats; total and per-file storage stay bounded.
  const maxChats = limits.chats ?? Infinity, maxBytes = limits.bytes ?? 256 * MIB;
  const maxFile = limits.file ?? MAX_SESSION_BYTES;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const files = (await readdir(directory)).filter(name => /^[a-f0-9-]{36}\.jsonl$/.test(name));
  if (!files.includes(thread + '.jsonl') && files.length >= maxChats) fail(413, '对话数量已达 ' + maxChats + ' 个上限，请联系管理员归档');
  if (limits.readExisting && files.includes(thread + '.jsonl')) return;
  const sizes = await Promise.all(files.map(async name => {
    try { return { name, size: (await stat(directory + '/' + name)).size }; }
    catch (error) {
      if (error.code === 'ENOENT') return { name, size: 0 };
      throw error;
    }
  }));
  if (sizes.reduce((sum, file) => sum + file.size, 0) >= maxBytes) fail(413, '账号对话存储已达 ' + maxBytes / MIB + ' MiB 上限，请清理旧对话');
  if (sizes.some(file => file.name === thread + '.jsonl' && file.size >= maxFile)) fail(413, '此对话已达 ' + maxFile / MIB + ' MiB 上限，请创建新对话');
}

import { mkdir, readdir, stat } from 'node:fs/promises';
import { fail } from './shared.mjs';
export async function sessionCapacity(directory, thread, limits = {}) {
  const maxChats = limits.chats ?? 50, maxBytes = limits.bytes ?? 32 * 1024 * 1024;
  const maxFile = limits.file ?? 4 * 1024 * 1024;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const files = (await readdir(directory)).filter(name => /^[a-f0-9-]{36}\.jsonl$/.test(name));
  if (!files.includes(thread + '.jsonl') && files.length >= maxChats) fail(413, '对话数量已达 50 个上限，请联系管理员归档');
  if (limits.readExisting && files.includes(thread + '.jsonl')) return;
  const sizes = await Promise.all(files.map(async name => ({ name, size: (await stat(directory + '/' + name)).size })));
  if (sizes.reduce((sum, file) => sum + file.size, 0) >= maxBytes) fail(413, '对话存储已达 32 MiB 上限，请联系管理员归档');
  if (sizes.some(file => file.name === thread + '.jsonl' && file.size >= maxFile)) fail(413, '此对话已达 4 MiB 上限，请创建新对话');
}

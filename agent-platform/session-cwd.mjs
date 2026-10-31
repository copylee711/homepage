import { open, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fail } from './shared.mjs';

// Pi restores cwd from the persisted header, overriding the child process cwd.
// Pin it to our empty trusted runtime directory, never the tool workspace.
export async function prepareSessionCwd(file, cwd) {
  let source;
  try { source = await open(file, 'r'); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  let temporary;
  try {
    const buffer = Buffer.alloc(65536);
    const { bytesRead } = await source.read(buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(10);
    if (newline < 0) fail(503, '对话元数据异常，请联系管理员检查');
    let header;
    try { header = JSON.parse(buffer.subarray(0, newline).toString()); }
    catch { fail(503, '对话元数据异常，请联系管理员检查'); }
    if (header.type !== 'session') fail(503, '对话元数据异常，请联系管理员检查');
    if (header.cwd === cwd) return false;
    // Keep the original metadata for recovery; message bytes are copied unchanged.
    await writeFile(file + '.cwd-backup', JSON.stringify(header) + '\n', { flag: 'wx', mode: 0o600 })
      .catch(error => { if (error.code !== 'EEXIST') throw error; });
    temporary = file + '.cwd-' + randomUUID();
    const target = await open(temporary, 'wx', 0o600);
    try {
      await target.writeFile(JSON.stringify({ ...header, cwd }) + '\n');
      for await (const chunk of source.createReadStream({ start: newline + 1, autoClose: false })) await target.writeFile(chunk);
      await target.sync();
    } finally { await target.close(); }
    await source.close(); source = undefined;
    await rename(temporary, file); temporary = undefined;
    return true;
  } finally {
    await source?.close();
    if (temporary) await unlink(temporary).catch(() => {});
  }
}

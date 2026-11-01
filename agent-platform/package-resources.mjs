import { readFile, lstat } from 'node:fs/promises';
export function packageReader(files, io = { readFile, lstat }) {
  const allowed = new Set(files);
  return async path => {
    if (!allowed.has(path)) return null;
    const info = await io.lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024) throw new Error('Package text unavailable');
    return io.readFile(path);
  };
}

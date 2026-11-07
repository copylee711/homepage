import { readFile } from 'node:fs/promises';
import { fail } from './shared.mjs';
import { MAX_SESSION_READ_BYTES } from './session-limits.mjs';

// Process-local, bounded snapshots; never browser storage, never an execution lease.
export class SessionSnapshots {
  constructor(store, project) { this.store = store; this.project = project; this.cache = new Map(); }
  forget(user, thread) { this.cache.delete(user + ':' + thread); }
  async read(user, thread) {
    let info;
    try { info = await this.store.assertOwned(user, thread); }
    catch (error) { if (error.status === 404) return []; throw error; }
    if (info.size > MAX_SESSION_READ_BYTES) fail(413, '此对话超过读取上限');
    const key = user + ':' + thread;
    const version = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    const cached = this.cache.get(key);
    if (cached?.version === version) return cached.messages;
    const text = await readFile(this.store.file(user, thread), 'utf8');
    const messages = await this.project(text);
    this.cache.delete(key);
    if (info.size <= 4 * 1024 * 1024) this.cache.set(key, { version, messages });
    // At most 16 bounded 4 MiB sessions; a changed file invalidates on next read.
    while (this.cache.size > 16) this.cache.delete(this.cache.keys().next().value);
    return messages;
  }
}

export async function projectSession(text) {
  // Use Pi's canonical branch/compaction/context-edit semantics, not a flat JSONL scan.
  const { SessionManager, parseSessionEntries } = await import('/opt/pi/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js');
  const manager = SessionManager.inMemory('/tmp', {}, parseSessionEntries(text));
  // Model context and the visible transcript serve different purposes. Preserve
  // the selected branch's original messages when compaction shrinks model input.
  return manager.getBranch().flatMap(entry => entry.type === 'message' ? [entry.message]
    : entry.type === 'compaction' ? [{ role: 'assistant', timestamp: entry.timestamp, content: [{ type: 'text', text: '上下文已压缩，前面的原始消息仍保留在对话记录中。' }] }] : []);
}

/** Fan-out for one agent turn. Closing a subscriber never cancels the turn. */

export class TurnFanout {
  constructor(maxBytes = 8 * 1024 * 1024) {
    this.maxBytes = maxBytes;
    this.lines = [];
    this.bytes = 0;
    this.dropped = 0;
    this.subscribers = new Set();
  }

  get cursor() {
    return this.dropped + this.lines.length;
  }

  /** Skip history this buffer does not hold so later cursors stay absolute. */
  advance(cursor) {
    const target = Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0;
    if (target > this.cursor) {
      this.dropped = target;
      this.lines = [];
      this.bytes = 0;
    }
  }

  publish(line) {
    if (typeof line !== 'string' || !line) return;
    if (!line.endsWith('\n')) line += '\n';
    if (line.length > this.maxBytes) return;
    while (this.lines.length && this.bytes + line.length > this.maxBytes) {
      this.bytes -= this.lines.shift().length;
      this.dropped += 1;
    }
    this.lines.push(line);
    this.bytes += line.length;
    for (const sub of [...this.subscribers]) this.#write(sub, line);
  }

  attach(res, cursor = 0, { endIfIdle = false } = {}) {
    const from = Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0;
    if (from < this.dropped) {
      this.#write(res, JSON.stringify({ type: 'turn_gap', from, retainedFrom: this.dropped }) + '\n');
    }
    const start = Math.max(0, from - this.dropped);
    for (const line of this.lines.slice(start)) this.#write(res, line);
    if (endIfIdle) {
      try { if (!res.destroyed && !res.writableEnded) res.end(); } catch { /* client already gone */ }
      return;
    }
    if (res.destroyed || res.writableEnded) return;
    this.subscribers.add(res);
    // Client disconnect removes this sink only. The turn keeps running.
    res.once('close', () => this.subscribers.delete(res));
  }

  end() {
    for (const sub of [...this.subscribers]) {
      this.subscribers.delete(sub);
      try { if (!sub.destroyed && !sub.writableEnded) sub.end(); } catch { /* already closed */ }
    }
  }

  #write(sub, line) {
    try {
      if (!sub || sub.destroyed || sub.writableEnded) {
        this.subscribers.delete(sub);
        return;
      }
      sub.write(line);
      if (sub.writableLength > 2 * 1024 * 1024) {
        this.subscribers.delete(sub);
        sub.destroy();
      }
    } catch {
      this.subscribers.delete(sub);
    }
  }
}

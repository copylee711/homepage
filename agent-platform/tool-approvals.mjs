import { fail } from './shared.mjs';

// A request belongs to exactly one live Pi instance, and may be answered once.
export class ToolApprovals {
  constructor(reply, emit, timeout = 120000) { this.reply = reply; this.emit = emit; this.timeout = timeout; this.pending = new Map(); }
  capture(event) {
    if (event.type !== 'extension_ui_request' || event.method !== 'confirm' || typeof event.id !== 'string') return;
    const expiresAt = Date.now() + this.timeout;
    const timer = setTimeout(() => this.complete(event.id, false, '审批超时，工具未执行'), this.timeout);
    this.pending.set(event.id, { timer, expiresAt });
    event.expiresAt = expiresAt;
  }
  resolve(id, allowed) {
    if (typeof allowed !== 'boolean') fail(422, '审批决定无效');
    const item = this.pending.get(id);
    if (!item || item.expiresAt <= Date.now()) fail(409, '审批已过期或已处理');
    this.complete(id, allowed, allowed ? '已允许本次执行' : '已拒绝本次执行');
    return { ok: true };
  }
  complete(id, allowed, reason) {
    const item = this.pending.get(id);
    if (!item) return;
    clearTimeout(item.timer); this.pending.delete(id);
    this.reply({ type: 'extension_ui_response', id, confirmed: allowed });
    this.emit({ type: 'approval_resolved', id, allowed, reason });
  }
  clear() { for (const id of this.pending.keys()) this.complete(id, false, '任务已结束，工具未执行'); }
}

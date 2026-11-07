// Stops a turn only when it has gone silent. There is no limit on how long a model may
// think or answer: every Pi event, including reasoning deltas, counts as activity.
// While a tool runs, the tool's own timeout applies (background_wait can block up to
// 25 minutes), so the silence allowance is longer.
export const TURN_IDLE_MS = 10 * 60000;
export const TOOL_IDLE_MS = 35 * 60000;

export class TurnWatchdog {
  constructor(onIdle, { idleMs = TURN_IDLE_MS, toolIdleMs = TOOL_IDLE_MS, now = Date.now } = {}) {
    this.onIdle = onIdle; this.idleMs = idleMs; this.toolIdleMs = toolIdleMs; this.now = now;
    this.last = now(); this.tools = new Set(); this.fired = false;
  }
  activity(event) {
    this.last = this.now();
    const id = event?.toolCallId ?? event?.id;
    if (event?.type === 'tool_execution_start') this.tools.add(id);
    else if (event?.type === 'tool_execution_end') this.tools.delete(id);
  }
  check() {
    if (this.fired) return false;
    const limit = this.tools.size ? this.toolIdleMs : this.idleMs;
    if (this.now() - this.last < limit) return false;
    this.fired = true; this.onIdle(); return true;
  }
}

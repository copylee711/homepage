// One checklist shared by the chat bubble and the corner panel. A later snapshot
// of the same steps with fewer completions is a stale pending/0/n replay and
// must not replace a plan the model already advanced.

const STATUSES = new Set(['pending', 'in_progress', 'completed']);

export function readPlanSteps(raw) {
  let value = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return null;
    try { value = JSON.parse(text); } catch { return null; }
  }
  if (!value || typeof value !== 'object') return null;
  const steps = Array.isArray(value.steps) ? value.steps : null;
  if (!steps?.length) return null;
  const normalized = [];
  for (const step of steps) {
    if (!step || typeof step.step !== 'string' || !step.step.trim()) return null;
    if (!STATUSES.has(step.status)) return null;
    normalized.push({ step: step.step, status: step.status });
  }
  return normalized;
}

export function planSignature(steps) {
  return steps.map((step) => step.step.trim()).join('\0');
}

export function completedCount(steps) {
  return (steps || []).reduce((count, step) => count + (step.status === 'completed' ? 1 : 0), 0);
}

export function planIsComplete(steps) {
  return !!steps?.length && steps.every((step) => step.status === 'completed');
}

// Walk snapshots in arrival order. Keep a newer checklist, and keep progress
// on the same checklist, but drop a replay that moves completed steps backwards.
export function selectActivePlan(snapshots) {
  let chosen = null;
  let signature = '';
  let done = -1;
  for (const steps of snapshots || []) {
    if (!steps?.length) continue;
    const nextSignature = planSignature(steps);
    const nextDone = completedCount(steps);
    if (chosen && nextSignature === signature && nextDone < done) continue;
    chosen = steps;
    signature = nextSignature;
    done = nextDone;
  }
  return chosen;
}

export function planFromBlock(block) {
  if (!block || block.name !== 'update_plan') return null;
  return selectActivePlan([
    readPlanSteps(block.args),
    readPlanSteps(block.arguments),
    readPlanSteps(block.result),
  ].filter(Boolean));
}

// Messages are in transcript order; live blocks are the current turn, after the
// user message that started it. A new user message may restart the same
// checklist. A later snapshot in the same turn may not.
export function resolveTaskPlan(messages, liveBlocks) {
  let chosen = null;
  let signature = '';
  let done = -1;
  const consider = (steps) => {
    if (!steps?.length) return;
    const nextSignature = planSignature(steps);
    const nextDone = completedCount(steps);
    if (chosen && nextSignature === signature && nextDone < done) return;
    chosen = steps;
    signature = nextSignature;
    done = nextDone;
  };
  for (const message of messages || []) {
    if (message?.role === 'user') { signature = ''; done = -1; continue; }
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content) consider(planFromBlock(part));
  }
  for (const block of liveBlocks || []) consider(planFromBlock(block));
  return chosen;
}

// Write tool arguments, but never let a stale update_plan snapshot replace a
// more complete checklist already stored on the same block.
export function assignToolArgs(block, raw) {
  if (!block) return;
  const next = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {}, null, 2);
  if (block.name === 'update_plan') {
    const prevSteps = readPlanSteps(block.args);
    const nextSteps = readPlanSteps(next);
    if (prevSteps && !nextSteps) return;
    if (prevSteps && nextSteps && planSignature(prevSteps) === planSignature(nextSteps) && completedCount(nextSteps) < completedCount(prevSteps)) return;
  }
  block.args = next;
}

export function finishedPlan(block) {
  return block?.name === 'update_plan' && (block.state === 'success' || block.state === 'error');
}

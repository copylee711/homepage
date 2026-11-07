import { completedCount, planFromBlock, planSignature } from './plan-state.mjs';
import { readToolImage } from './tool-images.mjs';

// Normalize an assistant message's content (Pi shape or live view-model) into
// the block list BlockList.vue renders.
export function normalizeBlocks(content, toolResults) {
  if (!Array.isArray(content)) return content ? [{ type: 'text', text: String(content) }] : [];
  // Live view-model blocks already use {type:'text'|'thinking'|'tool'}.
  const blocks = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text') blocks.push({ type: 'text', text: part.text || '' });
    else if (part.type === 'thinking' && (part.thinking || part.text)) blocks.push({ ...part, type: 'thinking', text: part.thinking || part.text });
    else if (part.type === 'tool') blocks.push(part);
    else if (part.type === 'toolCall') {
      const r = toolResults?.[part.id];
      blocks.push({ type: 'tool', id: part.id, name: part.name || 'tool', args: part.arguments ? JSON.stringify(part.arguments, null, 2) : '', state: r ? (r.isError ? 'error' : 'success') : 'success', result: r ? r.text : '', imageUrl: r?.isError ? undefined : readToolImage(part.name, r?.content), durationMs: 0 });
    }
  }
  return blocks;
}

// `notes` record why turns ended abnormally. They live beside the session
// file, so a reload still shows the reason and the retry affordance instead of
// a silently truncated answer. Each note belongs to the last assistant turn
// that finished before it.
export function buildTranscript(messages, notes) {
  const results = {};
  for (const m of messages) if (m.role === 'toolResult') results[m.toolCallId] = { isError: m.isError === true, content: m.content, text: typeof m.content === 'string' ? m.content : (m.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n') };
  const items = [];
  for (const m of messages) {
    if (m.role === 'user') { items.push({ ...m }); continue; }
    if (m.role !== 'assistant') continue;
    const blocks = normalizeBlocks(m.content, results);
    const last = items.at(-1);
    if (last?.role === 'assistant') {
      last.content.push(...blocks);
      if (m.durationMs) last.durationMs = (last.durationMs || 0) + m.durationMs;
      // A later model message in the same turn can be the one that hit the cap.
      if (m.stopReason === 'length') last.stopReason = 'length';
    }
    else items.push({ ...m, content: [...blocks] });
  }
  const list = (Array.isArray(notes) ? notes : notes ? [notes] : [])
    .filter(note => note && typeof note.message === 'string' && note.message.trim());
  for (const note of list) {
    const at = Number(note.at) || 0;
    // The turn that ended at `at` is the last assistant bubble created before it.
    let target = null;
    for (const item of items) {
      if (item.role !== 'assistant') continue;
      if (at && item.timestamp && item.timestamp > at) break;
      target = item;
    }
    if (!target) continue;
    if (note.kind === 'stopped') target.stopped = true;
    else target.error = note.message;
  }
  return items;
}
export function segmentBlocks(blocks) {
  const out = [];
  for (const block of blocks || []) {
    if (!block || ((block.type === 'text' || block.type === 'thinking') && !block.text?.trim())) continue;
    if (block.type !== 'tool') { out.push(block); continue; }
    if (block.name === 'update_plan') {
      const steps = planFromBlock(block);
      const previous = [...out].reverse().find((item) => item.type === 'plan');
      const previousSteps = previous ? planFromBlock(previous.block) : null;
      // A replayed pending checklist must not paint a second 0/n card over the
      // completed one the bubble already shows.
      if (steps && previousSteps && planSignature(steps) === planSignature(previousSteps) && completedCount(steps) < completedCount(previousSteps)) continue;
      out.push({ type: 'plan', block });
      continue;
    }
    const last = out.at(-1);
    if (last?.type === 'tools') last.items.push(block);
    else out.push({ type: 'tools', items: [block] });
  }
  return out;
}

export function groupExecution(blocks, streaming) {
  const groups = [];
  let execution = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      if (!block.text?.trim()) continue;
      if (execution.length) groups.push({ type: 'execution', items: execution, collapsed: true });
      execution = [];
      groups.push(block);
    } else if (block.type !== 'thinking' || block.text?.trim()) {
      execution.push(block);
    }
  }
  if (execution.length) groups.push({ type: 'execution', items: execution, collapsed: !streaming });
  return groups;
}

// One ordered transaction per animation frame. Terminal/error/approval events
// flush immediately so no final tokens or actionable requests stay queued.
export function eventBatch(deliver, schedule = cb => requestAnimationFrame(cb), cancel = id => cancelAnimationFrame(id)) {
  let queue = [], pending = null;
  function flush() { if (pending !== null) cancel(pending); pending = null; const events = queue; queue = []; for (const event of events) deliver(event); }
  return {
    push(event) {
      const last = queue.at(-1), a = event.assistantMessageEvent, b = last?.assistantMessageEvent;
      if (event.type === 'message_update' && last?.type === event.type && /^(text|thinking|toolcall)_delta$/.test(a?.type || '') && a.type === b?.type && a.contentIndex === b.contentIndex) b.delta = (b.delta || '') + (a.delta || '');
      else queue.push(event);
      if (event.type !== 'message_update') flush();
      else if (pending === null) pending = schedule(flush);
    }, flush,
  };
}

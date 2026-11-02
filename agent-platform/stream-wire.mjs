// Full SDK snapshots are retained in canonical message_end events, not repeated
// alongside every incremental delta (which otherwise grows quadratically).
export function streamEvent(event) {
  if(event.type!=='message_update')return event;
  const {partial,message,...delta}=event.assistantMessageEvent||{};
  return {type:event.type,assistantMessageEvent:delta};
}

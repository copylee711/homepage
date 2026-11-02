// A plain reactive-friendly object describing the streaming assistant turn.
export function reactiveLive() {
  return { blocks: [], approvals: [], questions: [], status: '正在连接模型…', spinner: true, finished: false, error: '', stopped: false, tools: {} };
}

// Reduce a runner stream event into the live view model's block list.
export function handleEvent(event, live) {
  if (!event || typeof event !== 'object') return;
  const vm = live;
  if (event.type === 'extension_ui_request' && event.method === 'input' && event.question) {
    vm.questions.push({ id: event.id, question: event.question, state: 'pending', answer: '', saving: false, error: '' });
    vm.status = '等待你的回答…'; vm.spinner = false; return;
  }
  if (event.type === 'question_resolved') {
    const item = vm.questions.find((q) => q.id === event.id);
    if (item) { item.state = event.cancelled ? 'expired' : 'answered'; item.answer = event.answer; }
    vm.status = event.cancelled ? '问题已结束' : '已收到回答，继续执行…'; vm.spinner = !event.cancelled; return;
  }
  if (event.type === 'extension_ui_request' && event.method === 'confirm') {
    vm.approvals.push({ id: event.id, title: event.title, message: event.message, expiresAt: event.expiresAt, state: 'pending', saving: false, error: '' });
    vm.status = '等待你审批工具操作…'; vm.spinner = false;
    return;
  }
  if (event.type === 'approval_resolved') {
    const item = vm.approvals.find((a) => a.id === event.id);
    if (item) item.state = event.allowed ? 'allowed' : 'denied';
    vm.status = event.reason || '审批已处理';
    return;
  }
  if (event.type === 'message_start' && event.message?.role === 'user') { vm.blocks.push({ type: 'text', text: '**补充指令**\n\n' + toolText(event.message.content) }); return; }
  if (event.type === 'message_start' && event.message?.role === 'assistant') { vm.messageSequence = (vm.messageSequence || 0) + 1; return; }
  const ensureBlock = (index, type) => {
    let b = vm.blocks.find((x) => x.index === index && x.sequence === (vm.messageSequence || 0));
    if (!b) { b = { index, sequence: vm.messageSequence || 0, type, text: '', fresh: true }; vm.blocks.push(b); }
    return b;
  };
  if (event.type === 'message_end' && event.message?.role === 'assistant') {
    for (const [index, part] of (event.message.content || []).entries()) {
      if (part.type === 'text' || part.type === 'thinking') {
        const b = ensureBlock(index, part.type); b.type = part.type; b.text = part.type === 'text' ? part.text || '' : part.thinking || '';
      } else if (part.type === 'toolCall') {
        const b = ensureBlock(index, 'tool'); b.type = 'tool'; b.id = part.id; b.name = part.name; b.args = JSON.stringify(part.arguments || {}, null, 2); b.state ||= 'pending';
      }
    }
    return;
  }
  if (event.type === 'message_update') {
    const u = event.assistantMessageEvent; if (!u) return;
    switch (u.type) {
      case 'text_start': ensureBlock(u.contentIndex, 'text'); break;
      case 'text_delta': { const b = ensureBlock(u.contentIndex, 'text'); b.text += u.delta || ''; break; }
      case 'text_end': { const b = ensureBlock(u.contentIndex, 'text'); if (typeof u.content === 'string') b.text = u.content; break; }
      case 'thinking_start': ensureBlock(u.contentIndex, 'thinking'); break;
      case 'thinking_delta': { const b = ensureBlock(u.contentIndex, 'thinking'); b.text += u.delta || ''; break; }
      case 'thinking_end': { const b = ensureBlock(u.contentIndex, 'thinking'); if (typeof u.content === 'string') b.text = u.content; break; }
      case 'toolcall_start': { const b = ensureBlock(u.contentIndex, 'tool'); b.id = u.id || u.toolCall?.id; b.name = u.toolName || u.toolCall?.name || 'tool'; b.state = 'pending'; b.args = ''; vm.status = '正在准备工具…'; break; }
      case 'toolcall_delta': { const b = ensureBlock(u.contentIndex, 'tool'); b.args = (b.args || '') + (u.delta || ''); break; }
      case 'toolcall_end': { const b = ensureBlock(u.contentIndex, 'tool'); const tc = u.toolCall || {}; b.id = tc.id || b.id; b.name = tc.name || b.name; b.args = tc.arguments ? JSON.stringify(tc.arguments, null, 2) : b.args; b.state = 'pending'; break; }
    }
    return;
  }
  if (event.type === 'tool_execution_start') {
    const b = vm.blocks.find((x) => x.type === 'tool' && x.id === event.toolCallId) || ensureBlock(1e6 + vm.blocks.length, 'tool');
    b.id = event.toolCallId; b.name = event.toolName || b.name; b.state = 'running'; if (event.args) b.args = JSON.stringify(event.args, null, 2);
    b.started = Date.now(); vm.status = '正在执行工具 · ' + (event.toolName || ''); vm.spinner = true;
    return;
  }
  if (event.type === 'tool_execution_end') {
    const b = vm.blocks.find((x) => x.type === 'tool' && x.id === event.toolCallId);
    if (b) { b.state = event.isError ? 'error' : 'success'; b.result = toolText(event.result); b.durationMs = event.durationMs || (b.started ? Date.now() - b.started : 0); }
    vm.status = '正在整理结果…'; return;
  }
  if (event.type === 'gateway_error') throw new Error(event.error || '任务中断，请重试');
  if (event.type === 'agent_settled') { if (event.aborted) vm.stopped = true; vm.status = ''; vm.spinner = false; }
}

function toolText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter(p => p?.type === 'text').map(p => p.text || '').join('\n') || value.map(p => p?.text || '').join('');
  if (value?.content) return toolText(value.content);
  if (value && typeof value === 'object') return String(value.output || value.stdout || JSON.stringify(value));
  return String(value ?? '');
}

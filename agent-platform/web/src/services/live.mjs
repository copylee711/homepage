import { assignToolArgs, finishedPlan } from './plan-state.mjs';
import { readToolImage } from './tool-images.mjs';

// A plain reactive-friendly object describing the streaming assistant turn.
export function reactiveLive() {
  return {
    blocks: [],
    approvals: [],
    questions: [],
    status: '正在连接模型…',
    spinner: true,
    finished: false,
    error: '',
    stopped: false,
    stopReason: '',
    tools: {},
    retry: null,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, calls: 0, genMs: 0, streamedChars: 0 },
  };
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
  if (event.type === 'message_start' && event.message?.role === 'user') return;
  if (event.type === 'message_start' && event.message?.role === 'assistant') {
    vm.retry = null;
    vm._callStartedAt = Date.now();
    vm._firstTokenAt = 0;
    vm.messageSequence = (vm.messageSequence || 0) + 1;
    return;
  }
  const ensureBlock = (index, type) => {
    let b = vm.blocks.find((x) => x.index === index && x.sequence === (vm.messageSequence || 0));
    if (!b) { b = { index, sequence: vm.messageSequence || 0, type, text: '', fresh: true }; vm.blocks.push(b); }
    return b;
  };
  if (event.type === 'message_end' && event.message?.role === 'assistant') {
    vm.retry = null;
    for (const [index, part] of (event.message.content || []).entries()) {
      if (part.type === 'text' || part.type === 'thinking') {
        const b = ensureBlock(index, part.type); b.type = part.type; b.text = part.type === 'text' ? part.text || '' : part.thinking || '';
      } else if (part.type === 'toolCall') {
        // Reconcile by id so a late message snapshot cannot open a second,
        // older copy of a plan that already finished.
        const existing = part.id ? vm.blocks.find((x) => x.type === 'tool' && x.id === part.id) : null;
        const b = existing || ensureBlock(index, 'tool');
        b.type = 'tool'; b.id = part.id || b.id; b.name = part.name || b.name;
        assignToolArgs(b, part.arguments || {});
        if (!b.state) b.state = 'pending';
      }
    }
    if (event.message.usage && vm.usage) {
      const u = event.message.usage;
      const inp = Number(u.input) || 0;
      const out = Number(u.output) || 0;
      const cr = Number(u.cacheRead) || 0;
      const cw = Number(u.cacheWrite) || 0;
      vm.usage.input += inp;
      vm.usage.output += out;
      vm.usage.cacheRead += cr;
      vm.usage.cacheWrite += cw;
      vm.usage.totalTokens += Number(u.totalTokens) || (inp + out + cr + cw);
      vm.usage.cost += Number(u.cost?.total) || 0;
      vm.usage.calls += 1;
      vm.usage.lastContextTokens = inp + cr + cw + out;
    }
    if (vm._callStartedAt && vm.usage) {
      const start = vm._firstTokenAt || vm._callStartedAt;
      vm.usage.genMs += Math.max(50, Date.now() - start);
      vm._callStartedAt = 0;
      vm._firstTokenAt = 0;
    }
    // Pi sends stopReason on the assistant message. "length" means this reply
    // stopped because the output token budget was used up.
    if (event.message.stopReason === 'length') vm.stopReason = 'length';
    return;
  }
  if (event.type === 'message_update') {
    const u = event.assistantMessageEvent; if (!u) return;
    if (vm.retry) vm.retry = null;
    if (!vm._firstTokenAt && (u.type === 'text_delta' || u.type === 'thinking_delta' || u.type === 'toolcall_delta')) {
      vm._firstTokenAt = Date.now();
    }
    if (vm.usage && (u.type === 'text_delta' || u.type === 'thinking_delta' || u.type === 'toolcall_delta')) {
      vm.usage.streamedChars += String(u.delta || '').length;
    }
    switch (u.type) {
      case 'text_start': ensureBlock(u.contentIndex, 'text'); break;
      case 'text_delta': { const b = ensureBlock(u.contentIndex, 'text'); b.text += u.delta || ''; break; }
      case 'text_end': { const b = ensureBlock(u.contentIndex, 'text'); if (typeof u.content === 'string') b.text = u.content; break; }
      case 'thinking_start': { const b = ensureBlock(u.contentIndex, 'thinking'); if (!b.started) b.started = Date.now(); break; }
      case 'thinking_delta': { const b = ensureBlock(u.contentIndex, 'thinking'); if (!b.started) b.started = Date.now(); b.text += u.delta || ''; break; }
      case 'thinking_end': {
        const b = ensureBlock(u.contentIndex, 'thinking');
        if (typeof u.content === 'string') b.text = u.content;
        if (b.started && !b.durationMs) b.durationMs = Date.now() - b.started;
        break;
      }
      case 'toolcall_start': {
        const b = ensureBlock(u.contentIndex, 'tool');
        if (!finishedPlan(b)) {
          b.id = u.id || u.toolCall?.id || b.id;
          b.name = u.toolName || u.toolCall?.name || b.name || 'tool';
          b.state = 'pending';
          b.args = '';
        }
        if (b.name !== 'set_chat_title') vm.status = '正在准备工具…';
        break;
      }
      case 'toolcall_delta': {
        const b = ensureBlock(u.contentIndex, 'tool');
        if (finishedPlan(b)) break;
        b.args = (b.args || '') + (u.delta || '');
        break;
      }
      case 'toolcall_end': {
        const b = ensureBlock(u.contentIndex, 'tool');
        const tc = u.toolCall || {};
        const keep = finishedPlan(b);
        if (!keep) { b.id = tc.id || b.id; b.name = tc.name || b.name; }
        if (tc.arguments) assignToolArgs(b, tc.arguments);
        if (!keep) b.state = 'pending';
        break;
      }
    }
    return;
  }
  if (event.type === 'tool_execution_start') {
    const b = vm.blocks.find((x) => x.type === 'tool' && x.id === event.toolCallId) || ensureBlock(1e6 + vm.blocks.length, 'tool');
    const keep = finishedPlan(b);
    b.id = event.toolCallId; b.name = event.toolName || b.name;
    if (!keep) b.state = 'running';
    if (event.args) assignToolArgs(b, event.args);
    b.started = Date.now();
    if (b.name !== 'set_chat_title') { vm.status = '正在执行工具 · ' + (event.toolName || ''); vm.spinner = true; }
    return;
  }
  if (event.type === 'tool_execution_end') {
    const b = vm.blocks.find((x) => x.type === 'tool' && x.id === event.toolCallId);
    if (b) {
      b.state = event.isError ? 'error' : 'success';
      b.result = toolText(event.result);
      b.imageUrl = event.isError ? undefined : readToolImage(b.name, event.result);
      b.durationMs = event.durationMs || (b.started ? Date.now() - b.started : 0);
    }
    if (b?.name !== 'set_chat_title') vm.status = '正在整理结果…'; return;
  }
  if (event.type === 'gateway_error') throw new Error(event.error || '任务中断，请重试');
  if (event.type === 'auto_retry_start') {
    const delayMs = Math.max(0, Number(event.delayMs) || 0);
    const attempt = event.attempt || 1;
    const maxAttempts = event.maxAttempts || 1;
    vm.retry = { until: Date.now() + delayMs, delayMs, attempt, maxAttempts };
    vm.status = `模型调用失败，${Math.max(1, Math.round(delayMs / 1000))} 秒后自动重试（${attempt}/${maxAttempts}）…`;
    vm.spinner = true;
    return;
  }
  if (event.type === 'auto_retry_end') {
    vm.retry = null;
    vm.status = event.success ? '重试成功，继续执行…' : '多次重试仍失败：' + (event.finalError || '模型服务不可用');
    return;
  }
  if (event.type === 'goal_progress') { vm.goal = { continues: event.continues, max: event.max }; vm.status = `长目标自动续跑 ${event.continues}/${event.max}…`; vm.spinner = true; return; }
  if (event.type === 'compaction_start') { vm.status = '上下文接近上限，正在自动压缩…'; vm.spinner = true; return; }
  if (event.type === 'agent_settled') { vm.retry = null; if (event.aborted) vm.stopped = true; settleTools(vm, vm.stopped ? 'stopped' : 'interrupted'); vm.status = ''; vm.spinner = false; }
}

export function settleTools(vm, state) {
  const now = Date.now();
  for (const block of vm.blocks) {
    if (block.type === 'tool' && ['pending', 'running'].includes(block.state)) block.state = state;
    // A reasoning block cut short by a stop still reports how long it ran.
    if (block.type === 'thinking' && block.started && !block.durationMs) block.durationMs = now - block.started;
  }
}

function toolText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter(p => p?.type === 'text').map(p => p.text || '').join('\n') || value.map(p => p?.text || '').join('');
  if (value?.content) return toolText(value.content);
  if (value && typeof value === 'object') return String(value.output || value.stdout || JSON.stringify(value));
  return String(value ?? '');
}

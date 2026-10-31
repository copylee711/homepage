import { el, icon, copyText } from './dom.js';
import { renderMarkdown } from './markdown.js';
import { formatClock, formatDate } from './format.js';

const TOOL_NAMES = { bash: '终端命令', read: '读取文件', write: '写入文件', edit: '编辑文件' };
const STATUS = {
  pending: { label: '等待执行', tone: 'pending' },
  running: { label: '运行中', tone: 'running' },
  success: { label: '已完成', tone: 'success' },
  error: { label: '失败', tone: 'error' },
};
export function textContent(value) {
  if (typeof value === 'string') return value;
  return (Array.isArray(value) ? value : []).filter(part => part?.type === 'text').map(part => part.text || '').join('\n');
}
function thinkingContent(value) {
  return (Array.isArray(value) ? value : []).filter(part => part?.type === 'thinking' && part.thinking).map(part => part.thinking).join('\n\n');
}
function toolContent(value) {
  return textContent(value) || (Array.isArray(value) ? value.map(part => part?.text || '').join('') : '');
}
function bound(value, limit = 120000) {
  const text = String(value ?? '');
  return text.length > limit ? text.slice(0, limit) + '\n\n…（内容过长，已截断显示；完整记录请导出对话）' : text;
}
function preview(value, limit = 92) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}

class ToolCard {
  constructor(transcript, id, name) {
    this.transcript = transcript;
    this.id = id;
    this.name = name || 'tool';
    this.state = 'pending';
    this.argsText = '';
    this.resultText = '';
    this.started = 0;
    this.element = el('details', { class: 'tool-card', dataset: { toolId: id } });
    const summary = el('summary', { class: 'tool-summary' });
    this.icon = el('span', { class: 'tool-icon' }, icon(name === 'bash' ? 'terminal' : name === 'read' ? 'file' : 'edit', 15));
    this.label = el('span', { class: 'tool-name', text: TOOL_NAMES[name] || name || '工具' });
    this.codeName = el('code', { class: 'tool-code-name', text: name || 'tool' });
    this.preview = el('span', { class: 'tool-preview' });
    this.status = el('span', { class: 'tool-status', text: STATUS.pending.label });
    this.duration = el('span', { class: 'tool-duration' });
    this.chevron = el('span', { class: 'tool-chevron' }, icon('chevron-right', 14));
    summary.append(this.icon, this.label, this.codeName, this.preview, this.status, this.duration, this.chevron);
    const body = el('div', { class: 'tool-body' });
    this.argsSection = el('section', { class: 'tool-section' }, el('h4', { text: '参数' }));
    this.argsPre = el('pre', { class: 'tool-pre' });
    this.argsSection.append(this.argsPre);
    this.resultSection = el('section', { class: 'tool-section' }, el('h4', { text: '结果' }));
    this.resultPre = el('pre', { class: 'tool-pre' });
    this.resultSection.append(this.resultPre);
    body.append(this.argsSection, this.resultSection);
    this.element.append(summary, body);
    this.setStatus('pending');
  }
  setArgs(value) {
    try {
      this.argsText = typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2);
    } catch { this.argsText = String(value ?? ''); }
    this.argsPre.textContent = bound(this.argsText, 30000);
    const parsed = value && typeof value === 'object' ? value : {};
    const hint = this.name === 'bash' ? parsed.command : (parsed.path || parsed.file_path || parsed.pattern || '');
    this.preview.textContent = hint ? preview(hint) : '';
    this.preview.title = hint ? String(hint).slice(0, 500) : '';
  }
  appendArgs(delta) {
    this.argsText += String(delta || '');
    this.argsPre.textContent = bound(this.argsText, 30000);
  }
  setStatus(value) {
    this.state = value;
    const status = STATUS[value] || STATUS.pending;
    this.status.textContent = status.label;
    this.status.className = 'tool-status tone-' + status.tone;
    this.element.dataset.state = value;
    if (value === 'running' && !this.started) this.started = Date.now();
    if (['success', 'error'].includes(value) && this.started) {
      this.duration.textContent = ((Date.now() - this.started) / 1000).toFixed(1) + 's';
    }
  }
  setResult(value, isError = false, durationMs = 0) {
    this.resultText = toolContent(value);
    if (this.name === 'bash' && value && typeof value === 'object' && !this.resultText) {
      this.resultText = String(value.output || value.stdout || '');
    }
    this.resultPre.textContent = bound(this.resultText || (isError ? '工具执行失败' : '没有文本输出'), 120000);
    this.resultSection.hidden = !this.resultText && !isError;
    this.setStatus(isError ? 'error' : 'success');
    if (durationMs) this.duration.textContent = (durationMs / 1000).toFixed(1) + 's';
  }
  setPartial(value) {
    const text = toolContent(value);
    if (!text) return;
    this.resultText = text;
    this.resultPre.textContent = bound(text, 120000);
    this.resultSection.hidden = false;
    if (this.state === 'pending') this.setStatus('running');
  }
}

class AssistantView {
  constructor(transcript, { animate = true, history = false } = {}) {
    this.transcript = transcript;
    this.textParts = [];
    this.cards = [];
    this.blockNodes = new Map();
    this.timers = new Map();
    this.finished = false;
    this.segment = null;
    this.messageSeq = 0;
    this.history = history;
    this.element = el('article', { class: 'message message-assistant is-streaming' + (animate ? ' is-entering' : '') + (history ? ' is-history' : '') });
    const avatar = el('div', { class: 'message-avatar', attrs: { 'aria-hidden': 'true' } }, icon('sparkle', 16));
    const inner = el('div', { class: 'message-inner' });
    const meta = el('div', { class: 'message-meta' });
    this.time = el('time', { class: 'message-time', text: formatClock(Date.now()) });
    const copy = el('button', { type: 'button', class: 'message-action', attrs: { 'aria-label': '复制回复', title: '复制回复', 'data-copy-message': '' } }, icon('copy', 15), el('span', { text: '复制' }));
    meta.append(el('strong', { class: 'message-author', text: 'Pi' }), this.time, copy);
    this.content = el('div', { class: 'message-content' });
    this.status = el('div', { class: 'message-status', attrs: { role: 'status', 'aria-live': 'polite' } });
    this.spinner = el('span', { class: 'working-dot', attrs: { 'aria-hidden': 'true' } });
    this.statusText = el('span');
    this.status.append(this.spinner, this.statusText);
    this.error = el('div', { class: 'message-error', attrs: { role: 'alert' } });
    this.error.hidden = true;
    this.footer = el('div', { class: 'message-footer' });
    const retry = el('button', { type: 'button', class: 'message-action', attrs: { 'data-action': 'retry' } }, icon('refresh', 15), el('span', { text: '重试上一条' }));
    retry.addEventListener('click', () => transcript.onRetry?.(this));
    const again = el('button', { type: 'button', class: 'message-action', attrs: { 'data-action': 'continue' } }, icon('corner-down-left', 15), el('span', { text: '继续' }));
    again.addEventListener('click', () => transcript.onContinue?.(this));
    this.footer.append(retry, again);
    inner.append(meta, this.content, this.status, this.error, this.footer);
    this.element.append(avatar, inner);
    transcript.container.append(this.element);
    transcript.lastAssistant = this;
  }
  setTime(value) {
    const timestamp = Number.isFinite(value) ? value : Date.parse(value);
    if (Number.isFinite(timestamp)) {
      this.time.textContent = formatClock(timestamp);
      this.time.title = formatDate(timestamp) + ' ' + formatClock(timestamp);
    }
  }
  setStatus(text, { spinner = false, tone = '' } = {}) {
    this.status.hidden = !text;
    this.statusText.textContent = text || '';
    this.spinner.hidden = !spinner;
    this.status.className = 'message-status' + (tone ? ' tone-' + tone : '');
  }
  beginMessage({ live = true } = {}) {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.messageSeq += 1;
    this.segment = el('div', { class: 'assistant-segment', dataset: { message: String(this.messageSeq) } });
    this.content.append(this.segment);
    this.blockNodes.clear();
    this.textParts = [];
    this.finished = false;
    this.element.classList.add('is-streaming');
    this.element.classList.remove('is-complete', 'has-error', 'is-stopped');
    this.footer.classList.remove('is-visible');
    this.error.hidden = true;
    this.error.replaceChildren();
    if (live) this.setStatus('正在生成…', { spinner: true });
    else this.setStatus('');
  }
  tempKey(index) {
    return 'view-' + (this.transcript.viewSeq - 1) + '-block-' + (index === undefined ? 'tool' : index);
  }
  block(index, type) {
    if (!this.segment) this.beginMessage({ live: false });
    let block = this.blockNodes.get(index);
    if (block) return block;
    const element = el('div', { class: 'md-block', dataset: { block: String(index), type } });
    this.blockNodes.set(index, { type, element, text: '' });
    this.segment.append(element);
    return this.blockNodes.get(index);
  }
  schedule(block) {
    if (this.timers.has(block)) return;
    const timer = setTimeout(() => {
      this.timers.delete(block);
      if (this.finished) return;
      const node = this.blockNodes.get(block);
      if (!node || node.type !== 'text') return;
      node.element.replaceChildren(renderMarkdown(node.text));
    }, 45);
    this.timers.set(block, timer);
  }
  startText(index) { this.block(index, 'text'); }
  appendText(index, delta) {
    const block = this.block(index, 'text');
    block.text += String(delta || '');
    this.schedule(index);
  }
  endText(index, value) {
    const block = this.block(index, 'text');
    block.text = typeof value === 'string' ? value : block.text;
    if (this.timers.has(index)) { clearTimeout(this.timers.get(index)); this.timers.delete(index); }
    block.element.replaceChildren(renderMarkdown(block.text));
  }
  startThinking(index) { this.block(index, 'thinking'); }
  appendThinking(index, delta) {
    const block = this.block(index, 'thinking');
    block.text += String(delta || '');
    this.renderThinking(block);
  }
  endThinking(index, value) {
    const block = this.block(index, 'thinking');
    block.text = typeof value === 'string' ? value : block.text;
    this.renderThinking(block);
  }
  renderThinking(block) {
    if (!block.details) {
      const details = el('details', { class: 'thinking' });
      details.append(el('summary', {}, icon('sparkle', 14), el('span', { text: '思考过程' })));
      block.body = el('div', { class: 'thinking-body' });
      details.append(block.body);
      block.element.replaceChildren(details);
      block.details = details;
    }
    block.body.textContent = bound(block.text, 60000);
  }
  toolStart(index, id, name, args) {
    if (!this.segment) this.beginMessage({ live: false });
    let card;
    if (index !== undefined) {
      const existing = this.blockNodes.get(index);
      if (existing?.type === 'tool') card = existing.card;
      else {
        card = this.transcript.ensureCard(id || this.tempKey(index), name);
        const element = el('div', { class: 'md-block', dataset: { block: String(index), type: 'tool' } });
        element.append(card.element);
        this.blockNodes.set(index, { type: 'tool', element, card });
        this.segment.append(element);
      }
    } else {
      card = this.transcript.ensureCard(id, name);
      if (!card.element.isConnected) this.segment.append(card.element);
    }
    if (id) this.transcript.aliasCard(id, card);
    if (name && (!card.name || card.name === 'tool')) card.name = name;
    card.setStatus('running');
    if (args) card.setArgs(args);
    if (!this.cards.includes(card)) this.cards.push(card);
    return card;
  }
  toolArgs(index, delta, id) {
    let card = index !== undefined ? this.blockNodes.get(index)?.card : null;
    if (!card) card = this.toolStart(index, id, undefined);
    if (id) this.transcript.aliasCard(id, card);
    card.appendArgs(delta);
    return card;
  }
  finishToolCall(index, toolCall) {
    if (!toolCall) return null;
    let card = index !== undefined ? this.blockNodes.get(index)?.card : null;
    if (!card) card = this.toolStart(index, toolCall.id, toolCall.name);
    if (toolCall.id) this.transcript.aliasCard(toolCall.id, card);
    if (toolCall.name) card.name = toolCall.name;
    card.setArgs(toolCall.arguments || {});
    card.setStatus('pending');
    return card;
  }
  toolEnd(id, result, isError, durationMs) {
    const card = this.transcript.ensureCard(id);
    card.setResult(result, isError, durationMs);
  }
  applyMessage(message, { finish = true } = {}) {
    if (!this.segment) this.beginMessage({ live: false });
    else this.blockNodes.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.segment.replaceChildren();
    this.textParts = [];
    const blocks = Array.isArray(message?.content) ? message.content : [];
    blocks.forEach((part, index) => {
      if (part?.type === 'text') {
        const element = el('div', { class: 'md-block', dataset: { block: String(index), type: 'text' } });
        element.replaceChildren(renderMarkdown(part.text || ''));
        this.segment.append(element);
        this.blockNodes.set(index, { type: 'text', element, text: part.text || '' });
        this.textParts.push(part.text || '');
      } else if (part?.type === 'thinking' && part.thinking) {
        const element = el('div', { class: 'md-block', dataset: { block: String(index), type: 'thinking' } });
        const block = { type: 'thinking', element, text: part.thinking };
        this.blockNodes.set(index, block);
        this.renderThinking(block);
        this.segment.append(element);
      } else if (part?.type === 'toolCall') {
        this.toolStart(index, part.id, part.name, part.arguments || {});
      }
    });
    if (!blocks.length && message?.errorMessage) {
      this.segment.append(el('p', { class: 'md-paragraph', text: '本次回复没有产生可用内容。' }));
    }
    if (message?.errorMessage) {
      this.setError(message.errorMessage, { retry: true });
    } else if (message?.stopReason === 'aborted') {
      this.setStopped();
    } else {
      this.error.hidden = true;
      this.error.replaceChildren();
      this.setStatus('');
      if (finish) this.finish();
    }
  }
  finish() {
    this.finished = true;
    this.element.classList.remove('is-streaming');
    this.element.classList.add('is-complete');
    this.footer.classList.add('is-visible');
  }
  setError(message, { retry = true } = {}) {
    this.error.replaceChildren(el('span', { text: message || '生成失败，请重试。' }));
    if (retry) {
      const button = el('button', { type: 'button', class: 'message-error-retry', text: '重试上一条' });
      button.addEventListener('click', () => this.transcript.onRetry?.(this));
      this.error.append(button);
    }
    this.error.hidden = false;
    this.finished = true;
    this.setStatus('');
    this.element.classList.remove('is-streaming');
    this.element.classList.add('has-error');
    this.footer.classList.add('is-visible');
  }
  setStopped() {
    this.finished = true;
    this.setStatus('已停止生成', { tone: 'muted' });
    this.element.classList.remove('is-streaming');
    this.element.classList.add('is-stopped');
    this.footer.classList.add('is-visible');
  }
  getText() { return this.textParts.join('\n\n'); }
  remove() { this.element.remove(); }
}

export class Transcript {
  constructor({ container, welcome, onNotice, onRetry, onContinue }) {
    this.container = container;
    this.welcome = welcome;
    this.onNotice = onNotice;
    this.onRetry = onRetry;
    this.onContinue = onContinue;
    this.cards = new Map();
    this.views = [];
    this.viewSeq = 0;
    this.lastAssistant = null;
    this.welcomeTimer = null;
    this.bind();
  }
  bind() {
    this.container.addEventListener('click', async event => {
      const code = event.target.closest('[data-copy-code]');
      if (code) {
        const pre = code.closest('.code-block')?.querySelector('pre code');
        const ok = await copyText(pre?.textContent || '');
        code.textContent = ok ? '已复制' : '复制失败';
        setTimeout(() => { code.textContent = '复制'; }, 1600);
        return;
      }
      const copy = event.target.closest('[data-copy-message]');
      if (copy) {
        const article = copy.closest('.message');
        let text = '';
        if (article?.classList.contains('message-assistant')) {
          const clone = article.querySelector('.message-content')?.cloneNode(true);
          clone?.querySelectorAll('.code-head, .tool-card, .thinking').forEach(node => node.remove());
          text = clone?.innerText || clone?.textContent || '';
        } else {
          text = article?.querySelector('.user-bubble')?.innerText || '';
        }
        const ok = await copyText(text || '');
        this.onNotice?.(ok ? '已复制消息' : '复制失败，请检查浏览器权限', { tone: ok ? 'success' : 'error' });
      }
    });
  }
  reset() {
    this.container.replaceChildren();
    this.cards.clear();
    this.views = [];
    this.lastAssistant = null;
    if (this.welcomeTimer) { clearTimeout(this.welcomeTimer); this.welcomeTimer = null; }
    this.welcome.classList.remove('is-leaving');
  }
  setWelcome(visible) {
    if (this.welcomeTimer) { clearTimeout(this.welcomeTimer); this.welcomeTimer = null; }
    if (visible) {
      this.welcome.classList.remove('is-leaving');
      this.welcome.hidden = false;
      return;
    }
    if (this.welcome.hidden) return;
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) { this.welcome.hidden = true; return; }
    this.welcome.classList.add('is-leaving');
    this.welcomeTimer = setTimeout(() => {
      this.welcome.hidden = true;
      this.welcome.classList.remove('is-leaving');
      this.welcomeTimer = null;
    }, 150);
  }
  ensureCard(id, name) {
    const key = id || 'tool-' + Math.random().toString(36).slice(2);
    if (this.cards.has(key)) {
      const card = this.cards.get(key);
      if (name) card.name = name;
      return card;
    }
    const card = new ToolCard(this, key, name);
    this.cards.set(key, card);
    return card;
  }
  aliasCard(id, card) {
    if (id && card) this.cards.set(id, card);
  }
  addUser(value, { timestamp = Date.now(), animate = true } = {}) {
    this.setWelcome(false);
    const article = el('article', { class: 'message message-user' + (animate ? ' is-entering' : '') });
    const inner = el('div', { class: 'message-inner' });
    const meta = el('div', { class: 'message-meta' });
    const time = el('time', { class: 'message-time', text: formatClock(timestamp), title: formatDate(timestamp) + ' ' + formatClock(timestamp) });
    const copy = el('button', { type: 'button', class: 'message-action', attrs: { 'aria-label': '复制消息', title: '复制消息', 'data-copy-message': '' } }, icon('copy', 15));
    meta.append(el('strong', { class: 'message-author', text: '你' }), time, copy);
    const bubble = el('div', { class: 'user-bubble' });
    bubble.replaceChildren(renderMarkdown(value));
    inner.append(meta, bubble);
    article.append(inner);
    this.container.append(article);
    return article;
  }
  beginAssistant(options = {}) {
    this.setWelcome(false);
    this.viewSeq += 1;
    const view = new AssistantView(this, options);
    this.views.push(view);
    return view;
  }
  addAssistant(message, { timestamp, animate = false, history = false } = {}) {
    this.setWelcome(false);
    const view = this.beginAssistant({ animate, history });
    view.setTime(timestamp || message?.timestamp);
    view.applyMessage(message);
    return view;
  }
  applyToolResult(message) {
    const card = this.ensureCard(message.toolCallId, message.toolName);
    card.setResult(message.content, message.isError === true);
    if (!card.element.isConnected) {
      this.container.append(el('div', { class: 'tool-standalone' + ' is-entering' }, card.element));
    }
    return card;
  }
  renderSession(messages) {
    let count = 0;
    for (const message of messages || []) {
      if (!message || typeof message !== 'object') continue;
      if (message.role === 'user') {
        const value = textContent(message.content);
        if (!value.trim()) continue;
        this.addUser(value, { timestamp: message.timestamp, animate: false }); count += 1;
      } else if (message.role === 'assistant') {
        const hasContent = Array.isArray(message.content) && message.content.some(part => part?.type === 'text' || part?.type === 'toolCall' || (part?.type === 'thinking' && part.thinking));
        if (!hasContent && !message.errorMessage) continue;
        this.addAssistant(message, { timestamp: message.timestamp, animate: false, history: true }); count += 1;
      } else if (message.role === 'toolResult') {
        this.applyToolResult(message); count += 1;
      }
    }
    return count;
  }
  scrollToBottom() { this.container.scrollTop = this.container.scrollHeight; }
}

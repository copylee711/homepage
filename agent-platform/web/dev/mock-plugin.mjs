// Vite dev-only middleware that emulates the gateway API so the Iris console can be
// previewed without the backend. Never included in the production build.
const now = Date.now();

const state = {
  admin: true,
  me() {
    return {
      csrf: 'dev-csrf', admin: this.admin, can_execute: true,
      model: activeName() || 'Iris 模型',
      grant_expires_at: Math.floor((now + 7 * 864e5) / 1000),
      user: { id: 'dev-user', name: this.admin ? 'Copy Lee' : '示例用户', avatar: '' },
    };
  },
};

const chats = [
  { id: '11111111-1111-4111-8111-111111111111', title: '重构 Iris 控制台界面', updated: now - 6e5, pinned: true, archived: false },
  { id: '22222222-2222-4222-8222-222222222222', title: '用 Python 生成项目说明', updated: now - 36e5, pinned: false, archived: false },
  { id: '33333333-3333-4333-8333-333333333333', title: '推导梯度下降收敛性', updated: now - 9e7, pinned: false, archived: false },
  { id: '44444444-4444-4444-8444-444444444444', title: '清理旧日志脚本', updated: now - 20e7, pinned: false, archived: true },
];

const sampleAssistant = {
  role: 'assistant', timestamp: now - 59e4,
  content: [
    { type: 'thinking', thinking: '用户想要数学与代码混排的示例。我先给出行内与块级公式，再给一段带语法高亮的代码，并引用来源。' },
    { type: 'text', text: '这是一段混排示例。行内公式 $e^{i\\pi}+1=0$ 应当正常渲染，块级公式如下：\n\n$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$\n\n参考资料见文末 [1](https://example.com/calculus "微积分基础")。下面是一段 Python：' },
    { type: 'toolCall', id: 'tool-1', name: 'write', arguments: { path: '/workspace/demo.py', content: 'print("hello")' } },
    { type: 'text', text: '```python\ndef area(r: float) -> float:\n    import math\n    return math.pi * r ** 2\n\nprint(area(2))\n```\n\n完成，你可以在工作区查看 `demo.py`。' },
  ],
};
const sessions = {
  '11111111-1111-4111-8111-111111111111': {
    busy: false,
    messages: [
      { role: 'user', timestamp: now - 6e5, content: '给我一个数学与代码混排的示例，并写入一个文件。' },
      sampleAssistant,
      { role: 'toolResult', toolCallId: 'tool-1', toolName: 'write', isError: false, content: '已写入 /workspace/demo.py（14 字节）。' },
    ],
  },
};

const files = {
  '': [
    { name: 'src', path: 'src', type: 'dir', size: 0 },
    { name: 'demo.py', path: 'demo.py', type: 'file', size: 142 },
    { name: 'README.md', path: 'README.md', type: 'file', size: 512 },
    { name: 'notes.txt', path: 'notes.txt', type: 'file', size: 88 },
  ],
  src: [
    { name: 'main.py', path: 'src/main.py', type: 'file', size: 420 },
    { name: 'utils.py', path: 'src/utils.py', type: 'file', size: 260 },
  ],
};
const fileText = {
  'demo.py': 'import math\n\ndef area(r):\n    return math.pi * r ** 2\n\nprint(area(2))\n',
  'README.md': '# 示例项目\n\n用于预览的示例工作区。\n',
  'notes.txt': '随手记：重构控制台界面。\n',
};

const providers = {
  active: 'opencode-go',
  activeModel: 'deepseek-v4.1-flash',
  providers: [
    { id: 'opencode-go', name: 'OpenCode Go', api: 'openai-completions', baseUrl: 'https://api.opencode.example/v1', model: 'deepseek-v4.1-flash', models: ['deepseek-v4.1-flash', 'deepseek-v4.1', 'qwen3-max', 'kimi-k3'], proxy: false, hasKey: true },
    { id: 'anthropic', name: 'Anthropic', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'], proxy: true, hasKey: true },
    { id: 'openai', name: 'OpenAI GPT', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', models: ['gpt-5', 'gpt-5-mini', 'gpt-6-sol'], proxy: false, hasKey: true },
  ],
  presets: [
    { id: 'gemini', name: 'Google Gemini', api: 'google-generative-ai', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-pro', models: ['gemini-2.5-pro', 'gemini-2.5-flash'], proxy: false },
  ],
};
function activeName() { const p = providers.providers.find(x => x.id === providers.active); return providers.activeModel || p?.model || p?.name; }

const grants = {
  enabled: true,
  users: [
    { id: 'u1', name: '示例用户', email: 'demo@copylee.cn', expires_at: Math.floor((now + 5 * 864e5) / 1000), admin: false, disabled: false },
    { id: 'u2', name: '访客', email: 'guest@copylee.cn', expires_at: 0, admin: false, disabled: false },
  ],
};

function streamEvents(message) {
  const events = [{ type: 'message_start', message: { role: 'assistant', timestamp: Date.now() } }];
  const reply = '收到。' + (/公式|数学|math/i.test(message) ? '行内 $a^2+b^2=c^2$，块级：\n\n$$\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}$$\n\n' : '') +
    '这里是流式回复示例，支持 **Markdown** 与 `行内代码`：\n\n```js\nconst sum = (a, b) => a + b;\nconsole.log(sum(2, 3));\n```\n\n已完成。';
  events.push({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } });
  for (const p of ['先分析任务，', '再给出一段带高亮的代码', '和一个块级公式。'])
    events.push({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: p } });
  events.push({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: '先分析任务，再给出代码和公式。' } });
  events.push({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 1, id: 'live-tool', toolName: 'bash' } });
  events.push({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 1, toolCall: { id: 'live-tool', name: 'bash', arguments: { command: 'echo hi' } } } });
  events.push({ type: 'tool_execution_start', toolCallId: 'live-tool', toolName: 'bash', args: { command: 'echo hi' } });
  events.push({ type: 'tool_execution_end', toolCallId: 'live-tool', result: 'hi\n', isError: false, durationMs: 420 });
  events.push({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 2 } });
  for (const chunk of reply.match(/[\s\S]{1,5}/g) || [])
    events.push({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 2, delta: chunk } });
  events.push({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 2, content: reply } });
  events.push({ type: 'agent_settled', aborted: false });
  return events;
}

function readBody(req) {
  return new Promise(resolve => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } }); });
}

export function devMock() {
  return {
    name: 'iris-dev-mock',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, 'http://localhost');
        const path = url.pathname;
        if (!path.startsWith('/api/') && !path.startsWith('/auth/')) return next();
        const q = url.searchParams;
        const body = req.method === 'POST' ? await readBody(req) : {};
        const send = (data, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };

        if (path === '/auth/logout') return send({ ok: true });
        if (path === '/api/me') return send(state.me());
        if (path === '/api/chats') return send({ chats });
        if (path === '/api/session') return send(sessions[q.get('chat')] || { busy: false, messages: [] });
        if (path === '/api/prompt') {
          res.statusCode = 200; res.setHeader('Content-Type', 'application/x-ndjson');
          const events = streamEvents(body.message || ''); let i = 0;
          const tick = () => { if (i >= events.length) return res.end(); res.write(JSON.stringify(events[i++]) + '\n'); setTimeout(tick, 30); };
          return tick();
        }
        if (path === '/api/abort') return send({ ok: true });
        if (path === '/api/chats/rename') { const c = chats.find(x => x.id === body.thread); if (c) c.title = body.title; return send({ ok: true }); }
        if (path === '/api/chats/pin') { const c = chats.find(x => x.id === body.thread); if (c) c.pinned = body.pinned; return send({ ok: true }); }
        if (path === '/api/chats/archive') { const c = chats.find(x => x.id === body.thread); if (c) c.archived = body.archived; return send({ ok: true }); }
        if (path === '/api/chats/delete') return send({ ok: true });
        if (path === '/api/files') return send({ entries: files[q.get('path') || ''] || [], path: q.get('path') || '', parent: q.get('path') ? '' : null });
        if (path === '/api/files/preview') { const p = (q.get('path') || '').replace(/^\/workspace\/?/, ''); const text = fileText[p] || '（示例预览内容）'; return send({ content: btoa(unescape(encodeURIComponent(text))), size: text.length, truncated: false }); }
        if (path === '/api/files/manage' || path === '/api/files/upload') return send({ ok: true });
        if (path === '/api/providers') return send(providers);
        if (path === '/api/providers/test') return send({ ok: true, detail: '连接成功', route: '直连', latency: 318 });
        if (path === '/api/providers/save') return send(providers);
        if (path === '/api/providers/activate') { providers.active = body.id || providers.active; if (body.model) providers.activeModel = body.model; return send({ active: providers.active, activeModel: providers.activeModel, model: activeName() }); }
        if (path === '/api/grants') return send(grants);
        if (path === '/api/grants/save') return send({ ok: true });
        if (path === '/api/quotas') return send({ disk_mib: 256, memory_mib: 512, cpus: 1, pids: 96, timeout: 180 });
        if (path === '/api/quotas/save') return send({ ok: true });
        if (path === '/api/toolchains') return send({ installed: [], available: [] });
        if (path === '/api/packages') return send({ packages: [] });
        if (path === '/api/web-read') return send({ url: body.url, title: '示例网页', text: '这是经出口代理抓取的网页纯文本预览示例。\n\n第二段内容。', bytes: 1200 });
        if (path === '/api/greeting') { const g = ['今天想做点什么？', '把任务交给我吧', '准备好了，说说想法', '需要我做什么？', '一起把它完成']; return send({ text: g[Math.floor(Math.random() * g.length)] }); }
        return send({ error: 'mock: 未实现 ' + path }, 404);
      });
    },
  };
}

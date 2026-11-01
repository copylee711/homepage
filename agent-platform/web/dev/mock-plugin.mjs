// Vite dev-only middleware that emulates the gateway API so the Iris console can be
// previewed without the backend. Never included in the production build.
import { createHash } from 'node:crypto';

const now = Date.now();
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

const state = {
  admin: true,
  me() {
    return {
      csrf: 'dev-csrf',
      admin: this.admin,
      can_execute: true,
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
  role: 'assistant',
  timestamp: now - 59e4,
  content: [
    {
      type: 'thinking',
      thinking: [
        '1. 用户需要一份同时包含行内公式、块级定积分公式、引用角标与代码高亮的混排示例。',
        '2. 行内公式采用欧拉恒等式 e^{iπ}+1=0，验证与中文正文的基线对齐。',
        '3. 块级公式采用定积分 ∫_0^1 x^2 dx = 1/3，检验 KaTeX 独立行居中排版。',
        '4. 调用沙箱 write 工具在 /workspace/demo.py 写入示例脚本并校验返回字节数。',
        '5. 最后输出完整 Python 面积函数代码块，并在末尾附上工作区文件指引。',
        '6. 检查所有公式定界符闭合与工具卡片状态展示正常。',
      ].join('\n'),
    },
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

// Stateful virtual workspace (includes root lost+found to verify frontend filtering)
const dirs = new Set(['', 'src']);
const fileText = {
  'demo.py': 'import math\n\ndef area(r):\n    return math.pi * r ** 2\n\nprint(area(2))\n',
  'README.md': '# 示例项目\n\n用于预览的示例工作区。\n',
  'notes.txt': '随手记：重构控制台界面。\n',
  'src/main.py': 'from utils import greet\n\nif __name__ == "__main__":\n    print(greet("Iris"))\n',
  'src/utils.py': 'def greet(name: str) -> str:\n    return f"Hello, {name}!"\n',
};

function normPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\/workspace\/?/, '').replace(/^\/+|\/+$/g, '');
}

function listDir(dirPath) {
  const dir = normPath(dirPath);
  const prefix = dir ? dir + '/' : '';
  const entries = [];
  if (dir === '') {
    entries.push({ name: 'lost+found', path: 'lost+found', type: 'dir', size: 0 });
  }
  for (const d of dirs) {
    if (!d || d === dir) continue;
    if (d.startsWith(prefix)) {
      const rest = d.slice(prefix.length);
      if (rest && !rest.includes('/')) entries.push({ name: rest, path: d, type: 'dir', size: 0 });
    }
  }
  for (const [fp, content] of Object.entries(fileText)) {
    if (fp.startsWith(prefix)) {
      const rest = fp.slice(prefix.length);
      if (rest && !rest.includes('/')) {
        entries.push({ name: rest, path: fp, type: 'file', size: Buffer.byteLength(content, 'utf8') });
      }
    }
  }
  entries.sort((a, b) => (a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)));
  return entries;
}

const providers = {
  active: 'opencode-go',
  activeModel: 'deepseek-v4.1-flash',
  providers: [
    { id: 'opencode-go', name: 'OpenCode Go', api: 'openai-completions', baseUrl: 'https://api.opencode.example/v1', model: 'deepseek-v4.1-flash', models: ['deepseek-v4.1-flash', 'deepseek-v4.1', 'qwen3-max', 'kimi-k3'], proxy: false, reasoning: false, hasKey: true },
    { id: 'anthropic', name: 'Anthropic', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'], proxy: true, reasoning: true, hasKey: true },
    { id: 'openai', name: 'OpenAI GPT', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', models: ['gpt-5', 'gpt-5-mini'], proxy: false, reasoning: true, hasKey: true },
  ],
  presets: [
    { id: 'gemini', name: 'Google Gemini', api: 'google-generative-ai', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-pro', models: ['gemini-2.5-pro', 'gemini-2.5-flash'], proxy: true },
    { id: 'deepseek', name: 'DeepSeek 官方', api: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', models: ['deepseek-chat', 'deepseek-reasoner'], proxy: false },
  ],
};
function activeName() {
  const p = providers.providers.find(x => x.id === providers.active);
  return providers.activeModel || p?.model || p?.name;
}

const grants = {
  enabled: true,
  users: [
    { id: 'u1', name: '示例用户', email: 'demo@copylee.cn', expires_at: Math.floor((now + 5 * 864e5) / 1000), admin: false, disabled: false },
    { id: 'u2', name: '访客', email: 'guest@copylee.cn', expires_at: 0, admin: false, disabled: false },
  ],
};

const userQuotas = {
  u1: { disk_mib: 512, memory_mib: 1024, cpus: 1.5, pids: 128, timeout: 240 },
  u2: { disk_mib: 256, memory_mib: 512, cpus: 1, pids: 96, timeout: 180 },
};

const installedPackages = new Map([
  ['pi-skill-web-research', { name: 'pi-skill-web-research', version: '1.2.0', description: '结构化网页检索与交叉核验提示词包。', resources: ['skills/research.md', 'prompts/cite.md'] }],
]);
const catalogPackages = [
  { name: 'pi-skill-web-research', version: '1.2.0', description: '结构化网页检索与交叉核验提示词包。' },
  { name: 'pi-skill-data-science', version: '0.8.4', description: 'Python 数据清洗、统计检验与可视化分析技能。' },
  { name: 'pi-skill-latex-math', version: '1.0.2', description: '严谨数学推导与 KaTeX 排版规范技能。' },
];

const installedToolchains = new Map([['uv', '0.6.9']]);
const toolchainCatalog = [
  { id: 'rust', name: 'Rust 工具链', version: '1.86.0', description: 'rustc + cargo，安装至工作区 .tools/rust。' },
  { id: 'go', name: 'Go 语言环境', version: '1.24.2', description: '官方 Go 编译器与标准库，安装至 .tools/go。' },
  { id: 'uv', name: 'uv (Python 包管理)', version: '0.6.9', description: '极速 Python 虚拟环境与依赖安装器。' },
];

function streamEvents(message, thinking = 'medium') {
  const events = [{ type: 'message_start', message: { role: 'assistant', timestamp: Date.now() } }];
  const reply = '收到。' + (/公式|数学|math/i.test(message) ? '行内 $a^2+b^2=c^2$，块级：\n\n$$\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}$$\n\n' : '') +
    '这里是流式回复示例，支持 **Markdown** 与 `行内代码`：\n\n```js\nconst sum = (a, b) => a + b;\nconsole.log(sum(2, 3));\n```\n\n已完成。';
  if (thinking !== 'off') {
    const steps = [
      `[思考强度: ${thinking}] 1. 解析用户输入的任务目标与上下文约束；`,
      '2. 规划需要的沙箱工具调用与参数边界检查；',
      '3. 验证输出结构（代码块语法高亮与公式排版）；',
      '4. 校验工作区状态，组织简洁清晰的中文总结；',
      '5. 执行 bash 工具并汇总最终响应。',
    ];
    events.push({ type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } });
    for (const p of steps)
      events.push({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: p + '\n' } });
    events.push({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: steps.join('\n') } });
  }
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
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => (b += c));
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
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
        const send = (data, status = 200) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(data));
        };

        if (path === '/auth/logout') return send({ ok: true });
        if (path === '/api/me') return send(state.me());
        if (path === '/api/chats') return send({ chats });
        if (path === '/api/session') return send(sessions[q.get('chat')] || { busy: false, messages: [] });
        if (path === '/api/prompt') {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/x-ndjson');
          const events = streamEvents(body.message || '', body.thinking || 'medium');
          let i = 0;
          const tick = () => {
            if (i >= events.length) return res.end();
            res.write(JSON.stringify(events[i++]) + '\n');
            setTimeout(tick, 30);
          };
          return tick();
        }
        if (path === '/api/abort') return send({ ok: true });
        if (path === '/api/chats/rename') { const c = chats.find(x => x.id === body.thread); if (c) c.title = body.title; return send({ ok: true }); }
        if (path === '/api/chats/pin') { const c = chats.find(x => x.id === body.thread); if (c) c.pinned = body.pinned; return send({ ok: true }); }
        if (path === '/api/chats/archive') { const c = chats.find(x => x.id === body.thread); if (c) c.archived = body.archived; return send({ ok: true }); }
        if (path === '/api/chats/delete') {
          const idx = chats.findIndex(x => x.id === body.thread);
          if (idx >= 0) chats.splice(idx, 1);
          return send({ ok: true });
        }

        // Workspace
        if (path === '/api/files') {
          const cur = normPath(q.get('path') || '');
          const parent = cur ? (cur.includes('/') ? cur.slice(0, cur.lastIndexOf('/')) : '') : null;
          return send({ entries: listDir(cur), path: cur, parent });
        }
        if (path === '/api/files/preview') {
          const p = normPath(q.get('path') || '');
          if (!(p in fileText)) return send({ error: '文件不存在' }, 404);
          const text = fileText[p];
          const bytes = Buffer.from(text, 'utf8');
          return send({
            data: bytes.toString('base64'),
            size: bytes.length,
            truncated: false,
            revision: sha256(text),
          });
        }
        if (path === '/api/files/upload') {
          const p = normPath(body.path);
          if (!p) return send({ error: '路径无效' }, 422);
          if (p in fileText && !body.overwrite) return send({ error: '文件已存在' }, 409);
          if (body.revision && p in fileText && sha256(fileText[p]) !== body.revision) {
            return send({ error: '文件已被其他操作修改' }, 409);
          }
          const parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
          if (parent) dirs.add(parent);
          fileText[p] = String(body.content ?? '');
          return send({ ok: true, revision: sha256(fileText[p]) });
        }
        if (path === '/api/files/manage') {
          const act = body.action;
          const p = normPath(body.path);
          if (act === 'mkdir') { dirs.add(p); return send({ ok: true }); }
          if (act === 'delete') {
            delete fileText[p];
            dirs.delete(p);
            for (const k of Object.keys(fileText)) if (k.startsWith(p + '/')) delete fileText[k];
            return send({ ok: true });
          }
          if (act === 'move') {
            const dest = normPath(body.destination);
            if (p in fileText) { fileText[dest] = fileText[p]; delete fileText[p]; }
            else if (dirs.has(p)) { dirs.delete(p); dirs.add(dest); }
            return send({ ok: true });
          }
          return send({ ok: true });
        }

        // Providers
        if (path === '/api/providers') return send(providers);
        if (path === '/api/providers/test') {
          return send({ ok: true, detail: '连接成功', route: body.config?.proxy ? '代理' : '直连', latency: 214 });
        }
        if (path === '/api/providers/models') {
          const api = body.config?.api || 'openai-completions';
          const catalog = api === 'anthropic-messages'
            ? ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-sonnet-4-5']
            : api === 'google-generative-ai'
              ? ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']
              : ['deepseek-v4.1-flash', 'deepseek-v4.1', 'deepseek-r2', 'qwen3-max', 'qwen3-coder-plus', 'kimi-k3', 'gpt-5', 'gpt-5-mini', 'glm-5-plus'];
          return send({ ok: true, models: catalog, route: body.config?.proxy ? '代理' : '直连', latency: 186 });
        }
        if (path === '/api/providers/save') {
          const cfg = body.config || {};
          const models = Array.isArray(cfg.models) && cfg.models.length ? cfg.models : [cfg.model].filter(Boolean);
          const model = models.includes(cfg.model) ? cfg.model : models[0];
          const item = {
            id: cfg.id,
            name: cfg.name || cfg.id,
            api: cfg.api || 'openai-completions',
            baseUrl: cfg.baseUrl,
            model,
            models,
            proxy: !!cfg.proxy,
            reasoning: !!cfg.reasoning,
            hasKey: true,
          };
          const idx = providers.providers.findIndex(x => x.id === item.id);
          if (idx >= 0) providers.providers[idx] = item;
          else providers.providers.push(item);
          providers.active = item.id;
          providers.activeModel = model;
          return send({ ...providers, model: activeName() });
        }
        if (path === '/api/providers/delete') {
          if (providers.providers.length <= 1) return send({ error: '至少保留一个已配置的供应商' }, 422);
          providers.providers = providers.providers.filter(x => x.id !== body.id);
          if (providers.active === body.id) {
            providers.active = providers.providers[0].id;
            providers.activeModel = providers.providers[0].model;
          }
          return send({ ...providers, model: activeName() });
        }
        if (path === '/api/providers/activate') {
          const target = providers.providers.find(x => x.id === body.id);
          if (!target) return send({ error: '未找到该供应商' }, 404);
          providers.active = target.id;
          providers.activeModel = body.model && target.models.includes(body.model) ? body.model : target.model;
          return send({ active: providers.active, activeModel: providers.activeModel, model: activeName() });
        }

        // Admin & user settings
        if (path === '/api/grants') return send(grants);
        if (path === '/api/grants/save') {
          const u = grants.users.find(x => x.id === body.user_id);
          if (u) u.expires_at = body.days > 0 ? Math.floor(Date.now() / 1000) + body.days * 86400 : 0;
          return send({ ok: true });
        }
        if (path === '/api/quotas') {
          const uid = q.get('user_id') || 'u1';
          return send({
            quota: userQuotas[uid] || { disk_mib: 256, memory_mib: 512, cpus: 1, pids: 96, timeout: 180 },
            used_bytes: 42 * 1048576,
            total_disk_budget_mib: 20480,
            ranges: { disk_mib: [64, 16384], memory_mib: [64, 4096], cpus: [0.1, 4], pids: [16, 256], timeout: [10, 600] },
          });
        }
        if (path === '/api/quotas/save') {
          if (body.user_id && body.quota) userQuotas[body.user_id] = { ...body.quota };
          return send({ ok: true });
        }
        if (path === '/api/toolchains') {
          return send({
            catalog: toolchainCatalog,
            installed: [...installedToolchains.entries()].map(([id, version]) => ({ id, version })),
            job: { state: 'idle', output: '' },
          });
        }
        if (path === '/api/toolchains/change') {
          if (body.action === 'remove') installedToolchains.delete(body.id);
          else installedToolchains.set(body.id, body.version || 'latest');
          return send({ ok: true });
        }
        if (path === '/api/toolchains/cancel') return send({ ok: true });
        if (path === '/api/packages') {
          const kw = (q.get('q') || '').trim().toLowerCase();
          return send({
            installed: [...installedPackages.values()],
            packages: catalogPackages.filter(p => !kw || (p.name + ' ' + p.description).toLowerCase().includes(kw)),
          });
        }
        if (path === '/api/packages/change') {
          if (body.action === 'remove') installedPackages.delete(body.name);
          else {
            const found = catalogPackages.find(p => p.name === body.name) || { name: body.name, version: body.version || '1.0.0', description: '' };
            installedPackages.set(body.name, { ...found, resources: ['skills/main.md'] });
          }
          return send({ ok: true });
        }
        if (path === '/api/web-read') return send({ url: body.url, title: '示例网页', text: '这是经出口代理抓取的网页纯文本预览示例。\n\n第二段内容。', bytes: 1200 });
        if (path === '/api/greeting') {
          const g = ['今天想做点什么？', '把任务交给我吧', '准备好了，说说想法', '需要我做什么？', '一起把它完成'];
          return send({ text: g[Math.floor(Math.random() * g.length)] });
        }
        return send({ error: 'mock: 未实现 ' + path }, 404);
      });
    },
  };
}

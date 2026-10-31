# Pi Agent 平台

入口为 `https://ai.copylee.cn`。gz 的 Caddy 负责 HTTPS 和 `forward_auth`；xa 通过受限
SSH 反向隧道提供 gateway，Compose 管理 gateway 与 Pi runner。`agent.copylee.cn` 继续属于 SRP。

## 认证与权限

浏览器从 ai 跳转到 Homepage `/api/agent/authorize`。已有邮箱、Passkey 或 GitHub 登录均可使用。
授权码 60 秒有效，绑定原 Homepage 会话并使用 S256 PKCE；仅持有服务端客户端密钥的 gateway
可交换。ai 设置独立的 `__Host-copylee_ai` Cookie（Secure、HttpOnly、Path=/、无 Domain，最长 8 小时）。
Homepage 不给新应用扩大主站 Cookie 的域或路径。
Caddy 转发至 xa 时只保留两个 ai 专属 Cookie，剥离既有 Cloud 兼容会话 Cookie，避免把主站会话交给 Agent 服务。

每次访问重新检查原会话、账户停用状态与当前角色。退出原会话、修改密码撤销会话、删除账户时，
关联 Agent 会话级联失效。任务流每 15 秒重新检查权限，失败即中止。应用退出只撤销当前 Agent 会话。
第一阶段仅管理员执行任务；普通用户能完成登录，但没有执行、供应商设置或连接测试权限。
后续普通用户授权须同时完成独立容器隔离，不能直接给共用 runner 开放权限。QQ Bot 不属于此服务。

## 目录与敏感数据

- `compose.yaml`：服务、资源限制与回环端口；不挂载 Docker socket、宿主机目录或 SSH 密钥到 runner。
- `Dockerfile.*`、`package-lock.json`：固定 Node 版本、Pi 1.4.0 及锁定 npm 依赖，安装禁用生命周期脚本。
- `gateway.mjs`：SSO、权限、CSRF、流式代理；`runner.mjs`：Pi RPC、会话和工作目录。
- `web/`：聊天控制台和管理员供应商设置。颜色从主仓库 `src/styles/tokens.css` 在构建时复制。
- `.env.example`、`Caddyfile.example`、`*.service.example`：配置模板；必须按实际环境生成。
- 服务器 `.env`：客户端密钥、内部 runner 密钥、OpenCode Go 密钥，root 0600，禁止提交。
- `data/providers.json`、`data/agent/models.json`：管理员保存的供应商密钥，服务用户 0600；不回显给浏览器。
- `data/sessions/<用户哈希>/<对话 UUID>.jsonl`：Pi 会话；`workspace/<用户哈希>/`：持久化工作区。
  两者以及 `secrets/` 均被 Git 和 Docker 构建上下文忽略。备份这些目录时按敏感数据处理。

runner 使用 UID 1000、只读根文件系统、全部 capability 删除、no-new-privileges、2 CPU、2 GiB 内存
及进程数限制。管理员 Agent 可执行容器内命令，有当前模型的访问权限；隔离范围是容器，不是额外的
虚拟机。首次部署不要挂载个人 SSH、GitHub、云服务或生产数据库密钥。

## 部署

在 xa 将仓库放到 `/opt/homepage`，复制 `.env.example` 为 `.env`，填入独立随机密钥和模型密钥。
在 gz `/etc/copylee/backend.env` 设置 `COPYLEE_AGENT_URL=https://ai.copylee.cn` 以及相同的
`COPYLEE_AGENT_CLIENT_SECRET`，部署并迁移 Homepage 后端（迁移 0019）。

```sh
cd /opt/homepage/agent-platform
install -d -o 1000 -g 1000 -m 700 data workspace
chmod 600 .env
docker compose build
docker compose up -d
docker compose ps
```

构建上下文为仓库根目录，根 `.dockerignore` 采用允许列表。构建不包含 `.env`、会话、工作区等运行数据。
更改服务代码后重新 build；无需删除持久化卷或工作区。

xa 外网下载慢时，可手动运行 GitHub Actions 的 `Build Agent images`，下载短期保留的
`agent-images` 构件，传到 xa 后执行 `docker load -i agent-images.tar.gz`、
`docker compose up -d --no-build`。镜像内不包含任何运行密钥，构建无需服务器或模型凭据。

将 `agent-tunnel.service.example` 安装到 xa 的 systemd，替换 SSH 地址，使用专用 `agent-tunnel` 用户，
校验并固定 gz 的 SSH host key。gz 端公钥限制：

```text
restrict,port-forwarding,permitlisten="127.0.0.1:18081",command="/bin/false" ssh-ed25519 PUBLIC_KEY
```

sshd 再限制该用户仅允许 remote forwarding、`PermitListen 127.0.0.1:18081`、禁用密码、TTY、
agent forwarding、X11 和 GatewayPorts。隧道仅监听 gz 的回环地址。验证 Caddy 配置再 reload，
将 `Caddyfile.example` 中 ai 块合入现有配置，不覆盖其他站点。共享日志 filter 须删除
`X-Agent-Client-Secret`，并将 URL 的 `code`、`state` 值替换为 `REDACTED`。

## 模型与 Mihomo

默认使用 Pi 原生 `opencode-go/deepseek-v4.1-flash`，Compose 将 `OPENCODE_GO_API_KEY` 映射为
Pi 读取的 `OPENCODE_API_KEY`。不把订阅密钥写进前端或镜像。

管理员在“供应商设置”选择 OpenCode Go、OpenAI、Anthropic、Google Gemini、DeepSeek 或自定义
供应商；填写实际模型 ID、HTTPS API 根地址及密钥。支持 Chat Completions、Responses、Messages、
Gemini 协议。未填写密钥表示保留原值，修改地址时必须重新填写密钥。保存时拒绝仍在执行的任务，
关闭空闲 Pi 进程，后续任务使用新配置。现有对话内容保留。

“测试连接”调用 `/api/providers/test`，实际发送短模型请求，返回 HTTP 状态、耗时与直连/Mihomo
路线；不返回上游错误正文或密钥。HTTP 成功但响应格式不匹配也算失败。测试可能消耗少量用量。
只有已提供密钥的供应商才能完成实际调用验证，预设本身不代表已验证账户权限。

代理勾选后只影响对应供应商的 Pi 进程和连接测试。`agent-proxy.service.example` 将私有 Compose
网段 `192.168.84.0/24` 的 `192.168.84.1:17890` 转发到宿主机回环 Mihomo `127.0.0.1:7890`；
不把 Mihomo 监听改成公网地址。部署前确认网段没有冲突。直连模式清除继承的 HTTP(S) 代理变量。
Mihomo 中 Docker blob 的 `cloudflarestorage.com` 与 npm registry 应走代理，避免镜像层及依赖下载卡住。

## 验证与维护

```sh
node --test agent-platform/tests/*.test.mjs
cd backend && uv run pytest tests/test_agent_sso.py -q
```

上线验证包括匿名跳转、管理员登录、普通用户拒绝执行、CSRF、过期与重复授权码、会话撤销、
真实模型调用、工具执行、重启后会话与文件保留、停止任务、代理连通与密钥不回显。
`/healthz` 仅用于容器检查；runner 无宿主机公开端口，`/auth/check` 在公网 Caddy 返回 404。
浏览器刷新或流连接断开会请求停止当前任务；每次任务上限 10 分钟。不要把后台长任务当作已实现能力。

参考：[Pi RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)、
[OpenCode 的 Pi 配置](https://opencode.ai/console/harnesses/pi)、
[Caddy forward_auth](https://caddyserver.com/docs/caddyfile/directives/forward_auth)。

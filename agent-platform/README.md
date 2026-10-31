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
关联 Agent 会话级联失效。任务流每 5 秒重新检查权限，失败即中止。应用退出只撤销当前 Agent 会话。
管理员在侧栏“用户执行授权”按账户授予 1、7 或 30 天权限，或撤销授权。普通用户默认无权限；
登录、绑定 GitHub 均不会自动授予执行权限。供应商配置、连接测试和用户授权管理始终仅管理员可用。
后端 `COPYLEE_AGENT_USER_EXECUTION_ENABLED` 默认 false；必须完成本文权限和沙箱测试后才设为 true。
关闭此开关立即拒绝新的普通用户执行请求，已有任务在权限复检/租约失效后停止。QQ Bot 不属于此服务。

## 目录与敏感数据

- `compose.yaml`：服务、资源限制与回环端口；不挂载 Docker socket、宿主机目录或 SSH 密钥到 runner。
- `Dockerfile.*`、`package-lock.json`：固定 Node 版本、Pi 1.4.0 及锁定 npm 依赖，安装禁用生命周期脚本。
- `gateway.mjs`：SSO、权限、CSRF、流式代理；`runner.mjs`：Pi RPC、会话和工作目录。
- `web/`：聊天控制台和管理员供应商设置。颜色从主仓库 `src/styles/tokens.css` 在构建时复制。
- `.env.example`、`Caddyfile.example`、`*.service.example`：配置模板；必须按实际环境生成。
- 服务器 `.env`：客户端密钥、内部 runner 密钥、OpenCode Go 密钥，root 0600，禁止提交。
- `data/providers.json`、`data/agent/models.json`：管理员保存的供应商密钥，服务用户 0600；不回显给浏览器。
- `data/sessions/<用户哈希>/<对话 UUID>.jsonl`：Pi 会话；`/var/lib/copylee-sandboxes/<用户哈希>.img`：256 MiB 持久化工作区（主机端，不在 runner 中）。
  两者以及 `secrets/` 均被 Git 和 Docker 构建上下文忽略。备份这些目录时按敏感数据处理。

Pi 在受信 runner 中调用模型；禁用默认内置工具和自动扩展，只注册固定 `sandbox-extension.ts` 的
read/write/edit/bash。runner 不挂载任何用户工作区，模型不能通过工具读写 runner 文件。
扩展的所有文件和命令操作均经 host broker 转发进用户自己的临时 Docker 容器，四种工具没有本地回退。
沙箱容器 network=none、UID 1000、只读根、cap_drop ALL、no-new-privileges、256 MiB 内存、0.5 CPU、
48 PIDs；不含模型密钥、服务密钥、执行租约、Docker socket、宿主机配置或其他用户挂载。
每次工具调用结束删除整个容器，后台/脱离进程也会终止；只有 /workspace 持久化。单条命令最多 60 秒，
输出/单次文件读取最多 1 MiB，临时目录 16 MiB。沙箱没有网络，无法下载依赖或访问外部 API。
每个用户的工作区是独立的 256 MiB ext4 镜像，同时限制数据量与 inode 数；最多 16 个用户镜像（约 4 GiB）。
最多同时运行 4 个工具，同用户并行工具自动串行，每用户同时只允许一个任务。
对话另有限额：每用户最多 50 个对话、总计 32 MiB、单对话 4 MiB；运行中每 500 ms 检查，超限停止。
达到容量后已有对话仍可读取，新增内容需联系管理员归档。正在初始化的 Pi 进程不能被当作空闲会话淘汰，
避免并发新建对话留下失去管理的进程。

broker 是主机 root 控制面，拥有有限的固定 Docker 操作和 loop mount 权限。不能把它或 Docker socket
挂进 runner/sandbox；仅监听 Compose 私有网关，校验网段和服务密钥。Pi 只拿到绑定用户的随机短期租约，
不能指定用户、镜像、容器参数、主机路径或网络。网关每 5 秒重新鉴权并续租，租约最多 20 秒；撤权、
停用、登出和账户服务故障停止续租，broker 独立杀掉过期工具。撤销按钮还会主动取消该用户所有任务。
容器仍共享主机内核，并非虚拟机级隔离。

## 部署

在 xa 将仓库放到 `/opt/homepage`，复制 `.env.example` 为 `.env`，填入独立随机密钥和模型密钥。
在 gz `/etc/copylee/backend.env` 设置 `COPYLEE_AGENT_URL=https://ai.copylee.cn` 以及相同的
`COPYLEE_AGENT_CLIENT_SECRET`，部署并迁移 Homepage 后端（迁移 0020）。测试放行前保持 `COPYLEE_AGENT_USER_EXECUTION_ENABLED=false`。

```sh
cd /opt/homepage/agent-platform
install -d -o 1000 -g 1000 -m 700 data
chmod 600 .env
docker compose build
docker build -t copylee-agent-sandbox:latest -f Dockerfile.sandbox ..
# 安装 agent-sandbox.service.example；将 sandbox.env.example 生成为
# /etc/copylee-agent-sandbox.env，root 0600，与 Compose 共用独立 SANDBOX_SECRET。
# 需要主机已有 docker、python3、e2fsprogs、mount；不向用户沙箱提供这些主机权限。
systemctl daemon-reload
systemctl enable --now agent-sandbox
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
restrict,port-forwarding,permitlisten="127.0.0.1:18081",permitlisten="127.0.0.1:17891",command="/bin/false" ssh-ed25519 PUBLIC_KEY
```

sshd 再限制该用户仅允许 remote forwarding、`PermitListen 127.0.0.1:18081 127.0.0.1:17891`、禁用密码、TTY、
agent forwarding、X11 和 GatewayPorts。隧道仅监听 gz 的回环地址。验证 Caddy 配置再 reload，
将 `Caddyfile.example` 中 ai 块合入现有配置，不覆盖其他站点。共享日志 filter 须删除
`X-Agent-Client-Secret`，并将 URL 的 `code`、`state` 值替换为 `REDACTED`。

gz 到 ACME 的直连可能在域名验证成功后仍卡在证书下载。`caddy-acme-proxy.conf.example` 是可选
systemd drop-in，让 Caddy 的证书签发/续期等出站请求通过 gz 回环 `17891` 经隧道使用 xa Mihomo。
本机与 copylee 域名通过 `NO_PROXY` 排除，现有本机反代不走代理；加载环境变量需重启一次 Caddy。
两个反向监听均仅允许回环地址，不能设置 GatewayPorts 或公开代理端口。

## 模型与 Mihomo

默认使用 Pi 原生 `opencode-go/deepseek-v4.1-flash`，Compose 将 `OPENCODE_GO_API_KEY` 映射为
Pi 读取的 `OPENCODE_API_KEY`。不把订阅密钥写进前端或镜像。

管理员在“供应商设置”选择 OpenCode Go、OpenAI、Anthropic、Google Gemini、DeepSeek 或自定义
供应商；填写实际模型 ID、HTTPS API 根地址及密钥。支持 Chat Completions、Responses、Messages、
Gemini 协议。未填写密钥表示保留原值，修改地址时必须重新填写密钥。保存时拒绝仍在执行的任务，
关闭空闲 Pi 进程，后续任务使用新配置。现有对话内容保留。

“测试连接”调用 `/api/providers/test`，实际发送短模型请求，返回 HTTP 状态、耗时与直连/Mihomo
路线；不返回上游错误正文或密钥。HTTP 成功但响应格式不匹配也算失败。测试可能消耗少量用量。
只有管理员可调用这些接口；执行授权不包含模型配置权限。只有已提供密钥的供应商才能完成实际调用验证，预设本身不代表已验证账户权限。

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


## 沙箱上线放行与迁移

先保持普通用户执行开关 false，在候选 runner 中运行下列真实容器验收（会产生两个独立测试工作区）：

```sh
docker exec -i RUNNER_CONTAINER node --input-type=module < tests/sandbox-live.mjs
```

验收覆盖 broker 认证、用户伪造、跨用户访问、凭据与 socket 缺失、禁网、capabilities、UID、资源和磁盘
配额、撤权杀掉脱离子进程、20 秒租约超时。还须实测 Pi 四个工具、会话恢复，以及网关普通用户越权、
授权/撤权/到期和任务中途撤权。在上述测试通过后才启用普通用户开关，仍然需要逐个账户授权。

从旧共用 runner 升级时，先停止活动任务，将旧 `workspace/<hash>/` 的文件复制到对应镜像挂载点
（保留符号链接本身，不跟随链接），保留旧目录作备份；新 runner 不再挂载旧目录。
重启后 broker 按需重新挂载镜像，工作区文件保留。备份时先停止任务、卸载镜像或使用一致性快照；
不能直接复制正在写入的 ext4 镜像。撤权保留文件，不会自动删除镜像；容量回收必须核对账户哈希后由
运维停止任务、卸载对应挂载点，再归档/删除对应镜像。不要递归操作用户控制的路径。

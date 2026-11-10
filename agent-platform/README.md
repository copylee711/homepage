# Pi Agent 平台

入口为 `https://ai.copylee.cn`。gz 的 Caddy 负责 HTTPS 和 `forward_auth`；xa 通过受限
SSH 反向隧道提供 gateway，Compose 管理 gateway、Pi runner 和公网出口。`agent.copylee.cn` 继续属于 SRP。

## 认证与权限

浏览器从 ai 跳转到 Homepage `/api/agent/authorize`。已有邮箱、Passkey 或 GitHub 登录均可使用。
授权码 60 秒有效，绑定原 Homepage 会话并使用 S256 PKCE；仅持有服务端客户端密钥的 gateway
可交换。ai 设置独立的 `__Host-copylee_ai` Cookie（Secure、HttpOnly、Path=/、无 Domain，最长 8 小时）。
Homepage 不给新应用扩大主站 Cookie 的域或路径。
Caddy 转发至 xa 时只保留两个 ai 专属 Cookie，剥离既有 Cloud 兼容会话 Cookie，避免把主站会话交给 Agent 服务。

每次访问重新检查原会话、账户停用状态与当前角色。退出原会话、修改密码撤销会话、删除账户时，
关联 Agent 会话级联失效。回合进行中网关每 10 秒重新检查权限并续租，浏览器离开后仍然继续；登录失效、失去执行权限或撤权会停止回合，账户服务连续失败 5 次也会停止。应用退出只撤销当前 Agent 会话，并停止该用户正在运行的回合。
管理员在侧栏“用户执行授权”按账户授予 1、7 或 30 天权限，或撤销授权。普通用户默认无权限；
登录、绑定 GitHub 均不会自动授予执行权限。供应商配置、连接测试和用户授权管理始终仅管理员可用。
后端 `COPYLEE_AGENT_USER_EXECUTION_ENABLED` 默认 false；必须完成本文权限和沙箱测试后才设为 true。
关闭此开关立即拒绝新的普通用户执行请求，已有任务在权限复检/租约失效后停止。QQ Bot 不属于此服务。

## 目录与敏感数据

- `compose.yaml`：服务、资源限制与回环端口；不挂载 Docker socket、宿主机目录或 SSH 密钥到 runner。
- `Dockerfile.*`、`package-lock.json`：固定 Node 版本、Pi 1.4.0 及锁定 npm 依赖，安装禁用生命周期脚本。
- `gateway.mjs`：SSO、权限、CSRF、流式代理；`runner.mjs`：Pi RPC、会话和工作目录。
- `project-policy.py`：服务端租约绑定项目挂载；`tool-approvals.mjs`：Pi 工具审批请求的一次性确认、超时与取消。
- `web/`：Iris 控制台，Vue 3 + Vite 单页应用（`src/` 源码、`package.json`、`vite.config.mjs`）。`Dockerfile.gateway` 多阶段构建先 `npm ci && npm run build` 生成 `web/dist/`，网关据此提供静态资源；`web/dist`、`web/node_modules` 不进构建上下文。自建中性设计令牌，不再复制主站 `tokens.css`。
- `.env.example`、`Caddyfile.example`、`*.service.example`：配置模板；必须按实际环境生成。
- 服务器 `.env`：客户端密钥、内部 runner 密钥、OpenCode Go 密钥，root 0600，禁止提交。
- `data/providers.json`、`data/agent/models.json`：共享供应商密钥，服务用户 0600；不回显给浏览器。个人供应商在 `data/personal-providers/`，每人的当前模型在 `data/model-choice/`，共享模型用量在 `data/model-usage/`。每个 Pi 进程使用 `data/agent-users/<用户>/`，只包含共享目录和该用户自己的密钥。
- `data/sessions/<用户哈希>/<对话 UUID>.jsonl`：Pi 会话；`data/turns/<用户哈希>/<对话 UUID>.ndjson`：该回合已脱敏的事件日志，供断线后重连，约 30 分钟；`/var/lib/copylee-sandboxes/<用户哈希>.img`：256 MiB 持久化工作区（主机端，不在 runner 中）。
  两者以及 `secrets/` 均被 Git 和 Docker 构建上下文忽略。备份这些目录时按敏感数据处理。

Pi 在受信 runner 中调用模型；禁用默认内置工具和自动扩展，只注册固定 `sandbox-extension.ts` 的
read/write/edit/bash。runner 不挂载任何用户工作区，模型不能通过工具读写 runner 文件。
扩展的工作区文件和命令操作均经 host broker 转发进用户自己的临时 Docker 容器，没有任意本地回退。
唯一的受信读取例外是管理员安装的 Markdown 资源精确路径白名单，让 Pi 能按需读取技能全文；
只允许普通文件、大小 128 KiB 以内，不能列目录或读取供应商配置、进程环境及其他 runner 文件。
沙箱容器使用独立 internal 网络、UID 1000、只读根、cap_drop ALL、no-new-privileges；
默认 512 MiB 内存、1 CPU、96 PIDs、256 MiB 工作区、单条命令 180 秒。管理员可在用户授权列表中
逐个分配磁盘、内存、CPU、进程数和命令时限。磁盘 64–16384 MiB，内存 64–4096 MiB，CPU 0.1–4，
进程 16–256，命令时限 10–600 秒；单次模型回合最长 30 分钟。默认磁盘分配总预算 8192 MiB，
同时运行工具的内存预算 4096 MiB，均由主机环境配置。配额不授予执行权限。
配额保存在主机 root 专用 `quotas.json`；磁盘调整需要用户工具空闲，离线检查/resize2fs，缩容不足则拒绝，
不删除数据强行缩容。每个用户独立 ext4 镜像，最多 16 个用户；新配额在下一次工具调用生效。
容器不含模型密钥、服务密钥、执行租约、Docker socket、宿主机配置或其他用户挂载。
普通工具调用结束后删除容器，普通 shell 的脱离进程终止；持久后台任务通过独立 background_start 管理，安装/构建与预览服务共用该配额。工作区文件持久化。文本预览与图片预览分别受独立大小限制，上传最多 15 MiB，下载按流传输，临时目录 64 MiB。

工具经 `HTTP_PROXY/HTTPS_PROXY` 访问独立出口 `192.168.85.2:3128`，支持公网 HTTP 80 / HTTPS 443，
包括 npm、pip、Git HTTPS 和 curl；SSH/Git 原生端口及直连不开放。出口每次解析并校验所有 IPv4 地址，
拒绝内网/环回/链路本地/云元数据/保留网段，将连接固定到已校验 IP，重定向产生的新请求重新校验。
IPv6 在工具容器关闭。`sandbox-network.sh` 给 INPUT 和 DOCKER-USER 添加专用拒绝规则，不清空已有规则；
broker 在启动时验证 internal 网络和防火墙，缺少保护拒绝启动。工具不能连接宿主机、runner 或 broker。
可配置出口经 Mihomo 的**独立强制代理 listener**：普通基于域名的规则无法匹配已固定的目标 IP。
在 Mihomo 的 `listeners` 中添加 type=http、listen=192.168.84.1、port=17892、proxy=你的出口组，
设置 `.env` 中 `SANDBOX_EGRESS_PROXY=192.168.84.1:17892`；broker 的 `SANDBOX_WEB_PROXY` 可用同一地址。
监听仅绑定私有桥接地址；工具网段的宿主机 INPUT 始终拒绝。原有模型代理和路由规则不改动。
`web_fetch` 提供有长度限制的网页纯文本读取，HTML 脚本不运行，返回内容作为外部数据。

基础工具链为 Python/pip/venv、Node/npm、Git/curl、GCC/G++/make、Python 开发头文件、pkg-config、jq、zip/unzip。
“工具链”面板可安装/移除固定版本 TypeScript、Prettier、ESLint、Ruff、pytest、uv，保存到自己的 `.tools/managed`，
CLI 链接在 `.tools/bin`（自动加入 PATH）。安装任务在沙箱执行；面板定期重新鉴权并续租，失联 20 秒停止。
Agent 可按任务需要自行下载依赖或其他工具链到 `/workspace`；Python 用 `.venv`，npm 本地安装。
不开放 apt/root；Rust/Go/JDK 可从官方公开发行包装入工作区，需管理员分配足够磁盘/内存。
最多同时运行 4 个工具，同用户并行工具自动串行，每用户同时只允许一个任务。
对话记录每账号总计 256 MiB，单对话 32 MiB。运行中每 10 秒检查，超限停止。
达到容量后已有对话仍可读取，新增内容需联系管理员归档。正在初始化的 Pi 进程不能被当作空闲会话淘汰，
避免并发新建对话留下失去管理的进程。

broker 是主机 root 控制面，拥有有限的固定 Docker 操作和 loop mount 权限。不能把它或 Docker socket
挂进 runner/sandbox；仅监听 Compose 私有网关，校验网段和服务密钥。Pi 只拿到绑定用户的随机短期租约，
不能指定用户、镜像、容器参数、主机路径或网络。回合存续期间网关每 10 秒重新鉴权并续租（浏览器离开页面后仍续租），租约最多 20 秒；撤权、
停用、登出和账户服务故障停止续租，broker 独立杀掉过期工具。执行器若超过 30 秒没有成功续租，也会停止该回合。撤销授权会取消该用户所有任务，并停止 purpose 为 install 的后台安装；预览服务不因此停止。
容器仍共享主机内核，并非虚拟机级隔离。

## 部署

首次启用联网时，先 `docker compose up -d egress` 创建 internal 工具网络，再安装更新后的
`agent-sandbox.service.example`（ExecStartPre 自动应用专用防火墙规则），最后设置
`SANDBOX_NETWORK=copylee-agent-tools` 并启动 broker。不配置网络时维持 `none`，依赖下载失败关闭。
Docker daemon 必须运行 iptables 后端并提供 DOCKER-USER；不同防火墙后端需先实现等价策略并测试。

历史读取不启动 Pi；SDK 在服务就绪前预热。会话内存快照按文件 inode/size/mtime/ctime 失效，
保留 Pi 的分支、压缩摘要和 context edit 语义；模型运行中直接读取 live 状态。
客户端只在内存预加载两条最近历史和工作区根目录，切换时先显示快照再更新，无敏感浏览器持久存储。
工作区读快照最多 2 秒，模型运行及写操作会失效；未命中的首次文件读取仍通过一次性容器。

文件面板支持右键/Shift+F10/可见操作按钮、新建、移动重命名、删除空目录/文件、文本编辑。
标题栏眼睛按钮按需显示 `.git`、`.env` 等隐藏文件，默认关闭并在浏览器记住；面包屑单独占一行。
编辑上限 256 KiB，Ctrl/Cmd+S 保存，未保存退出确认；SHA-256 乐观锁拒绝覆盖其他操作的更新，
原子替换避免空间不足留下半个文件。删除需确认，目录非空拒绝，不做隐式递归删除。

“Pi 扩展市场”从 npm 的 `pi-package` 关键词目录搜索。管理员可固定版本安装/移除包内声明的
Markdown 技能和提示词，SHA-512 校验，包压缩体 5 MiB/解压体 32 MiB/最多 30 文本资源。
只解析归档，不在宿主机解包，不安装依赖、不运行 lifecycle 脚本；路径和链接受限。
JS/TS 扩展能运行任意 Node 代码，不能直接加载进持有服务密钥的 runner；无文本资源的包明确拒绝，
需要代码审查及隔离适配。已安装文本可影响模型行为，界面确认后对后续任务生效。

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

xa 直连 deb.debian.org（IPv6）会卡住：在 xa 的 `.env` 写入 `APT_MIRROR=mirrors.aliyun.com`、
`APT_FORCE_IPV4=1`，`Dockerfile.runner` / `Dockerfile.sandbox` 的同名构建参数（默认关闭，行为与不设时相同）
会改写 apt 源并强制 IPv4；`docker compose build` 也会从 `.env` 传给 runner。在 xa 上按 runner → sandbox →
egress → gateway 串行构建、打 `:main-<sha>` 标签、重启并写入版本标记：

```sh
cd /opt/homepage/agent-platform
REVISION=<完整 commit sha> sh scripts/deploy-images.sh
# web/dist 已由同一 commit 构建且 .deployed-web-revision 等于 REVISION 时，可跳过镜像内前端构建：
REVISION=<sha> GATEWAY_WEB=prebuilt sh scripts/deploy-images.sh
```

脚本先把现有 `:latest` 另存为 `:pre-<sha>` 以便回滚；不会改动 `data/`、`.env` 或密钥。
`Dockerfile.gateway.prebuilt` 是 `Dockerfile.gateway` 第二阶段加上预构建的 `web/dist`。

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

项目范围在输入框上方菜单管理，包含主项目、从属项目读写与整个 `/workspace`。
添加从属项目统一使用选择弹窗。下方“需要审批 / 允许编辑 / 自动执行”独立控制工具是否逐次确认；
默认需要审批，安全读取自动放行；允许编辑模式放行文件与记忆编辑，Bash 仍需审批。运行中可切换策略。审批由 Pi `tool_call` 在执行前发起，经 RPC 流送达浏览器，后端校验用户、
会话和一次性请求 ID 后才能允许，120 秒超时或任务取消均拒绝执行。自动执行不会扩大项目范围。
项目目录通过租约绑定到 host broker；只读和未授权目录的限制同时适用于 Bash。
修改权限必须先等待任务停止，下一次任务重建 Pi 进程；旧根目录文件不会被自动搬迁。

Linux 主机执行 `python3 agent-platform/tests/project-mounts-live.py` 可验收真实挂载策略
（`TEST_SANDBOX_IMAGE` 指定候选镜像）。`tests/projects-runner-live.mjs` 与
`tests/approvals-runner-live.mjs` 是可信 runner 内的显式验收脚本，使用独立测试租户；
后者应在隔离临时会话存储的候选 runner 中运行，会调用真实模型。

上线验证包括匿名跳转、管理员登录、普通用户拒绝执行、CSRF、过期与重复授权码、会话撤销、
真实模型调用、工具执行、重启后会话与文件保留、停止任务、代理连通与密钥不回显。
`/healthz` 仅用于容器检查；runner 无宿主机公开端口，`/auth/check` 在公网 Caddy 返回 404。
浏览器刷新、切换标签或关闭页面不会停止正在运行的回合。回合在 runner 上继续，直到模型结束、用户显式停止（`POST /api/abort`）、撤权、登出、存储超限、续租失败或 30 分钟上限。事件留在网关内存，并追加写入 runner 的 `data/turns/`（与会话同样敏感）。恢复进度：`GET /api/turns/status?thread=` 返回 `busy`、`settled`、`cursor`；`POST /api/turns/subscribe`（JSON：`thread`、`cursor`）从游标继续接收 NDJSON。当前 Iris 页面尚未接入这两个接口。被拒绝的新 prompt（例如回合尚未结束）不会取消已在运行的回合。安装和长时间构建不要用 bash 阻塞回合，见下文后台任务。

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
（保留符号链接本身，不跟随链接），保留旧目录作备份；新 runner 不再挂载旧目录。恢复对话前，`session-cwd.mjs` 会把会话头中旧的 cwd
固定到 runner 内空的受信运行目录；消息字节保持不变，原会话头保存在 `.cwd-backup` 中。
不能只迁移工作区而保留旧 cwd，否则 Pi RPC 会因旧目录不存在而退出。
重启后 broker 按需重新挂载镜像，工作区文件保留。备份时先停止任务、卸载镜像或使用一致性快照；
不能直接复制正在写入的 ext4 镜像。撤权保留文件，不会自动删除镜像；容量回收必须核对账户哈希后由
运维停止任务、卸载对应挂载点，再归档/删除对应镜像。不要递归操作用户控制的路径。


## 客户端与文件操作

客户端支持会话搜索、日期分组、置顶、重命名、归档/恢复，以及 Markdown/JSON 导出。
归档不删除 Pi JSONL，也不释放会话配额。新增元数据保存在 `data/chat-meta/<hash>.json`，备份时与
`data/sessions/` 一起按敏感数据保存。模型回复按安全 Markdown 展示，HTML 不执行；消息、代码块
可复制，思考和工具调用可展开。继续会追加指令；重试/回退会保存备份并按用户轮次安全截断，复杂历史会明确拒绝。

右侧工作区提供目录浏览、UTF-8 文本预览、路径插入，以及任意类型文件的上传（最多 15 MiB）和流式下载（支持单段 Range）。文本默认预览 64 KiB，图片预览最多 1 MiB，文本在线编辑最多 256 KiB；预览超限明确提示。同名上传默认拒绝，确认覆盖后
才替换内容。所有文件操作均通过独立用户租约进入沙箱，路径和符号链接在容器内限制到 `/workspace`；
runner 不挂载工作区。浏览时沙箱正在运行命令会提示稍后刷新，不会停止模型任务。

控制台是 Vue 3 + Vite 构建到 `web/dist/` 的单页应用，网关对 `/assets/*` 哈希资源返回不可变缓存、
其余路径回退到 `index.html`（客户端应用，无服务端路由）；KaTeX 与字体本地打包，无 CDN 或新增运行时
依赖。改前端只需重建 gateway 镜像（多阶段会重新 `npm run build`）；文件/执行 API 仍需同时重建
runner 和 sandbox 镜像并更新主机 broker 脚本。UI/权限行为见 `UX-CONTRACT.md`。


## 扫描件识别

将 PDF、PNG 或 JPEG 放入工作区后，可请 Iris 识别整份文件或指定页码。
内置工具 `document_ocr` 在当前项目保存 Markdown，返回页码、识别来源和短预览。
本地 Tesseract 识别中文简体和英文，输出纯文本。在线服务可保留表格结构。

“设置 → 扫描件识别”可为当前账户开启在线识别，并保存 MinerU 或 PaddleOCR AI Studio
Token。开启后，Iris 会向服务商上传选定的页面。顺序为已配置的 MinerU 精准解析、
已配置的 PaddleOCR、MinerU 免密解析、本地 Tesseract。免密接口的每个 PDF 分片最多
20 页和 10 MB。在线识别默认关闭，Token 仅由 runner 保存和使用，配置接口只返回保存状态。

OCR 每次最多处理 200 页，源文件上限为 200 MiB，Token 路径的整批上传上限为 50 MiB。
文件可以从已有工作区路径读取。浏览器普通上传仍受独立的工作区上传限制。
部署时需要更新 gateway、runner、sandbox 镜像和主机上的 sandbox broker。OCR Token
加密使用 `RUNNER_SECRET` 派生密钥。轮换前需备份旧设置，轮换后由管理员移走旧的 `data/ocr` 配置目录，再由用户重新配置。

## 浏览器原生能力（2026-11）

- 三档工具执行策略、运行中切换、结构化 ask_user、任务计划及运行中补充指令。
- 设置页提供账户人设、全局/项目记忆；数据位于 data/memories/，仅当前主项目记忆会加载。
- 独立搜索：百度/Bing/DuckDuckGo、DeepSeek API 预设和自定义 HTTPS JSON 来源。密钥与配置存于 data/search-settings/，不发给模型。
- “能力、MCP 与 Skill”内置三项默认技能，支持个人 Markdown 技能、远程 HTTPS MCP 的 JSON/SSE 工具，以及 Pi 原生上下文统计/压缩。配置与生成的只读技能资源位于 data/features/。
- 后台任务可运行 Vite 等 HTTP 服务，也可运行安装/构建；两项/账户、四项/全局、每项一小时，内存预算与工具容器共享。日志可查看，任务可停止。文件保留；broker 重启会清理任务容器。
- 沙箱的系统 Python 内置 NumPy、pandas、Matplotlib、seaborn、SciPy 和 SymPy，普通命令和后台任务均可直接导入。文档处理内置 python-docx、python-pptx、openpyxl、XlsxWriter、PyPDF2、ReportLab 和 Poppler，设置中提供 DOCX、PPTX、XLSX、PDF 和 grill-me 技能。项目需要虚拟环境时，可以用 `/usr/bin/python3 -m venv --system-site-packages .venv` 创建可读取内置包的环境。已有的隔离虚拟环境保留其项目依赖配置，可用 `/usr/bin/python3` 显式调用系统 Python。
- 安装与构建（`pip install`、`python -m pip install`、`npm install` / `npm ci`、`pnpm`/`yarn`/`bun` install、`cargo build`、`go build`、`mvn`/`gradle` 构建等）不要用 bash。模型应调用 `background_start` 且 `purpose` 为 `install`（不要设置 port）。还有其他工作时继续做；否则调用 `background_wait` 暂停当前回合，任务退出后带着状态和日志继续。bash 遇到这类命令会直接拒绝（退出码 126），避免单次工具容器被长安装占满后删除、进程一起消失。
- 用户停止、撤权、登出、租约丢失和回合上限会停止 `purpose=install` 的任务。预览服务（`purpose=server`）不会因此被停止。回合自然结束后，仍在运行的 install 任务会继续，直到它自己结束、被 `background_stop` 或达到 1 小时。隔离、出口代理和配额与原来的后台任务相同。
- Vite 示例：background_start 的 command 为 `npm run dev -- --host 0.0.0.0 --port 5173 --strictPort --base "$IRIS_PREVIEW_BASE"`，port=5173、previewBase=true。预览走临时私密链接，支持 HTTP，暂不支持 WebSocket/HMR。
- 部署时重建并重启 gateway 与 runner 镜像。在 xa 更新主机 `background-tasks.py` 与 `sandbox-broker.py` 后重启 `agent-sandbox`。本次不改 sandbox 工具镜像里的 `background-worker.py`，也不新增 Compose 环境变量。gz 的 Caddy / `forward_auth` 无新路由；不要为了长回合去缩短反代读超时。浏览器断开后，xa 上的 gateway 会继续占用到 runner 的连接并续租，直到回合结束或授权失效；回合不限思考与运行时长，只有模型与工具连续 10 分钟无任何输出（工具执行中为 35 分钟）才会停止。预览路由仍依赖 gateway 对能力令牌和 CSP sandbox 的校验；不能直接反代到用户容器。

测试：`node --test tests/*.test.mjs`、`python3 tests/web-search.test.py`。真实模型/容器验收脚本为 `tests/interactions-runner-live.mjs`、`tests/memory-background-live.mjs`、`tests/capabilities-live.mjs`，仅在隔离的候选 runner 中按脚本说明执行，使用专用合成账户，不操作真实用户会话。MCP/搜索协议验收使用临时 HTTPS 测试端点，正式部署后移除测试路由。

# 登录与安全

## GitHub OAuth 登录与绑定

服务端环境变量 `COPYLEE_GITHUB_CLIENT_ID` 与 `COPYLEE_GITHUB_CLIENT_SECRET` 同时配置后，
账户页显示 GitHub 登录。密钥保存在服务器 `/etc/copylee/backend.env`（root、0600），
不能写入仓库或前端构建变量。回调地址固定为 `COPYLEE_SITE_URL/account/auth`，正式站为
`https://copylee.cn/account/auth`，与 GitHub OAuth App 的 Redirect URI 保持一致。
独立的 `COPYLEE_GITHUB_TOKEN` 仍只用于仓库同步。

- 已有用户先用邮箱密码或 Passkey 登录，在账户设置的「登录安全」中输入当前密码及已开启的
  两步验证码后绑定 GitHub。绝不根据邮箱、用户名或 GitHub 昵称自动合并、授予管理员权限。
- GitHub 用户数字 ID 是稳定身份，绑定表 `github_identity` 一对一关联本站用户 ID；
  收藏、存储权限、管理员标记、密码与既有 Cloud Cookie 行为均继续使用原账户。
- 未绑定身份仅在开放注册时可注册，必须提供 GitHub 已验证且符合邮箱域名规则的邮箱，
  确认账户说明并设置至少 8 位本站密码，用于现有客户端与安全设置。邮箱冲突要求先登录绑定。
- GitHub 登录仍要求本站已开启的 TOTP 或恢复码。未通过验证不签发会话。
- OAuth 使用随机 state、独立的 HttpOnly 浏览器 Cookie、S256 PKCE 和 10 分钟的数据库挑战；
  授权码交换只能领取一次，重复回调拒绝，后续注册或两步验证无需再次交换授权码。
  只申请 `user:email`，不申请仓库权限、不存储 GitHub 访问令牌。
- 绑定与解绑需要当前会话 CSRF、当前密码与已开启的 TOTP，成功时撤销其他会话及挑战。
  删除用户级联删除 GitHub 绑定；备份包含绑定，恢复时清除一次性挑战。
- 返回目标只接受本站相对路径、配置的主站与 Cloud 精确来源；不将未来 AI 平台加入 Cookie
  或重定向信任范围。未来 SSO 和沙箱权限管理另行实施。

Caddy 必须为 `/account/auth` 提供 SPA 页面，并返回 `Cache-Control: no-store`、
`Referrer-Policy: no-referrer`；访问日志通过 query filter 隐去 `code`、`state` 的值，
页面初始化后立即清除地址栏授权参数。部署示例已包含相关设置；CDN 同样应禁止缓存回调与认证 API。
验证：`cd backend && uv run pytest tests/test_github_oauth.py -q`。

## 邮箱验证码与 ESA

生产的注册和找回密码共用 `POST /api/account/code`。账户页动态加载阿里云官方 SDK，
使用 ESA 场景进行无痕验证，初始化后至少等待 2 秒，再将单次票据放入
`captcha-verify-param` 请求头。取消、失败或加载超时不会发送邮件；发送失败也需要重新验证。
验证通过后仍保留邮箱、IP、每日总量与重发间隔限制。

ESA 控制台的 AI 验证码规则保护 `copylee.cn/api/account/code` 的 POST 请求，
开启「拦截空 Token」。AI 验签发生在边缘，后端不负责验证票据。

### Caddy 回源身份认证

回源防绕过独立于 AI 验证码。ESA 回源请求头规则 `email-code-origin-auth` 仅匹配
`http.host eq "copylee.cn" and http.request.uri.path eq "/api/account/code" and http.request.method eq "POST"`，
用「添加 / 静态」覆盖 `x-copylee-esa-origin`。该头名称沿用现有配置；Caddy 将其作为普通回源密钥，
不依赖阿里云的验签参数或状态码。禁止将密钥注入其他路径、回显给客户端或写入前端。

Caddy 在代理前校验密钥与原始 URI；规范化后落到发送接口的编码路径、重复斜杠与尾斜杠变体均受保护，
只放行原始 `/api/account/code`（允许查询参数）。校验成功后剥离回源密钥和验证码票据再交给后端。
后端只执行原有来源校验、邮箱规则、限流和发信业务，不读取回源密钥或厂商验签结果。
Uvicorn 继续只监听 `127.0.0.1:8000`，不得通过其他反向代理入口公开转发该接口。
Caddy 访问日志过滤 `X-Copylee-Esa-Origin` 和 `Captcha-Verify-Param`，避免记录密钥与票据。

真实密钥只保存在边缘规则与 `/etc/caddy/email-code-origin.caddy`（`root:caddy`、0640）。
主配置显式导入该文件，文件缺失或语法错误时配置校验/重载失败，现有运行配置继续生效。
安装、维护、轮换与停用验证码的方法见[部署指南](../deploy/README.md#邮箱发送接口的回源保护)。
`COPYLEE_EMAIL_CAPTCHA_ENABLED` 仅控制前端 SDK；关闭此项不会关闭 Caddy 入口认证。

验收包括真实票据成功、无效/重复票据、正确 Host/Origin 的源站直连、伪造验签头和路径变体。
Caddy 集成检查执行 `python3 scripts/test-origin-guard.py`，需要已安装 Caddy；测试使用临时本地
端口和假上游，不访问生产数据或发送邮件，并验证正确回源密钥在无厂商票据时也能转发。
本地开发默认关闭 AI 验证码。

[项目首页](../README.md) · [开发指南](development.md) · [内容与接口](content.md) · [登录与安全](security.md) · [备份与恢复](maintenance.md) · [图床](image-host.md) · [部署指南](../deploy/README.md)

## 管理员与会话

系统采用单管理员账号，不提供注册。管理员密码通过命令行初始化或重置，使用 Argon2 哈希存储。登录后台后也可以在「登录安全」页修改密码：修改前需要先验证身份，再输入一次当前密码；新密码至少 12 个字符；修改后其他后台会话退出。浏览器使用 HttpOnly、SameSite=Lax Cookie；生产 HTTPS 开启 Secure。会话令牌随机生成，数据库只保存其哈希。登录失败限制为 15 分钟内 5 次，写接口校验来源与 CSRF，后台及管理接口禁止缓存。

在 `backend/` 执行以下命令并按提示输入新密码：

```bash
uv run python -m app.cli set-admin --username admin
```

公开接口无需登录；管理默认仅允许 Host 为 localhost/127.0.0.1/::1 的本机连接。生产公网管理需同时开启 HTTPS、Secure Cookie 和 `COPYLEE_PUBLIC_ADMIN`，HTTP Caddy 配置另行阻止管理请求。不得将直连后端端口暴露公网。

## 可选 TOTP 与 Passkey

后台「登录安全」可绑定验证器与多个 Passkey，默认均未开启。密码登录在开启 TOTP 后必须提供 6 位验证码或一次性恢复码；Passkey 登录要求设备完成用户验证，直接建立同样的 Cookie 会话。绑定、撤销、关闭 TOTP 和生成恢复码需要重新验证密码，已开启 TOTP 时也需验证当前因素。修改安全因素后撤销其他会话。

TOTP 密钥加密保存在数据库，独立加密密钥为数据目录的 `2fa.key`（0600）；备份工具会一起备份并校验，不能遗漏。恢复码仅返回一次，每个只能用一次；二维码在本机生成，不发送第三方。TOTP 接受相邻时间窗口并拒绝已使用的计数，请保证服务器与设备时钟准确，刚绑定后等下一个验证码再用密码登录。

Passkey 使用 WebAuthn，服务器只保存凭据公钥。挑战 5 分钟有效、单次消费并绑定浏览器 Cookie；注册同时绑定当前登录会话，校验来源、RP ID、签名、用户验证与签名计数。最多绑定 10 个设备，可单独命名、撤销。同步型 Passkey 可使用零签名计数，验证库按 WebAuthn 规范处理。

Passkey 必须从 `COPYLEE_SITE_URL` 的精确地址访问（HTTPS 或 `http://localhost:8000`），不能从 Vite 5173 端口、127.0.0.1 地址或别名注册。设置站点地址时使用无路径的根地址。localhost 的凭据不能用于正式域名；HTTPS 就绪后在正式域名重新绑定。更换正式域名也需要重新绑定。

丢失设备时，通过服务器命令清除因素与所有会话（密码保留）：

```bash
uv run python -m app.cli reset-security --confirm
```

`set-admin` 重置密码保留 TOTP 与 Passkey，同时撤销会话和待完成的 Passkey 挑战；需要全部重新绑定时再执行 `reset-security`。备份恢复保留有效因素与剩余恢复码，但清除登录会话、挑战和未完成的验证器绑定。恢复后先验收密码和因素，再开放公网登录。

## 访客账户的两步验证与 Passkey

访客账户也可以开启 TOTP 两步验证（附 10 个一次性恢复码）和 Passkey，两项都是可选的。账户设置页的「登录安全」会推荐至少开启一项。

- **共用的部分**：TOTP 校验、防重放、恢复码格式和加密密钥 `2fa.key` 都与管理员相同。只要有任一访客开启了两步验证，备份就必须包含 `2fa.key`。
- **分开的部分**：访客的会话、Passkey（`user_passkey`）、挑战（`user_challenge`）和失败计数与管理员完全分开，访客的失败尝试不会让管理员登录被限流。
- **修改安全设置**：每次都需要当前密码；已开启两步验证时，还需要验证码或恢复码。修改完成后，其他设备上的登录会退出。
- **密码登录**：账户开启两步验证后，密码正确但没有填验证码时，接口返回 403「请输入两步验证码或恢复码」，前端随之显示第二步。验证码错误按登录失败计数。
- **邮箱找回密码**：同样需要两步验证码。在用户还没填验证码时，邮箱验证码不会被消耗。
- **Passkey 登录**：使用可发现凭据，不需要先填邮箱。Passkey 本身包含设备验证，所以不再要求 TOTP。
- **站点地址要求**：与管理员一样，请求的 Origin 必须等于 `COPYLEE_SITE_URL`，并且需要 HTTPS（本地可以用 localhost）。
- **用户丢失设备**：管理员在「用户与邮件」中点击「重置安全」，即可清除该用户的两步验证和全部 Passkey，并退出该用户的所有登录。

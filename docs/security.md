# 登录与安全

## 邮箱验证码与 ESA

生产的注册和找回密码共用 `POST /api/account/code`。账户页动态加载阿里云官方 SDK，
使用 ESA 场景进行无痕验证，初始化后至少等待 2 秒，再将单次票据放入
`captcha-verify-param` 请求头。取消、失败或加载超时不会发送邮件；发送失败也需要重新验证。
验证通过后仍保留邮箱、IP、每日总量与重发间隔限制。

ESA 控制台的 AI 验证码规则必须保护 `copylee.cn/api/account/code` 的 POST 请求，
开启「拦截空 Token」。回源请求头规则 `email-code-origin-auth` **仅匹配**
`http.host eq "copylee.cn" and http.request.uri.path eq "/api/account/code" and http.request.method eq "POST"`，
用「添加 / 静态」覆盖 `x-copylee-esa-origin`，值与服务器的 `COPYLEE_ESA_ORIGIN_SECRET` 相同。
禁止将此密钥注入其他路径、回显给客户端或写入前端。域名别名和路径变体不得使用更宽的注入规则，
否则可能在未命中验证码规则时被错误授信。

服务器设置 `COPYLEE_EMAIL_CAPTCHA_ENABLED=true`。启用后，后端在生成验证码和调用 SMTP 前
常量时间比较回源密钥，拒绝缺失/伪造密钥和空票据；缺少服务器密钥时返回 503，禁止降级放行。
后端不信任客户端伪造的 `X-Captcha-Verify-Code`，也不把票据存在当作验签成功。
可信依据是 ESA 先验签、再为该精确接口覆盖注入的回源密钥。
Uvicorn 继续只监听 `127.0.0.1:8000`。Caddy 访问日志过滤
`X-Copylee-Esa-Origin` 和 `Captcha-Verify-Param` 两个请求头，避免记录密钥与票据。
仅检查 Origin、Host 或客户端票据不能阻止源站绕过。

配置顺序：先配置 ESA 验签和精确回源规则，再部署后端和前端并启用环境变量。
密钥轮换需同步更新 ESA 与服务器，期间发送接口可能暂时返回 403。
回滚应回滚应用版本并维持入口保护；不要单独关闭空 Token 拦截或后端校验。
验收应覆盖正常票据、空/无效/重复票据，以及携带正确 Host/Origin、伪造票据和验签结果的源站直连。
本地开发默认关闭 ESA，不向生产申请票据。

[项目首页](../README.md) · [开发指南](development.md) · [内容与接口](content.md) · [登录与安全](security.md) · [备份与恢复](maintenance.md) · [部署指南](../deploy/README.md)

## 管理员与会话

系统采用单管理员账号，不提供注册。管理员密码通过命令行初始化或重置，使用 Argon2 哈希存储。浏览器使用 HttpOnly、SameSite=Lax Cookie；生产 HTTPS 开启 Secure。会话令牌随机生成，数据库只保存其哈希。登录失败限制为 15 分钟内 5 次，写接口校验来源与 CSRF，后台及管理接口禁止缓存。

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

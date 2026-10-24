# 部署指南

[返回项目首页](../README.md)

生产环境使用 Caddy 提供静态资源并反向代理 FastAPI，后端由 systemd 运行。前端产物、后端代码与持久数据分别部署。

## 部署布局

| 路径 | 用途 |
| --- | --- |
| `/var/www/copylee` | 前端构建产物 |
| `/opt/copylee-backend/current` | 当前后端版本 |
| `/var/lib/copylee` | 数据库、上传图片与认证数据 |
| `/etc/copylee/backend.env` | 后端环境配置 |

## 日志留存

按公安备案审核意见，网络日志留存不少于六个月。各日志自动滚动，保留 190 天后自动删除：

| 路径 | 内容 | 滚动方式 |
| --- | --- | --- |
| `/var/log/caddy/copylee.log` | 主站（含 www）访问日志：时间、IP、请求、状态码、UA、Referer | Caddy，50MiB 滚动并压缩 |
| `/var/log/caddy/cloud.log`、`dav.log` | 云盘网页与 WebDAV 访问日志 | 同上 |
| `/var/log/copylee/audit.log` | 访客注册/登录/退出/找回密码/改密/注销，管理员登录与退出 | 后端每日零点（UTC）滚动 |
| `/var/log/sftpgo/sftpgo.log` | SFTPGo 登录、上传、下载、删除等操作 | SFTPGo，50MB 滚动并压缩 |

配置分别在 [Caddyfile.example](Caddyfile.example) 的 `access_log` 片段、[copylee-backend.service](backend/copylee-backend.service) 的 `LogsDirectory` 与 `COPYLEE_LOG_DIR`、[sftpgo.env](sftpgo/sftpgo.env)。日志含 IP 与邮箱，目录仅限 root 与对应服务用户读取。隐私政策页面为 `/privacy`，模板在 `backend/app/templates/privacy.html`。

## 文档与配置

- [后端部署](backend/README.md)：初次安装、systemd、HTTP 验收、HTTPS 启用与后续部署。
- [HTTP Caddy 示例](Caddyfile.http.example)：公开主页与文章，管理请求通过 SSH 隧道访问。
- [HTTPS Caddy 示例](Caddyfile.example)：正式站点与公网管理。
- [备份与恢复](../docs/maintenance.md)：快照格式、图片引用与恢复要求。
- 经 ESA 代理的 `copylee.cn`、`www`、`image` 在源站使用 `tls internal`：Let's Encrypt 校验经 ESA 回源会超时，浏览器看到的是 ESA 边缘证书。改回「仅 DNS」前需先去掉 `tls internal`，让 Caddy 重新申请公开证书。`cloud`、`dav` 不经 ESA，仍由 Caddy 自动申请证书。
- [图床](../docs/image-host.md)：`image.copylee.cn` 的 Caddy 站点、ESA 缓存规则与旧图片迁移。
- [SFTPGo 部署](sftpgo/README.md)：配套文件管理、WebDAV 与 SFTP 服务。

## 邮箱发送接口的回源保护

`POST /api/account/code` 的防绕过由 Caddy 管理，与验证码厂商解耦。
[HTTPS 主配置](Caddyfile.example) 在代理前导入
`/etc/caddy/email-code-origin.caddy`；配置模板是
[email-code-origin.caddy.example](email-code-origin.caddy.example)。
安装时用随机 64 位十六进制密钥替换占位符，文件设为 `root:caddy`、0640。
在边缘回源规则中覆盖写入相同的 `X-Copylee-Esa-Origin` 请求头，
规则精确限制到主站发送接口的 POST 请求。真实密钥禁止提交 Git。
不要把此头注入其他接口，也不要新增绕开 Caddy 保护的公开代理入口。

Caddy 校验原始请求路径与密钥，拒绝缺失/错误密钥和路径变体；放行后移除
`X-Copylee-Esa-Origin` 和 `Captcha-Verify-Param` 再转发给后端。
后端无需保存回源密钥，也不依赖 AI 验签。访问日志继续过滤这两个请求头。

修改后先执行 `caddy validate --config /etc/caddy/Caddyfile`，再执行
`systemctl reload caddy`，随后检查正常流量与源站直连。不要只修改仓库示例而遗漏服务器配置。
回源配置文件是必需的显式导入项，缺失时禁止启用新配置。
首次启用必须先配置边缘回源头、安装 Caddy 保护并验证，再发布不含入口认证的后端。
密钥轮换应同步更新边缘与私密配置并重载 Caddy，期间可能暂时返回 403。
回滚后端时保留 Caddy 保护；若回滚到仍校验密钥的旧版本，需同时恢复其环境密钥及头部转发。

以后停用 AI 验证码：关闭边缘的 AI 验签规则，将
`COPYLEE_EMAIL_CAPTCHA_ENABLED=false` 并重启后端，使账户页停止加载 SDK；
保留回源头规则与 Caddy 保护即可，无需修改后端代码。
更换 CDN 时，在新边缘配置等效的回源头覆盖规则，并同步密钥。
若完全撤掉 CDN，则应在 Caddy 中明确调整访问策略；不要留下无人注入密钥却仍要求密钥的配置。

集成检查：在安装了 Caddy 的环境执行 `python3 scripts/test-origin-guard.py`。
检查使用仓库中的实际代理路由，验证拒绝请求不会触达上游、路径变体被拒绝、
合法回源不依赖任何验证码票据，以及敏感请求头不会转发给后端。

## 前端产物发布

在仓库根目录执行 `npm ci` 和 `npm run build`，将 `dist/` 的全部内容上传到 `/var/www/copylee`，包括 `.vite/manifest.json`。文章模板通过该清单复用前端公共样式。Caddy 路由与初次安装步骤见 [后端部署](backend/README.md)。

百度等平台的站点验证文件保存在仓库的 `public/` 根目录，构建时会复制到 `dist/` 根目录。更新验证文件时应同步提交到 Git，避免仅上传服务器后被下一次 `rsync --delete` 部署删除。验证成功后保留文件。

HTTPS Caddy 示例将 `www.copylee.cn` 永久重定向到 `https://copylee.cn`，保留请求路径与查询参数。站点验证使用正式地址 `https://copylee.cn`。修改仓库示例不会自动更新服务器的 `/etc/caddy/Caddyfile`；前端部署流程只同步静态产物。

## 搜索引擎 Sitemap

提交地址为 `https://copylee.cn/sitemap.xml`。后端动态生成标准 XML urlset，包含主页、SCUT 通知页、游戏大厅和游戏页面、文章与笔记列表、隐私政策，以及已发布文章和公开笔记。发布、撤下文章或更改笔记可见性后，下一次请求即反映变化，无需重新构建前端。

所有链接使用正式域名 `copylee.cn`，中文路径按 UTF-8 URL 编码；文章和笔记的 `lastmod` 使用实际内容更新时间，静态页面不虚构修改时间。后台、API、账号页和草稿不加入 sitemap。`robots.txt` 已声明 sitemap 地址。百度平台填写上述地址即可，提交额度以平台页面为准。

## GitHub Actions

[Deploy](../.github/workflows/deploy.yml) 和 [Deploy backend](../.github/workflows/deploy-backend.yml) 均手动触发，共享部署并发组。前端流程构建并同步静态产物；后端流程执行检查、上传新版本、同步依赖、备份、数据库迁移、重启与健康检查。首次服务器安装需按部署文档单独完成。

| Repository Secret | 用途 |
| --- | --- |
| `DEPLOY_HOST` | 服务器地址 |
| `DEPLOY_USER` | 部署用户 |
| `DEPLOY_SSH_KEY` | SSH 私钥 |
| `DEPLOY_KNOWN_HOSTS` | 已核验的服务器主机密钥 |
| `DEPLOY_PORT` | 可选 SSH 端口，默认 22 |
| `DEPLOY_PATH` | 可选前端目录，默认 `/var/www/copylee` |

后端流程使用 `production` Environment，可配置人工审批。部署用户权限与脚本安装要求见 [后续部署](backend/README.md#后续部署)。生产数据库、图片、密钥和环境文件必须保留在持久数据目录中。

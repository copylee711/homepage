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
- [SFTPGo 部署](sftpgo/README.md)：配套文件管理、WebDAV 与 SFTP 服务。

## 前端部署

在仓库根目录执行 `npm ci` 和 `npm run build`，将 `dist/` 的全部内容上传到 `/var/www/copylee`，包括 `.vite/manifest.json`。文章模板通过该清单复用前端公共样式。Caddy 路由与初次安装步骤见 [后端部署](backend/README.md)。

百度等平台的站点验证文件保存在仓库的 `public/` 根目录，构建时会复制到 `dist/` 根目录。更新验证文件时应同步提交到 Git，避免仅上传服务器后被下一次 `rsync --delete` 部署删除。验证成功后保留文件。

HTTPS Caddy 示例让 `copylee.cn` 与 `www.copylee.cn` 共用路由，直接提供同一份内容。修改仓库示例不会自动更新服务器的 `/etc/caddy/Caddyfile`；前端部署流程只同步静态产物。手动应用配置前先备份服务器原文件，执行 `caddy validate --config /etc/caddy/Caddyfile`，通过后执行 `systemctl reload caddy`。

若启用两个域名，后端 `COPYLEE_ALLOWED_ORIGINS` 应保留原有来源并包含 `https://copylee.cn,https://www.copylee.cn`，修改后重启后端。`COPYLEE_SITE_URL` 仍设为 `https://copylee.cn`，用于 canonical、站点地图等正式链接；Passkey 仅支持在这个正式地址使用。两个域名的登录 Cookie 独立，登录状态不自动共享。

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

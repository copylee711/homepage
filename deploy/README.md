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

## 文档与配置

- [后端部署](backend/README.md)：初次安装、systemd、HTTP 验收、HTTPS 启用与后续部署。
- [HTTP Caddy 示例](Caddyfile.http.example)：公开主页与文章，管理请求通过 SSH 隧道访问。
- [HTTPS Caddy 示例](Caddyfile.example)：正式站点与公网管理。
- [备份与恢复](../docs/maintenance.md)：快照格式、图片引用与恢复要求。
- [SFTPGo 部署](sftpgo/README.md)：配套文件管理、WebDAV 与 SFTP 服务。

## 前端部署

在仓库根目录执行 `npm ci` 和 `npm run build`，将 `dist/` 的全部内容上传到 `/var/www/copylee`，包括 `.vite/manifest.json`。文章模板通过该清单复用前端公共样式。Caddy 路由与初次安装步骤见 [后端部署](backend/README.md)。

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

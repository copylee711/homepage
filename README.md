# Copy Lee Homepage

[copylee.cn](https://copylee.cn) 的个人主页与内容管理系统，基于 Vue 3、FastAPI 和 SQLite 构建。通过网页后台更新主页、管理仓库展示与发布文章，无需重新构建前端。

## 功能

- 主页配置、入口卡片与 GitHub 仓库展示管理。
- Markdown 文章、草稿与发布快照、图片上传。
- 服务端文章渲染、SEO 元信息与站点地图。
- 内容版本检查、明暗主题与移动端布局。
- 单管理员登录，可选 TOTP、恢复码与多设备 Passkey。
- 数据库迁移、备份恢复与手动部署流程。

## 技术栈

| 模块 | 技术 |
| --- | --- |
| 主页与后台 | Vue 3 · TypeScript · Vite |
| 内容服务 | FastAPI · SQLModel · SQLite · Alembic |
| 文章渲染 | Jinja2 · Markdown-it · nh3 |
| 生产运行 | Caddy · Uvicorn · systemd · uv |

## 快速开始

准备 Node.js 22.12+、Python 3.12 和 uv，在仓库根目录执行：

```bash
npm ci
npm run build
cd backend
uv sync --frozen --python 3.12
uv run python -m app.cli migrate
uv run python -m app.cli seed
uv run python -m app.cli set-admin --username admin
uv run uvicorn app.asgi:app --host 127.0.0.1 --port 8000
```

访问 [主页](http://localhost:8000)、[管理后台](http://localhost:8000/admin) 或 [文章列表](http://localhost:8000/posts)。初始化工具不会覆盖已保存内容；本地数据位于 `backend/.data/`。

## 文档

| 文档 | 内容 |
| --- | --- |
| [开发指南](docs/development.md) | 环境准备、前端开发、初始化与检查 |
| [内容与接口](docs/content.md) | 内容更新、发布规则与 API 约定 |
| [登录与安全](docs/security.md) | 会话、TOTP、Passkey 与账号恢复 |
| [备份与恢复](docs/maintenance.md) | 数据快照、图片引用与恢复流程 |
| [部署指南](deploy/README.md) | 前后端部署、Caddy 与 GitHub Actions |
| [内容后端](backend/README.md) | 后端目录与文档索引 |
| [SFTPGo 部署](deploy/sftpgo/README.md) | 配套文件服务 |

## 许可证

[MIT](LICENSE)

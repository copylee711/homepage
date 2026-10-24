# 开发指南

[项目首页](../README.md) · [开发指南](development.md) · [内容与接口](content.md) · [登录与安全](security.md) · [备份与恢复](maintenance.md) · [图床](image-host.md) · [部署指南](../deploy/README.md)

## 环境要求

Node.js 22.12+、npm、Python 3.12 和 uv。前端使用 `package-lock.json`，后端使用 `backend/uv.lock` 固定依赖。

## 本地运行

先在仓库根目录运行 `npm ci` 和 `npm run build`，然后：

```bash
cd backend
uv sync --frozen --python 3.12
uv run python -m app.cli migrate
uv run python -m app.cli seed
uv run python -m app.cli set-admin --username admin
uv run uvicorn app.asgi:app --host 127.0.0.1 --port 8000
```

访问 `http://localhost:8000/`、`/admin`、`/posts`。后端运行目录必须是 `backend/`。本地数据在 `.data/`，不会提交。seed 只在内容未初始化时导入 `seed/` 的快照，重新运行不会覆盖修改。

开发 Vue 时，在另一个终端运行 `npm run dev`，通过 `http://localhost:5173` 访问；Vite 代理 API、文章、图片。文章模板读取生产构建的 CSS，修改公共样式后重新 build。默认允许 localhost:8000 和 localhost:5173 的写请求来源；如果使用 `127.0.0.1` 或其他端口，需要配置 `COPYLEE_ALLOWED_ORIGINS`。

`src/site.config.ts` 和 `src/data/repos.json` 仅保留为初始化内容来源。确需重新生成快照时，手动执行根目录的 `npm run export:seed`，该命令不修改运行数据库。

## 检查

在仓库根目录运行 `npm run build`，执行类型检查并生成生产产物。在 `backend/` 运行：

```bash
uv run --frozen pytest -q
uv run --frozen ruff check app migrations tests
```

后端测试覆盖内容冲突、发布隔离、认证、图片上传、GitHub 同步、SEO 与备份恢复。

## 项目目录

| 目录 | 用途 |
| --- | --- |
| `src/` | Vue 主页、后台与共享内容状态 |
| `backend/app/` | 内容 API、认证、同步与管理工具 |
| `backend/migrations/` | 数据库迁移 |
| `backend/app/templates/` | 文章与列表页面模板 |
| `backend/seed/` | 一次性初始化快照 |
| `deploy/` | Caddy、systemd 与部署脚本 |
| `docs/` | 开发与维护文档 |

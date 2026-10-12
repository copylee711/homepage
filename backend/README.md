# 内容后端

[返回项目首页](../README.md)

FastAPI 内容服务，使用 SQLModel、SQLite 与 Alembic 管理持久数据，提供内容 API、管理员认证、GitHub 同步和服务端文章渲染。依赖由 uv 管理并通过 `uv.lock` 固定。

## 文档

| 文档 | 内容 |
| --- | --- |
| [开发指南](../docs/development.md) | 初始化、运行与检查 |
| [内容与接口](../docs/content.md) | API 约定与发布语义 |
| [登录与安全](../docs/security.md) | 密码、TOTP、Passkey 与账号恢复 |
| [备份与恢复](../docs/maintenance.md) | 数据管理与快照恢复 |
| [后端部署](../deploy/backend/README.md) | systemd、迁移与生产维护 |

## 目录

| 目录 | 用途 |
| --- | --- |
| `app/` | 服务与命令行工具 |
| `migrations/` | 显式数据库迁移 |
| `seed/` | 一次性初始化内容 |
| `app/templates/`、`app/static/` | 文章模板与阅读资源 |
| `tests/` | 后端测试 |

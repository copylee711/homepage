# gz 后端部署

[项目首页](../../README.md) · [部署指南](../README.md)

这些步骤会写服务器，需获得部署授权后执行。当前已确认 Ubuntu 24.04、Python 3.12、Caddy 2.11.7，8000 端口空闲，静态目录 `/var/www/copylee`；实施时再次检查状态。

## 初次安装

1. 安装官方 uv 0.10.4，将可执行文件放到 `/usr/local/bin/uv`。使用已安装 `/usr/bin/python3`，不安装另一套 Python。安装前核对官方发布包与校验值。
2. 创建无交互登录的 `copylee` 服务用户，home 指向 `/var/lib/copylee`。创建数据目录（0711）、图片目录（0755）、`/opt/copylee-backend/releases`、`/etc/copylee`（0700）。代码 release 目录归 copylee，前端目录保留 caddy 读取权限。
3. 将 `backend/` 上传到 `/opt/copylee-backend/releases/<UTC时间-完整commitSHA>/`，忽略 `.venv`、`.data`、`.env` 和缓存。创建 `/opt/copylee-backend/current` 链接到该 release。
4. 从 `.env.example` 创建 `/etc/copylee/backend.env`，权限 0600。不要在其中保存明文管理员密码；GitHub Token 可选，Token 不输出日志。Origin 需与 SSH 隧道的访问地址相同。
5. 以 root 读取环境，再以 copylee 用户执行初始化（以下目录必须替换为实际 current）：

```bash
set -a
source /etc/copylee/backend.env
set +a
cd /opt/copylee-backend/current
runuser -u copylee -- /usr/local/bin/uv sync --frozen --no-dev --python /usr/bin/python3
runuser -u copylee -- .venv/bin/python -m app.cli migrate
runuser -u copylee -- .venv/bin/python -m app.cli seed
runuser -u copylee -- .venv/bin/python -m app.cli set-admin --username admin
```

账号工具交互输入至少 12 字符密码，重置账号将撤销旧会话。首次初始化后 seed 不再覆盖设置。确认 content.db 权限 0600、media 0755、图片 0644；Caddy 只映射 media，不能映射整个数据目录。

可选 TOTP、恢复码和 Passkey 在后台「登录安全」配置。HTTP 阶段仅在隧道的 localhost 验收；正式域名 HTTPS 启用后重新绑定 Passkey。`COPYLEE_SITE_URL` 必须为正式根地址且与浏览器地址完全一致。TOTP 的 `2fa.key` 属于持久数据，权限 0600，由在线备份工具一起备份；不上传 Git，不放入代码或前端目录。重置密码会保留登录因素；丢失设备可通过同一服务用户运行 `python -m app.cli reset-security --confirm` 清除因素并撤销所有会话。上线前由管理员亲自完成真实手机/电脑的绑定、登录与备用恢复码验收。

6. 构建前端，将 `dist/` 上传到 `/var/www/copylee`（包括隐藏的 `.vite/manifest.json`）。将三个 systemd 文件安装到 `/etc/systemd/system/`，执行 daemon-reload，启用 `copylee-backend.service` 和 `copylee-backup.timer`。
7. 验证 `curl --fail http://127.0.0.1:8000/api/health`。先备份当前 Caddyfile，再按 HTTP 示例合并主页路由；保留 cloud 和 dav 两个现有站点。先执行 `caddy validate`，通过后 reload，不重启 SFTPGo。

## HTTP 阶段验收

```bash
# 用户电脑执行，关闭 ~/.ssh/config 中已有的自动转发，单独转发后台。
ssh -o ClearAllForwardings=yes -L 8000:127.0.0.1:8000 gz
```

访问 `http://localhost:8000/admin`。公开 `http://copylee.cn/admin` 和 `/api/auth/*`、`/api/admin/*` 必须返回 403，8000 不开放公网。公开主页、文章、图片和 sitemap 正常访问；缺失路径返回 404。

首次上线依次验证修改简介、发布文章、保存已发布文章的草稿、撤下文章、刷新仓库、上传图片、重启服务和恢复到临时目录。记录 `systemctl show -p MemoryCurrent copylee-backend`、`ps` 的 RSS 及版本接口延迟，不把本地 Windows 内存结果当作服务器结果。

## HTTPS 开启

先确认域名 HTTPS 条件和证书签发，使用 HTTPS Caddy 示例，仅切换主页域名，cloud/dav 保留原有 HTTP 配置。环境设置：

```bash
COPYLEE_SITE_URL=https://copylee.cn
COPYLEE_ALLOWED_ORIGINS=https://copylee.cn,http://localhost:8000
COPYLEE_PUBLIC_ADMIN=true
COPYLEE_SECURE_COOKIE=true
```

公网登录走 HTTPS；Secure Cookie 开启后 HTTP 隧道登录不再作为验收入口。www 重定向到主域名。重启后端并重新登录，核对 canonical、sitemap、Cookie Secure 和后台 CSRF。

## 后续部署

将 `deploy.sh` 安装为 root 拥有的 `/usr/local/sbin/copylee-deploy`（0755），该文件不可被部署用户写入。专用部署用户可上传 releases、写前端目录；sudo 仅授权此部署脚本，不授权任意 systemctl/命令。部署权限本质上允许修改网站服务代码，应只交给可信的仓库 Actions。

Actions 的 Deploy backend：测试 → 上传全新 release → uv frozen 同步 → 在线备份 → 停服务迁移 → 切换 current → 启动与健康检查。前后端工作流共享 deploy 并发组，均手动触发。首次安装不由工作流自动完成，也不会再次 seed。新增迁移前必须评估旧代码兼容性；迁移或健康检查失败会报告错误，不盲目回滚数据库。部署不触碰 `/var/lib/copylee/media`。

## 备份与恢复

定时器按北京时间每日 03:00 执行，随机延后不超过 10 分钟，错过时间会补执行。检查 `systemctl list-timers copylee-backup.timer` 与备份日志。

恢复演练先用备份生成全新临时目录，确认数据库、图片及文章一致，原数据库保持运行。正式回滚时：停止后台和备份定时器 → 从指定快照恢复到新目录 → 将原数据目录移到明确的保留位置 → 切换恢复目录为 `/var/lib/copylee` → 修正服务用户所有权和目录权限 → 选择匹配迁移版本的代码 release → 启动并健康检查 → 重启备份定时器。恢复后旧会话无效，需要登录。

脚本 backup 默认保留 14 份，仅包括已保存内容引用的图片。备份包含管理员哈希，必须保持私有；异机备份由用户选择目标后再配置，第一版没有向 OSS 或其他外部服务传输备份。

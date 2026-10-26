# 云盘（cloud.copylee.cn / dav.copylee.cn）

自研云盘，已替代原先部署的 SFTPGo（旧部署文件见 [legacy/](../legacy/README.md)）。网页、SFTP、WebDAV 访问同一份文件，账户就是站点账户，
配额与图床共用。代码位于 `backend/app/drive/`，前端位于 `src/components/drive/`。

## 独立实现说明

本项目以 MIT 协议发布。云盘为从零编写的独立实现：

- 参考的只是 SFTPGo 的**产品功能**（多协议访问、虚拟目录、配额、分享链接等）以及
  `openapi.yaml` 中的字段含义；没有阅读、复制或翻译其 Go 源码、测试或 Web UI。
- 已归档的迁移工具 `drive-import` 只读取线上 `sftpgo.db` 的**数据**（表结构由实际数据库得到），
  不依赖 SFTPGo 的任何程序。
- 协议实现依赖下列第三方库，许可证均可用于 MIT 项目，发布时保留其版权声明：

| 依赖 | 用途 | 许可证 |
| --- | --- | --- |
| asyncssh | SSH/SFTP 服务 | EPL-2.0 或 GPL-2.0-or-later（选用 EPL-2.0） |
| WsgiDAV | WebDAV 协议 | MIT |
| cheroot | WebDAV 的 WSGI 服务器 | BSD-3-Clause |
| bcrypt | 校验从旧系统导入的密码 | Apache-2.0 |
| alibabacloud-oss-v2 | OSS 挂载点 | Apache-2.0 |

## 架构

```
cloud.copylee.cn ─Caddy─> /var/www/copylee（同一份前端构建）+ /api/* → uvicorn :8000
dav.copylee.cn   ─Caddy─> 127.0.0.1:10080 ┐
SFTP :2022 ───────────────────────────────┤ copylee-drive（python -m app.drive.serve）
                                          ┘
            两个进程共用 app/drive/vfs.py 与 content.db（SQLite WAL）
存储：本地 /var/lib/copylee/drive/<user_id>/；OSS 挂载点（bucket copylee-cloud，前缀 users/<名>/）；
      图床图片以只读的“/图床”目录出现在云盘里，文件仍在 /var/lib/copylee/images。
```

- `vfs.Drive`：把虚拟路径解析到挂载点，统一做路径校验（拒绝 `..`、符号链接逃逸）、只读、
  配额与审计。网页、SFTP、WebDAV 都只通过它访问文件。
- 配额：`storage_plan.quota_bytes` 是云盘与图床共用的总额度；单独设置配额的挂载点（如 OSS
  归档目录）只受自己的配额约束。管理员也按自己的方案计算，可在后台“云盘与图床”中调整。
- 登录：网页用站点账户；SFTP/WebDAV 用 SSH 公钥、应用密码（只存 SHA-256）或从旧系统导入的
  bcrypt 密码，不接受站点密码。失败按登录名与 IP 限流（15 分钟内 10/30 次）。
- 上传：网页端分块（8 MiB）可续传，先写 `drive/.uploads/`，完成后检查配额再放到目标位置；
  SFTP/WebDAV 先写 `drive/.spool/`，客户端断开时丢弃未完成的文件。
- 日志：网页操作写入 `/var/log/copylee/audit.log`，协议进程写入 `/var/log/copylee/drive.log`，
  均保留 190 天。

## 权限

新注册用户默认没有云盘与图床，前台也不显示相应入口。管理员在后台“云盘与图床”中为用户开通、
设置配额、SFTP/WebDAV 登录名与 OSS 挂载点。管理员本人就是带 `is_admin` 标记的站点用户：

```bash
cd /opt/copylee-backend/current
set -a; . /etc/copylee/backend.env; set +a
runuser -u copylee -- .venv/bin/python -m app.cli set-admin --email you@example.com
```

## 部署

1. `/etc/copylee/backend.env` 增加 `deploy/backend/.env.example` 中“云盘”一节的变量，
   `COPYLEE_ALLOWED_ORIGINS` 加入 `https://cloud.copylee.cn`。
2. 主机密钥放在 `/var/lib/copylee/ssh/`（迁移时沿用了旧服务的密钥，指纹未变；重装时从备份恢复这些文件），
   属主 `copylee`，权限 0600。
3. 安装 `deploy/backend/copylee-drive.service` 到 `/etc/systemd/system/` 并启用；
   `deploy.sh` 会在迁移时一起停止、在切换后一起启动它。修改 `deploy.sh` 后需重新安装为
   `/usr/local/sbin/copylee-deploy`。
4. Caddy：`cloud.copylee.cn` 按 `deploy/Caddyfile.example` 改为前端 + `/api` 反代；
   `dav.copylee.cn` 反代 `127.0.0.1:10080`，浏览器直接打开根路径时显示
   `deploy/dav/dav.html`（安装到 `/var/www/dav-landing/`）。
5. 意见反馈接口与邮箱验证码一样受 ESA AI 验证码保护：ESA 控制台的 AI 验证码规则与回源请求头
   规则都要覆盖 `copylee.cn/api/account/feedback` 的 POST，`/etc/caddy/email-code-origin.caddy`
   按示例放行该路径。

## 用量统计

直接改动磁盘文件后用 `drive-rescan` 重新统计用量。

## 迁移遗留

从 SFTPGo 导入的账户可能仍带旧的 bcrypt 密码（`legacy_hash`），SFTP/WebDAV 登录时继续接受，
用户可在云盘设置里移除。旧系统的分享链接已不再跳转，需要时重新创建分享。
导入命令本身已归档到 [legacy/drive-import](../legacy/drive-import/)。

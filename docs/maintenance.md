# 备份与恢复

[项目首页](../README.md) · [开发指南](development.md) · [内容与接口](content.md) · [登录与安全](security.md) · [备份与恢复](maintenance.md) · [图床](image-host.md) · [部署指南](../deploy/README.md)

## 数据范围

本地数据位于 `backend/.data/`；生产数据位于 `/var/lib/copylee/`，与代码和前端产物分离。数据库、图片、TOTP 加密密钥与环境文件不进入 Git，也不属于前端 `rsync --delete` 的同步范围。

## 手动备份与恢复

在 `backend/` 运行：

```bash
uv run python -m app.cli backup
uv run python -m app.cli restore .data/backups/<快照目录> --target .restored-data
```

备份通过 SQLite 在线备份 API 获取数据库快照，检查完整性，复制该快照的草稿、公开正文与配置引用的本地图片，以及图床中的全部图片，并记录 SHA-256。保留最近 14 份完整备份。未被保存内容引用的临时上传图片不进入备份；文件没有自动删除接口。备份仍在同一台机器上，不能防止整盘丢失，可自行复制备份目录到异机存储。

恢复只接受不存在的新目录，先验证校验和及数据库完整性，再原子生成目录；撤销所有旧会话。正式恢复需要停服务，将恢复目录切换为数据目录，并确认数据库迁移版本与所选代码匹配。

启用 TOTP 时，快照包含独立的 `2fa.key`，恢复时必须保留匹配密钥。恢复保留有效的 TOTP、剩余恢复码与 Passkey 公钥，并清除旧会话、验证挑战和未完成的绑定。备份含管理员哈希与认证数据，须保持私有。

## 生产维护

每日备份定时器、迁移前备份与服务器恢复演练见 [后端部署指南](../deploy/backend/README.md#备份与恢复)。账号与设备丢失处理见 [登录与安全](security.md)。

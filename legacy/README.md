# 归档

[项目首页](../README.md) · [云盘](../docs/drive.md)

这里放已停用、不再参与构建、测试与部署的文件，仅作存档。

| 目录 | 内容 |
| --- | --- |
| [sftpgo/](sftpgo/README.md) | 自研云盘上线前使用的 SFTPGo 部署：Docker Compose、品牌与登录页补丁、日志配置。`landing/dav.html` 仍在使用，已移到 [deploy/dav/](../deploy/dav/dav.html)，所以 `install-branding.sh` 不能再原样执行。 |
| [drive-import/](drive-import/README.md) | 从 SFTPGo 的 SQLite 数据库导入账户、挂载点与分享的一次性迁移工具及其测试。 |

仍留在主代码里的迁移遗留见 [docs/drive.md](../docs/drive.md#迁移遗留)：旧 bcrypt 密码登录。

# drive-import（已归档）

[归档说明](../README.md)

从 SFTPGo 的 `sftpgo.db` 导入账户、挂载点与分享，迁移完成后已从后端移除。导入保留原登录名、bcrypt 密码、
SSH 公钥与分享 id；OSS 挂载点沿用原对象前缀，对象不需要搬动。命令可重复执行。

- `importer.py`：原 `backend/app/drive/importer.py`
- `test_drive_import.py`：原 `backend/tests/test_drive_import.py`

需要再次使用时，把两个文件放回原位置，并在 `backend/app/cli.py` 里恢复子命令：

```python
drive = sub.add_parser("drive-import", help="从旧云盘（SFTPGo SQLite）导入账户、挂载点与分享")
drive.add_argument("--source-db", type=Path, required=True)
drive.add_argument("--map", action="append", required=True, metavar="旧用户名=站点邮箱")
drive.add_argument("--copy-files", action="store_true", help="同时复制旧主目录中的文件")
drive.add_argument("--create-missing", action="store_true", help="邮箱未注册时新建站点用户")
drive.add_argument("--apply", action="store_true", help="实际执行；默认只列出计划")

# ...

elif args.action == "drive-import":
    from .drive.importer import run

    mapping = {}
    for item in args.map:
        name, _, email = item.partition("=")
        if not name or "@" not in email:
            parser.error(f"--map 格式应为 旧用户名=站点邮箱：{item}")
        mapping[name] = email
    engine = make_engine(settings)
    try:
        for line in run(settings, engine, args.source_db, mapping, args.apply,
                        args.copy_files, args.create_missing):
            print(line)
    finally:
        engine.dispose()
    if not args.apply:
        print("确认无误后先执行 backup，再加 --apply 实际导入")
```

用法：

```bash
runuser -u copylee -- .venv/bin/python -m app.cli drive-import --source-db /path/sftpgo.db \
  --map copy=you@example.com --map HK=hk@example.com --create-missing
# 确认后执行备份，再加 --apply；--copy-files 需要能读取旧主目录（以 root 运行后再 chown）
```

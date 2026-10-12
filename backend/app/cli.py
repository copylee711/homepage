import argparse
import getpass
import hashlib
import json
import re
import shutil
import sqlite3
import tempfile
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlmodel import Session

from .auth import set_admin
from .content import initialize
from .database import make_engine
from .settings import Settings

ROOT = Path(__file__).resolve().parents[1]
MEDIA_PATTERN = re.compile(r"/media/([a-f0-9]{48}\.(?:jpg|png|webp|gif))")


def migrate(settings: Settings):
    config = Config(str(ROOT / "alembic.ini"))
    config.attributes["engine"] = make_engine(settings)
    command.upgrade(config, "head")
    config.attributes["engine"].dispose()


def seed(settings: Settings):
    engine = make_engine(settings)
    with Session(engine) as session:
        inserted = initialize(
            session,
            json.loads((ROOT / "seed/site.json").read_text("utf-8")),
            json.loads((ROOT / "seed/repos.json").read_text("utf-8")),
        )
    engine.dispose()
    return inserted


def file_hash(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def backup(settings: Settings, output: Path | None = None) -> Path:
    output = output or settings.data_dir / "backups"
    output.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".pending-", dir=output))
    try:
        if not settings.db_path.exists():
            raise ValueError("数据库不存在")
        with closing(
            sqlite3.connect(f"file:{settings.db_path.resolve().as_posix()}?mode=ro", uri=True)
        ) as source:
            with closing(sqlite3.connect(stage / "content.db")) as destination:
                source.backup(destination)
        with closing(sqlite3.connect(stage / "content.db")) as snapshot:
            if snapshot.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("数据库备份完整性检查失败")
            values = [row[0] for row in snapshot.execute("SELECT value FROM content")]
            for draft, published in snapshot.execute("SELECT draft, published FROM article"):
                values.extend([draft, published or ""])
            columns = {row[1] for row in snapshot.execute("PRAGMA table_info(administrator)")}
            needs_key = "totp_secret" in columns and snapshot.execute(
                "SELECT 1 FROM administrator WHERE totp_secret IS NOT NULL OR pending_secret IS NOT NULL"
            ).fetchone()
        key = settings.data_dir / "2fa.key"
        if needs_key and not key.is_file():
            raise ValueError("两步验证密钥缺失，不能创建可恢复备份")
        if key.is_file():
            shutil.copyfile(key, stage / "2fa.key")
            (stage / "2fa.key").chmod(0o600)
        references = set(MEDIA_PATTERN.findall("\n".join(values)))
        (stage / "media").mkdir()
        for name in references:
            source = settings.media_dir / name
            if not source.is_file() or source.is_symlink():
                raise ValueError(f"引用的图片不存在：{name}")
            shutil.copyfile(source, stage / "media" / name)
        files = ["content.db"] + [f"media/{name}" for name in sorted(references)]
        if (stage / "2fa.key").is_file():
            files.append("2fa.key")
        manifest = {"format": 1, "files": {name: file_hash(stage / name) for name in files}}
        (stage / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        name = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        target = output / name
        stage.rename(target)
        complete = sorted(
            p for p in output.iterdir() if p.is_dir() and re.fullmatch(r"\d{8}T\d{12}Z", p.name)
        )
        for old in complete[:-14]:
            # 仅清理本工具格式、位于指定备份目录中的旧备份。
            if (old / "manifest.json").is_file() and not old.is_symlink():
                shutil.rmtree(old)
        return target
    except Exception:
        shutil.rmtree(stage)
        raise


def restore(source: Path, target: Path):
    if target.exists():
        raise ValueError("恢复目标必须是不存在的新目录；停止服务后再切换数据目录")
    manifest = json.loads((source / "manifest.json").read_text("utf-8"))
    if manifest.get("format") != 1 or "content.db" not in manifest.get("files", {}):
        raise ValueError("备份格式无效")
    for name, expected in manifest["files"].items():
        if name not in {"content.db", "2fa.key"} and not re.fullmatch(
            r"media/[a-f0-9]{48}\.(jpg|png|webp|gif)", name
        ):
            raise ValueError("备份包含非法路径")
        if (source / name).is_symlink() or file_hash(source / name) != expected:
            raise ValueError(f"备份校验失败：{name}")
    target.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".restore-", dir=target.parent))
    try:
        (stage / "media").mkdir()
        for name in manifest["files"]:
            shutil.copyfile(source / name, stage / name)
            if name in {"content.db", "2fa.key"}:
                (stage / name).chmod(0o600)
        with closing(sqlite3.connect(stage / "content.db")) as connection:
            if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("数据库恢复完整性检查失败")
            connection.execute("DELETE FROM login_session")
            connection.execute("DELETE FROM login_attempt")
            tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if "auth_challenge" in tables:
                connection.execute("DELETE FROM auth_challenge")
                connection.execute("UPDATE administrator SET pending_secret=NULL, pending_expires=0")
            connection.commit()
        stage.rename(target)
    except Exception:
        shutil.rmtree(stage)
        raise


def main():
    parser = argparse.ArgumentParser(description="Copy Lee 数据管理工具")
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("migrate")
    sub.add_parser("seed")
    admin = sub.add_parser("set-admin")
    admin.add_argument("--username", default="admin")
    reset = sub.add_parser("reset-security", help="清除 TOTP、恢复码、Passkey 和所有会话")
    reset.add_argument("--confirm", action="store_true", required=True)
    save = sub.add_parser("backup")
    save.add_argument("--output", type=Path)
    load = sub.add_parser("restore")
    load.add_argument("source", type=Path)
    load.add_argument("--target", type=Path, required=True)
    args = parser.parse_args()
    settings = Settings()
    if args.action == "migrate":
        migrate(settings)
        print("数据库迁移完成")
    elif args.action == "seed":
        print("初始内容已导入" if seed(settings) else "内容已存在，未覆盖")
    elif args.action == "set-admin":
        password = getpass.getpass("管理员密码（至少 12 字符）：")
        if password != getpass.getpass("再次输入密码："):
            parser.error("两次密码不一致")
        engine = make_engine(settings)
        with Session(engine) as session:
            set_admin(session, args.username, password)
        engine.dispose()
        print("账号已设置，旧会话已撤销")
    elif args.action == "backup":
        print(backup(settings, args.output))
    elif args.action == "reset-security":
        reset_security(settings)
        print("登录因素与旧会话已清除，管理员密码保留")
    else:
        restore(args.source, args.target)
        print(f"已恢复到 {args.target}，旧会话已清除")


def reset_security(settings):
    from sqlalchemy import delete

    from .models import Administrator, AuthChallenge, LoginAttempt, LoginSession, Passkey
    engine = make_engine(settings)
    with Session(engine) as session:
        admin = session.get(Administrator, 1)
        if admin:
            admin.totp_secret = admin.pending_secret = None
            admin.pending_expires, admin.last_totp_step, admin.recovery_hashes = 0, -1, []
            session.add(admin)
        for model in (AuthChallenge, Passkey, LoginSession, LoginAttempt):
            session.exec(delete(model))
        session.commit()
    engine.dispose()


if __name__ == "__main__":
    main()

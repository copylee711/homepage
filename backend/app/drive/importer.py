"""从旧云盘（SFTPGo 的 SQLite 数据库）导入账户、挂载点与分享。

只读取数据库中的数据，不依赖旧系统的程序。每个旧用户都要映射到一个已注册的站点用户；
原登录名、bcrypt 密码与 SSH 公钥原样保留，客户端无需重新配置。
OSS 挂载沿用原来的对象前缀，对象本身不需要搬动。可以重复执行，已导入的内容会跳过。
"""

import json
import math
import secrets
import shutil
import sqlite3
import time
import uuid
from contextlib import closing
from pathlib import Path

from sqlmodel import Session, select

from .. import storage
from ..models import DriveCredential, DriveMount, DriveShare, User
from . import accounts
from .errors import DriveError
from .vfs import ensure_root, rescan

MIB = 1024 * 1024
S3_PROVIDER = 1


def load(value) -> object:
    if value is None:
        return None
    if isinstance(value, bytes):
        value = value.decode()
    return json.loads(value) if value else None


def read_source(path: Path) -> dict:
    with closing(sqlite3.connect(f"file:{path.resolve().as_posix()}?mode=ro", uri=True)) as db:
        db.row_factory = sqlite3.Row
        users = {row["id"]: dict(row) for row in db.execute("SELECT * FROM users")}
        folders = {row["id"]: dict(row) for row in db.execute("SELECT * FROM folders")}
        mappings = [dict(row) for row in db.execute("SELECT * FROM users_folders_mapping")]
        shares = [dict(row) for row in db.execute("SELECT * FROM shares")]
    return {"users": users, "folders": folders, "mappings": mappings, "shares": shares}


def folder_mount(folder: dict, mapping: dict, username: str) -> tuple[dict | None, str]:
    """把旧的虚拟目录换算成挂载点；不支持的类型返回原因。"""
    filesystem = load(folder["filesystem"]) or {}
    if filesystem.get("provider") != S3_PROVIDER:
        return None, f"虚拟目录 {mapping['virtual_path']} 不是 S3/OSS 存储，已跳过"
    config = filesystem.get("s3config") or {}
    prefix = (config.get("key_prefix") or "").replace("%username%", username)
    if not prefix:
        return None, f"虚拟目录 {mapping['virtual_path']} 没有对象前缀，已跳过"
    quota = mapping.get("quota_size") or 0
    return {"path": mapping["virtual_path"], "location": prefix, "bucket": config.get("bucket"),
            "quota": max(quota, 0)}, ""


def plan(source: dict, mapping: dict[str, str]) -> list[dict]:
    by_name = {user["username"]: user for user in source["users"].values()}
    missing = set(mapping) - set(by_name)
    if missing:
        raise ValueError(f"旧系统中没有这些用户：{', '.join(sorted(missing))}")
    result = []
    for name, email in mapping.items():
        user = by_name[name]
        mounts, notes = [], []
        for item in source["mappings"]:
            if item["user_id"] != user["id"]:
                continue
            mount, note = folder_mount(source["folders"][item["folder_id"]], item, name)
            if mount:
                mounts.append(mount)
            else:
                notes.append(note)
        shares = [share for share in source["shares"] if share["user_id"] == user["id"]]
        result.append({"login": name, "email": email.strip().lower(), "user": user,
                       "mounts": mounts, "shares": shares, "notes": notes,
                       "keys": load(user["public_keys"]) or []})
    return result


def create_user(session: Session, email: str, name: str) -> User:
    """为旧账户新建站点用户；密码随机且不告知，可用邮箱验证码重置后登录网页。"""
    from ..accounts import hash_password
    from ..content import timestamp

    user = User(id=uuid.uuid4().hex, email=email, name=name,
                password_hash=hash_password(secrets.token_urlsafe(24)), created_at=timestamp())
    session.add(user)
    session.commit()
    return user


def import_user(session: Session, settings, item: dict, copy_files: bool,
                create_missing: bool = False) -> list[str]:
    log = list(item["notes"])
    target = session.exec(select(User).where(User.email == item["email"])).first()
    if target is None and create_missing:
        target = create_user(session, item["email"], item["login"])
        log.append(f"新建站点用户 {item['email']}")
    if target is None:
        raise ValueError(f"站点上没有注册邮箱 {item['email']}，请先注册再导入")
    old = item["user"]
    quota = old["quota_size"] or 0
    storage.save(session, target.id, drive_enabled=True,
                 quota_mb=max(math.ceil(quota / MIB), 1) if quota else None)
    root = ensure_root(session, settings, target.id)
    session.commit()
    password = old["password"] or ""
    accounts.set_login(session, target.id, item["login"],
                       legacy_hash=password if password.startswith("$2") else "")
    log.append(f"{item['login']} → {item['email']}，配额 {quota / MIB / 1024:g} GiB")
    known = {row.fingerprint for row in session.exec(
        select(DriveCredential).where(DriveCredential.user_id == target.id))}
    for key in item["keys"]:
        try:
            _, fingerprint, _ = accounts.parse_key(key)
            if fingerprint in known:
                continue
            accounts.add_key(session, target.id, "旧云盘导入", key)
            known.add(fingerprint)
            log.append(f"导入公钥 {fingerprint}")
        except DriveError as error:
            log.append(f"公钥无法导入：{error.message}")
    for mount in item["mounts"]:
        exists = session.exec(select(DriveMount).where(
            DriveMount.user_id == target.id, DriveMount.path == mount["path"])).first()
        if exists:
            continue
        if settings.oss_bucket and mount["bucket"] and mount["bucket"] != settings.oss_bucket:
            log.append(f"挂载点 {mount['path']} 使用 bucket {mount['bucket']}，与当前配置不同")
        accounts.add_mount(session, target.id, mount["path"], "oss", mount["location"],
                           mount["quota"], False)
        log.append(f"挂载 {mount['path']} → oss:{mount['location']}")
    for share in item["shares"]:
        if session.get(DriveShare, share["share_id"]) is not None:
            continue
        hashed = share.get("password") or ""
        session.add(DriveShare(
            id=share["share_id"], user_id=target.id, name=share["name"] or share["share_id"],
            paths=load(share["paths"]) or [], mode="upload" if share["scope"] == 2 else "read",
            password_hash=hashed if hashed.startswith("$2") else "",
            expires_at=(share["expires_at"] or 0) / 1000, max_uses=share["max_tokens"] or 0,
            used=share["used_tokens"] or 0, created_at=(share["created_at"] or 0) / 1000,
            last_used=(share["last_use_at"] or 0) / 1000 or None,
        ))
        log.append(f"分享 {share['share_id']}（{share['name']}）")
    session.commit()
    if copy_files:
        source = Path(old["home_dir"])
        destination = settings.drive_dir / root.location
        if source.is_dir():
            shutil.copytree(source, destination, dirs_exist_ok=True, symlinks=False)
            log.append(f"复制文件 {source} → {destination}")
        else:
            log.append(f"旧主目录 {source} 不存在，未复制文件")
    return log


def run(settings, engine, source_db: Path, mapping: dict[str, str], apply: bool,
        copy_files: bool, create_missing: bool = False) -> list[str]:
    items = plan(read_source(source_db), mapping)
    if not apply:
        lines = []
        for item in items:
            lines.append(f"{item['login']} → {item['email']}：公钥 {len(item['keys'])} 个，"
                         f"挂载点 {[m['path'] for m in item['mounts']]}，分享 {len(item['shares'])} 个")
            lines.extend(item["notes"])
        return lines
    lines = []
    with Session(engine) as session:
        for item in items:
            lines.extend(import_user(session, settings, item, copy_files, create_missing))
            user = session.exec(select(User).where(User.email == item["email"])).one()
            started = time.time()
            for row in rescan(engine, settings, user.id):
                lines.append(f"用量 {row['path']}：{row['size']} 字节 / {row['files']} 个文件")
            lines.append(f"统计用时 {time.time() - started:.1f} 秒")
    return lines

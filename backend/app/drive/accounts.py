"""云盘账户：开通、协议登录名、SSH 公钥与应用密码，以及 SFTP/WebDAV 的登录校验。

协议登录不接受站点密码：WebDAV 每次请求都携带凭据，客户端常把它明文保存在配置里，
因此改用可随时撤销的应用密码。从旧系统导入的 bcrypt 密码继续有效，旧客户端无需重新配置。
"""

import re
import secrets
import shutil
import string
import time
import uuid

import bcrypt
from sqlalchemy import delete
from sqlmodel import Session, select

from .. import storage
from ..auth import digest
from ..models import (
    DriveAccount,
    DriveCredential,
    DriveMount,
    DriveShare,
    DriveUpload,
    LoginAttempt,
    User,
)
from . import paths
from .errors import Conflict, Invalid, NotFound
from .vfs import ensure_root, make_backend

LOGIN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$")
CREDENTIAL_LIMIT = 20
FAILURE_WINDOW = 900
APP_ALPHABET = string.ascii_lowercase + string.digits


def login_key(value: str) -> str:
    return value.strip().lower()


def find_user(session: Session, login: str) -> User | None:
    key = login_key(login)
    account = session.exec(select(DriveAccount).where(DriveAccount.login_key == key)).first()
    if account is not None:
        return session.get(User, account.user_id)
    return session.exec(select(User).where(User.email == key)).first() if "@" in key else None


def usable(session: Session, user: User | None) -> bool:
    return (user is not None and not user.disabled and storage.plan(session, user.id).drive_enabled
            and storage.agreed(session, user.id))


# —— 登录限流（与网页登录共用 LoginAttempt 表，键名不同）——


def blocked(session: Session, login: str, ip: str) -> bool:
    now = time.time()
    for key, limit in ((f"drive:{digest(login_key(login))}", 10), (f"drive-ip:{digest(ip)}", 30)):
        attempt = session.get(LoginAttempt, key)
        if attempt and now - attempt.window_start < FAILURE_WINDOW and attempt.failures >= limit:
            return True
    return False


def fail(session: Session, login: str, ip: str):
    now = time.time()
    for key in (f"drive:{digest(login_key(login))}", f"drive-ip:{digest(ip)}"):
        attempt = session.get(LoginAttempt, key) or LoginAttempt(key=key, window_start=now)
        if now - attempt.window_start >= FAILURE_WINDOW:
            attempt.window_start, attempt.failures = now, 0
        attempt.failures += 1
        session.add(attempt)
    session.commit()


def check_password(session: Session, login: str, password: str,
                   require_drive: bool = True) -> User | None:
    """应用密码或导入的旧密码；成功返回用户，失败返回 None（由调用方计入失败次数）。

    require_drive=False 用于团队空间：成员不需要开通个人云盘，团队权限由调用方另行检查。
    """
    user = find_user(session, login)
    allowed = usable(session, user) if require_drive else user is not None and not user.disabled
    if not allowed or not password:
        return None
    row = session.exec(select(DriveCredential).where(
        DriveCredential.user_id == user.id, DriveCredential.kind == "app_password",
        DriveCredential.secret == digest(password.strip()),
    )).first()
    if row is not None:
        row.last_used = time.time()
        session.add(row)
        session.commit()
        return user
    account = session.get(DriveAccount, user.id)
    if account and account.legacy_hash.startswith("$2"):
        try:
            if bcrypt.checkpw(password.encode(), account.legacy_hash.encode()):
                return user
        except ValueError:
            return None
    return None


def check_key(session: Session, login: str, fingerprint: str) -> User | None:
    user = find_user(session, login)
    if not usable(session, user):
        return None
    row = session.exec(select(DriveCredential).where(
        DriveCredential.user_id == user.id, DriveCredential.kind == "ssh_key",
        DriveCredential.fingerprint == fingerprint,
    )).first()
    if row is None:
        return None
    row.last_used = time.time()
    session.add(row)
    session.commit()
    return user


# —— 开通与挂载点 ——


def enable(session: Session, settings, user_id: str, enabled: bool):
    """开关云盘；关闭时保留文件，重新开启后恢复。由调用方提交。"""
    storage.save(session, user_id, drive_enabled=enabled)
    if enabled:
        ensure_root(session, settings, user_id)


def mount_view(row: DriveMount) -> dict:
    return {"id": row.id, "path": row.path, "kind": row.kind, "location": row.location,
            "quota": row.quota_bytes, "read_only": row.read_only, "used": row.used_bytes,
            "files": row.used_files}


def mounts(session: Session, user_id: str) -> list[dict]:
    rows = session.exec(
        select(DriveMount).where(DriveMount.user_id == user_id).order_by(DriveMount.path)
    ).all()
    return [mount_view(row) for row in rows]


def add_mount(session: Session, user_id: str, path: str, kind: str, location: str,
              quota_bytes: int, read_only: bool) -> DriveMount:
    path = paths.clean(path)
    if path == "/" or len(paths.split(path)) != 1:
        raise Invalid("挂载点只能是根目录下的一级目录，例如 /archive")
    if kind != "oss":
        raise Invalid("目前只能添加 OSS 挂载点")
    location = location.strip().lstrip("/")
    if not location or ".." in location.split("/"):
        raise Invalid("对象前缀不合法")
    if session.exec(select(DriveMount).where(DriveMount.user_id == user_id,
                                             DriveMount.path == path)).first():
        raise Conflict("挂载点已存在")
    row = DriveMount(id=uuid.uuid4().hex, user_id=user_id, path=path, kind=kind,
                     location=location if location.endswith("/") else location + "/",
                     quota_bytes=max(quota_bytes, 0), read_only=read_only, created_at=time.time())
    session.add(row)
    session.commit()
    return row


def update_mount(session: Session, user_id: str, mount_id: str, quota_bytes: int,
                 read_only: bool) -> DriveMount:
    row = session.get(DriveMount, mount_id)
    if row is None or row.user_id != user_id:
        raise NotFound("挂载点不存在")
    row.quota_bytes, row.read_only = max(quota_bytes, 0), read_only
    session.add(row)
    session.commit()
    return row


def remove_mount(session: Session, user_id: str, mount_id: str):
    """只移除挂载关系，不删除 OSS 上的对象。"""
    row = session.get(DriveMount, mount_id)
    if row is None or row.user_id != user_id:
        raise NotFound("挂载点不存在")
    if row.path == "/":
        raise Invalid("不能移除根目录")
    session.delete(row)
    session.commit()


# —— 登录名与凭据 ——


def set_login(session: Session, user_id: str, login: str, legacy_hash: str | None = None):
    login = login.strip()
    if not LOGIN.match(login):
        raise Invalid("登录名需为 2–32 位字母、数字、点、下划线或连字符，且以字母或数字开头")
    taken = session.exec(select(DriveAccount).where(DriveAccount.login_key == login_key(login))).first()
    if taken is not None and taken.user_id != user_id:
        raise Conflict("该登录名已被使用")
    row = session.get(DriveAccount, user_id) or DriveAccount(
        user_id=user_id, login=login, login_key=login_key(login), created_at=time.time()
    )
    row.login, row.login_key = login, login_key(login)
    if legacy_hash is not None:
        row.legacy_hash = legacy_hash
    session.add(row)
    session.commit()
    return row


def clear_legacy(session: Session, user_id: str):
    row = session.get(DriveAccount, user_id)
    if row is not None:
        row.legacy_hash = ""
        session.add(row)
        session.commit()


def credential_view(row: DriveCredential) -> dict:
    return {"id": row.id, "kind": row.kind, "name": row.name, "fingerprint": row.fingerprint,
            "created_at": row.created_at, "last_used": row.last_used}


def credentials(session: Session, user_id: str) -> list[dict]:
    rows = session.exec(
        select(DriveCredential).where(DriveCredential.user_id == user_id)
        .order_by(DriveCredential.created_at)
    ).all()
    return [credential_view(row) for row in rows]


def check_limit(session: Session, user_id: str):
    if len(credentials(session, user_id)) >= CREDENTIAL_LIMIT:
        raise Conflict(f"最多保存 {CREDENTIAL_LIMIT} 个凭据，请先删除不用的")


def parse_key(text: str) -> tuple[str, str, str]:
    """返回规范化的公钥、SHA256 指纹与注释。"""
    import asyncssh

    try:
        key = asyncssh.import_public_key(text.strip())
    except (asyncssh.KeyImportError, ValueError):
        raise Invalid("无法识别的 SSH 公钥，请粘贴 OpenSSH 格式（ssh-ed25519 AAAA… 这一行）") from None
    exported = key.export_public_key("openssh").decode().strip()
    return exported, key.get_fingerprint("sha256"), key.get_comment() or ""


def add_key(session: Session, user_id: str, name: str, text: str) -> dict:
    check_limit(session, user_id)
    public, fingerprint, comment = parse_key(text)
    if session.exec(select(DriveCredential).where(
        DriveCredential.user_id == user_id, DriveCredential.fingerprint == fingerprint,
    )).first():
        raise Conflict("这个公钥已经添加过了")
    row = DriveCredential(id=secrets.token_hex(8), user_id=user_id, kind="ssh_key",
                          name=(name.strip() or comment or "SSH 公钥")[:80], secret=public,
                          fingerprint=fingerprint, created_at=time.time())
    session.add(row)
    session.commit()
    return credential_view(row)


def new_app_password() -> str:
    return "-".join("".join(secrets.choice(APP_ALPHABET) for _ in range(4)) for _ in range(5))


def add_app_password(session: Session, user_id: str, name: str) -> dict:
    check_limit(session, user_id)
    password = new_app_password()
    row = DriveCredential(id=secrets.token_hex(8), user_id=user_id, kind="app_password",
                          name=name.strip()[:80] or "应用密码", secret=digest(password),
                          created_at=time.time())
    session.add(row)
    session.commit()
    return {**credential_view(row), "password": password}


def remove_credential(session: Session, user_id: str, credential_id: str):
    row = session.get(DriveCredential, credential_id)
    if row is None or row.user_id != user_id:
        raise NotFound("凭据不存在")
    session.delete(row)
    session.commit()


def connection_info(settings) -> dict:
    host = settings.sftp_host or (settings.drive_base.split("://", 1)[-1].split("/")[0])
    return {"sftp_host": host.split(":")[0], "sftp_port": settings.sftp_port,
            "dav_url": settings.dav_url or f"{settings.drive_base}/dav"}


def account_view(session: Session, settings, user: User) -> dict:
    account = session.get(DriveAccount, user.id)
    return {"login": account.login if account else "", "email": user.email,
            "legacy_password": bool(account and account.legacy_hash),
            "credentials": credentials(session, user.id), **connection_info(settings)}


# —— 删除账户 ——


def remove_user(session: Session, settings, user_id: str):
    """删除账户时清理云盘记录、本地文件与 OSS 对象；由调用方提交。"""
    for row in session.exec(select(DriveMount).where(DriveMount.user_id == user_id)).all():
        try:
            if row.kind == "local":
                shutil.rmtree(settings.drive_dir / row.location, ignore_errors=True)
            else:
                backend = make_backend(settings, row)
                for entry in backend.list(""):
                    backend.remove(entry.name)
        except Exception:  # noqa: BLE001 - 尽力清理，不阻止删除账户
            pass
        session.delete(row)
    for table in (DriveAccount, DriveCredential, DriveShare, DriveUpload):
        session.exec(delete(table).where(table.user_id == user_id))

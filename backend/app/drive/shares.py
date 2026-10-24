"""分享链接：把网盘中的文件或目录公开给持有链接的人，可设密码、有效期与次数。

只读分享可以包含多个路径；仅上传分享必须是一个目录，访客只能往里放文件、看不到内容。
"""

import hashlib
import hmac
import secrets
import string
import time

from sqlmodel import Session, select

from ..accounts import hash_password, verify_password
from ..models import DriveShare
from . import paths
from .errors import Forbidden, Invalid, NotFound

ID_ALPHABET = string.ascii_letters + string.digits
SHARE_LIMIT = 200
COOKIE_PREFIX = "copylee_share_"


def new_id() -> str:
    return "".join(secrets.choice(ID_ALPHABET) for _ in range(22))


def secret_key(settings) -> bytes:
    path = settings.data_dir / "share.key"
    if not path.exists():
        path.write_bytes(secrets.token_bytes(32))
        path.chmod(0o600)
    return path.read_bytes()


def unlock_token(settings, row: DriveShare) -> str:
    return hmac.new(secret_key(settings), f"{row.id}:{row.password_hash}".encode(),
                    hashlib.sha256).hexdigest()


def view(settings, row: DriveShare) -> dict:
    return {"id": row.id, "name": row.name, "paths": row.paths, "mode": row.mode,
            "has_password": bool(row.password_hash), "expires_at": row.expires_at,
            "max_uses": row.max_uses, "used": row.used, "created_at": row.created_at,
            "last_used": row.last_used, "url": f"{settings.drive_base}/s/{row.id}"}


def owned(session: Session, user_id: str) -> list[DriveShare]:
    return session.exec(
        select(DriveShare).where(DriveShare.user_id == user_id)
        .order_by(DriveShare.created_at.desc())
    ).all()


def create(session: Session, drive, body) -> DriveShare:
    if len(owned(session, drive.user_id)) >= SHARE_LIMIT:
        raise Invalid(f"最多创建 {SHARE_LIMIT} 个分享")
    targets = list(dict.fromkeys(paths.clean(path) for path in body.paths))
    if not targets or len(targets) > 100:
        raise Invalid("请选择 1–100 个要分享的文件")
    entries = [drive.stat(path) for path in targets]
    if "/" in targets:
        raise Invalid("不能分享整个网盘")
    if body.mode == "upload":
        if len(targets) != 1 or not entries[0].is_dir:
            raise Invalid("仅上传分享只能选择一个目录")
        drive.writable(targets[0])
    if body.expires_at and body.expires_at <= time.time():
        raise Invalid("有效期必须晚于当前时间")
    name = body.name.strip() or (paths.name(targets[0]) if len(targets) == 1
                                 else f"{paths.name(targets[0])} 等 {len(targets)} 项")
    row = DriveShare(id=new_id(), user_id=drive.user_id, name=name[:120], paths=targets,
                     mode=body.mode, password_hash=hash_password(body.password) if body.password
                     else "", expires_at=body.expires_at or 0, max_uses=max(body.max_uses, 0),
                     created_at=time.time())
    session.add(row)
    session.commit()
    return row


def remove(session: Session, user_id: str, share_id: str):
    row = session.get(DriveShare, share_id)
    if row is None or row.user_id != user_id:
        raise NotFound("分享不存在")
    session.delete(row)
    session.commit()


# —— 访客访问 ——


def active(session: Session, share_id: str) -> DriveShare:
    row = session.get(DriveShare, share_id)
    if row is None:
        raise NotFound("分享不存在或已被取消")
    if row.expires_at and row.expires_at <= time.time():
        raise NotFound("分享已过期")
    if row.max_uses and row.used >= row.max_uses:
        raise NotFound("分享的使用次数已用完")
    return row


def check_password(row: DriveShare, password: str) -> bool:
    if not row.password_hash:
        return True
    if row.password_hash.startswith("$2"):
        import bcrypt

        try:
            return bcrypt.checkpw(password.encode(), row.password_hash.encode())
        except ValueError:
            return False
    return verify_password(row.password_hash, password)


def unlocked(settings, row: DriveShare, cookies: dict) -> bool:
    if not row.password_hash:
        return True
    token = cookies.get(COOKIE_PREFIX + row.id, "")
    return bool(token) and hmac.compare_digest(token, unlock_token(settings, row))


def consume(session: Session, row: DriveShare):
    row.used += 1
    row.last_used = time.time()
    session.add(row)
    session.commit()


def single_root(drive, row: DriveShare) -> str | None:
    """只分享了一个目录时，分享的根就是这个目录。"""
    if len(row.paths) == 1 and drive.stat(row.paths[0]).is_dir:
        return row.paths[0]
    return None


def locate(drive, row: DriveShare, inner: str) -> str | None:
    """把分享内的路径换算成所有者网盘里的路径；inner 为分享根时返回 None。"""
    inner = paths.clean(inner)
    root = single_root(drive, row)
    if root is not None:
        return root if inner == "/" else paths.join(root, inner)
    if inner == "/":
        return None
    first, *rest = paths.split(inner)
    for path in row.paths:
        if paths.name(path) == first:
            return paths.join(path, *rest) if rest else path
    raise NotFound("文件不存在")


def listing(drive, row: DriveShare, inner: str) -> list:
    if row.mode != "read":
        raise Forbidden("仅上传分享不能查看内容")
    target = locate(drive, row, inner)
    if target is None:
        return [drive.stat(path) for path in row.paths if drive.exists(path)]
    return drive.list(target)

"""存储方案：云盘与图床共用一个总配额。

总用量 = 图床图片 + 未单独设置配额的云盘挂载点 + 名下团队的划拨额（空着也算）。单独设置了配额的挂载点（例如 OSS
归档目录）只受自己的配额限制。管理员同样受自己的存储方案约束（可在后台调整），
只有旧数据里 owner 为 "admin" 的图片不计配额。
"""

from datetime import datetime, timezone

from sqlalchemy import func
from sqlmodel import Session, select

from . import storage_terms
from .models import DriveMount, HostedImage, StoragePlan, Team, User

ADMIN = "admin"
# 文章与笔记引用的图片：随内容自动增减，不属于任何人，也不计入配额。
SYSTEM = "system"
MIB = 1024 * 1024


def plan(session: Session, user_id: str) -> StoragePlan:
    return session.get(StoragePlan, user_id) or StoragePlan(user_id=user_id)


def images_used(session: Session, owner: str) -> int:
    return session.exec(
        select(func.coalesce(func.sum(HostedImage.size), 0)).where(HostedImage.owner == owner)
    ).one()


def drive_used(session: Session, user_id: str, shared_only: bool = True) -> int:
    query = select(func.coalesce(func.sum(DriveMount.used_bytes), 0)).where(
        DriveMount.user_id == user_id
    )
    if shared_only:
        query = query.where(DriveMount.quota_bytes == 0)
    return session.exec(query).one()


def teams_reserved(session: Session, user_id: str) -> int:
    return session.exec(
        select(func.coalesce(func.sum(Team.quota_bytes), 0)).where(Team.user_id == user_id)
    ).one()


def shared_used(session: Session, user_id: str) -> int:
    return images_used(session, user_id) + drive_used(session, user_id) + teams_reserved(session, user_id)


def unlimited(session: Session, user_id: str) -> bool:
    """只有旧的独立管理员（owner 为 "admin"）不受配额限制；管理员用户按自己的方案计算，避免占满磁盘。"""
    return user_id in {ADMIN, SYSTEM}


def remaining(session: Session, user_id: str) -> int | None:
    """总配额剩余字节数；None 表示不限。"""
    if unlimited(session, user_id):
        return None
    return plan(session, user_id).quota_bytes - shared_used(session, user_id)


def agreed(session: Session, user_id: str) -> bool:
    """是否已同意当前版本的使用协议。管理员是服务运营者，不需要同意。"""
    if unlimited(session, user_id):
        return True
    user = session.get(User, user_id)
    if user is not None and user.is_admin:
        return True
    return plan(session, user_id).terms_version == storage_terms.VERSION


def accept_terms(session: Session, user_id: str) -> StoragePlan:
    """记录同意时间与版本；由调用方提交。"""
    row = plan(session, user_id)
    row.terms_version = storage_terms.VERSION
    row.terms_accepted_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    session.add(row)
    return row


def summary(session: Session, user_id: str) -> dict:
    row = plan(session, user_id)
    images = images_used(session, user_id)
    drive = drive_used(session, user_id)
    teams = teams_reserved(session, user_id)
    return {"drive_enabled": row.drive_enabled, "images_enabled": row.images_enabled,
            "agreed": agreed(session, user_id), "terms_accepted_at": row.terms_accepted_at,
            "quota": None if unlimited(session, user_id) else row.quota_bytes,
            "max_image": row.max_image_bytes,
            "used": images + drive + teams, "images_used": images, "drive_used": drive,
            "teams_reserved": teams}


def save(session: Session, user_id: str, *, drive_enabled: bool | None = None,
         images_enabled: bool | None = None, quota_mb: int | None = None,
         max_image_mb: int | None = None) -> StoragePlan:
    """只修改传入的字段；由调用方提交。"""
    row = plan(session, user_id)
    if drive_enabled is not None:
        row.drive_enabled = drive_enabled
    if images_enabled is not None:
        row.images_enabled = images_enabled
    if quota_mb is not None:
        row.quota_bytes = quota_mb * MIB
    if max_image_mb is not None:
        row.max_image_bytes = max_image_mb * MIB
    session.add(row)
    return row


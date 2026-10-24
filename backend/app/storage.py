"""存储方案：网盘与图床共用一个总配额。

总用量 = 图床图片 + 未单独设置配额的网盘挂载点。单独设置了配额的挂载点（例如 OSS
归档目录）只受自己的配额限制。管理员同样受自己的存储方案约束（可在后台调整），
只有旧数据里 owner 为 "admin" 的图片不计配额。
"""

from sqlalchemy import func
from sqlmodel import Session, select

from .models import DriveMount, HostedImage, StoragePlan, User

ADMIN = "admin"
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


def shared_used(session: Session, user_id: str) -> int:
    return images_used(session, user_id) + drive_used(session, user_id)


def unlimited(session: Session, user_id: str) -> bool:
    """只有旧的独立管理员（owner 为 "admin"）不受配额限制；管理员用户按自己的方案计算，避免占满磁盘。"""
    return user_id == ADMIN


def remaining(session: Session, user_id: str) -> int | None:
    """总配额剩余字节数；None 表示不限。"""
    if unlimited(session, user_id):
        return None
    return plan(session, user_id).quota_bytes - shared_used(session, user_id)


def summary(session: Session, user_id: str) -> dict:
    row = plan(session, user_id)
    images = images_used(session, user_id)
    drive = drive_used(session, user_id)
    return {"drive_enabled": row.drive_enabled, "images_enabled": row.images_enabled,
            "quota": None if unlimited(session, user_id) else row.quota_bytes,
            "max_image": row.max_image_bytes,
            "used": images + drive, "images_used": images, "drive_used": drive}


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


def admin_owner(session: Session) -> str:
    """图片归属的管理员：第一个管理员用户；尚未设置时沿用旧的 "admin"。"""
    user = session.exec(select(User).where(User.is_admin).order_by(User.created_at)).first()
    return user.id if user else ADMIN

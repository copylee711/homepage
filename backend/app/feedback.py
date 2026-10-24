"""意见反馈：登录用户向站长提建议，管理员在后台收件箱查看、标记与回复。

提交接口在边缘由 ESA AI 验证码保护（Caddy 只放行带回源密钥的请求），
后端再按用户、IP 与全站每日总量限流，防止被刷。
"""

import time
import uuid

from fastapi import HTTPException, Request
from sqlalchemy import func
from sqlmodel import Session, select

from .accounts import client_ip
from .auth import digest
from .models import Feedback, User

PAGE_SIZE = 30
LIMITS = (  # (时间窗口秒数, 每个用户上限, 每个 IP 上限)
    (600, 3, 5),
    (86400, 10, 20),
)
DAILY_TOTAL = 200
CATEGORIES = {"suggestion": "建议", "bug": "问题", "other": "其他"}


def count(session: Session, since: float, **filters) -> int:
    query = select(func.count()).select_from(Feedback).where(Feedback.created_at > since)
    for field, value in filters.items():
        query = query.where(getattr(Feedback, field) == value)
    return session.exec(query).one()


def check_limits(session: Session, user_id: str, ip_hash: str):
    now = time.time()
    for window, per_user, per_ip in LIMITS:
        if count(session, now - window, user_id=user_id) >= per_user or \
                count(session, now - window, ip_hash=ip_hash) >= per_ip:
            raise HTTPException(429, "提交太频繁了，请稍后再试",
                                headers={"Retry-After": str(window)})
    if count(session, now - 86400) >= DAILY_TOTAL:
        raise HTTPException(429, "今日反馈已达上限，请明天再试")


def view(row: Feedback) -> dict:
    return {"id": row.id, "category": row.category, "content": row.content, "page": row.page,
            "status": row.status, "reply": row.reply, "created_at": row.created_at,
            "replied_at": row.replied_at}


def submit(request: Request, session: Session, user: User, body) -> dict:
    ip_hash = digest(client_ip(request))
    # 串行化检查与写入，并发请求不能绕过次数限制。
    session.connection().exec_driver_sql("BEGIN IMMEDIATE")
    check_limits(session, user.id, ip_hash)
    content = body.content.strip()
    if len(content) < 5:
        raise HTTPException(422, "内容太短了，请多写几个字")
    row = Feedback(id=uuid.uuid4().hex, user_id=user.id, category=body.category, content=content,
                   page=body.page.strip()[:300], ip_hash=ip_hash, created_at=time.time())
    session.add(row)
    session.commit()
    return view(row)


def mine(session: Session, user_id: str) -> list[dict]:
    rows = session.exec(
        select(Feedback).where(Feedback.user_id == user_id)
        .order_by(Feedback.created_at.desc()).limit(50)
    ).all()
    return [view(row) for row in rows]


def unread(session: Session) -> int:
    return session.exec(
        select(func.count()).select_from(Feedback).where(Feedback.status == "new")
    ).one()


def inbox(session: Session, status: str, page: int) -> dict:
    query = select(Feedback, User).join(User, User.id == Feedback.user_id, isouter=True)
    total = select(func.count()).select_from(Feedback)
    if status:
        query = query.where(Feedback.status == status)
        total = total.where(Feedback.status == status)
    rows = session.exec(
        query.order_by(Feedback.created_at.desc())
        .offset(max(page - 1, 0) * PAGE_SIZE).limit(PAGE_SIZE)
    ).all()
    items = [{**view(row), "user": {"id": row.user_id, "email": user.email if user else "",
                                    "name": user.name if user else "（已注销）"}}
             for row, user in rows]
    return {"items": items, "total": session.exec(total).one(), "page": page,
            "page_size": PAGE_SIZE, "unread": unread(session)}


def update(session: Session, feedback_id: str, body) -> dict:
    row = session.get(Feedback, feedback_id)
    if row is None:
        raise HTTPException(404, "反馈不存在")
    row.status = body.status
    if body.reply is not None and body.reply.strip() != row.reply:
        row.reply = body.reply.strip()
        row.replied_at = time.time() if row.reply else None
    session.add(row)
    session.commit()
    return view(row)


def remove(session: Session, feedback_id: str):
    row = session.get(Feedback, feedback_id)
    if row is None:
        raise HTTPException(404, "反馈不存在")
    session.delete(row)
    session.commit()

"""好友：互发申请、同意或拒绝、删除好友，以及可以重置的个人邀请链接。

好友关系是双向的，Friendship 每对好友存两行。私信、文档与项目的成员邀请等功能通过
are_friends / friend_ids / friend_users / require_friend 判断与列出好友，不直接查表。
"""

import secrets
import string
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import delete, func, or_
from sqlmodel import Session, select

from . import audit
from .accounts import current_user
from .models import FriendInvite, FriendRequest, Friendship, User
from .schemas import FriendRequestCreate

router = APIRouter()
ID_ALPHABET = string.ascii_letters + string.digits
FRIEND_LIMIT = 500
# 同时等待对方处理的申请数，以及每小时最多发出的申请数，避免拿邮箱逐个试探。
PENDING_LIMIT = 50
HOURLY_LIMIT = 20


def new_id(length: int = 16) -> str:
    return "".join(secrets.choice(ID_ALPHABET) for _ in range(length))


def database(request: Request):
    with Session(request.app.state.engine) as session:
        yield session


# —— 供其他模块使用 ——


def are_friends(session: Session, user_id: str, other_id: str) -> bool:
    return user_id != other_id and session.get(Friendship, (user_id, other_id)) is not None


def friend_ids(session: Session, user_id: str) -> list[str]:
    return list(session.exec(select(Friendship.friend_id).where(Friendship.user_id == user_id)).all())


def friend_users(session: Session, user_id: str) -> list[tuple[User, Friendship]]:
    """好友及成为好友的时间；已停用的账户不列出。"""
    return list(session.exec(
        select(User, Friendship).join(Friendship, Friendship.friend_id == User.id)
        .where(Friendship.user_id == user_id, User.disabled == False)  # noqa: E712
        .order_by(Friendship.created_at.desc())
    ).all())


def require_friend(session: Session, user_id: str, friend_id: str) -> User:
    target = session.get(User, friend_id)
    if target is None or target.disabled or not are_friends(session, user_id, friend_id):
        raise HTTPException(404, "对方不是你的好友")
    return target


def person(user: User) -> dict:
    return {"id": user.id, "name": user.name, "avatar": user.avatar}


def purge_user(session: Session, user_id: str):
    """注销账户时删除好友关系、申请与邀请链接；调用方负责提交。"""
    session.exec(delete(Friendship).where(or_(Friendship.user_id == user_id,
                                              Friendship.friend_id == user_id)))
    session.exec(delete(FriendRequest).where(or_(FriendRequest.from_id == user_id,
                                                 FriendRequest.to_id == user_id)))
    session.exec(delete(FriendInvite).where(FriendInvite.user_id == user_id))


# —— 内部 ——


def friend_count(session: Session, user_id: str) -> int:
    return session.exec(select(func.count()).select_from(Friendship)
                        .where(Friendship.user_id == user_id)).one()


def befriend(session: Session, user: User, other: User):
    """建立双向关系，并把两人之间待处理的申请标为已同意；调用方负责提交。"""
    if are_friends(session, user.id, other.id):
        return
    for row in (user, other):
        if friend_count(session, row.id) >= FRIEND_LIMIT:
            raise HTTPException(400, f"{'你' if row is user else '对方'}的好友已达上限 {FRIEND_LIMIT} 人")
    now = time.time()
    session.add(Friendship(user_id=user.id, friend_id=other.id, created_at=now))
    session.add(Friendship(user_id=other.id, friend_id=user.id, created_at=now))
    for request in pending_between(session, user.id, other.id):
        request.status, request.responded_at = "accepted", now
        session.add(request)


def pending_between(session: Session, user_id: str, other_id: str) -> list[FriendRequest]:
    return list(session.exec(select(FriendRequest).where(
        FriendRequest.status == "pending",
        or_((FriendRequest.from_id == user_id) & (FriendRequest.to_id == other_id),
            (FriendRequest.from_id == other_id) & (FriendRequest.to_id == user_id)),
    )).all())


def request_rows(session: Session, user_id: str, incoming: bool) -> list[dict]:
    mine = FriendRequest.to_id if incoming else FriendRequest.from_id
    theirs = FriendRequest.from_id if incoming else FriendRequest.to_id
    rows = session.exec(
        select(FriendRequest, User).join(User, User.id == theirs)
        .where(mine == user_id, FriendRequest.status == "pending", User.disabled == False)  # noqa: E712
        .order_by(FriendRequest.created_at.desc())
    ).all()
    # 发出的申请显示对方邮箱（本来就是按邮箱找到的）；收到的申请也显示对方邮箱，方便辨认。
    return [{"id": row.id, "user": {**person(user), "email": user.email}, "message": row.message,
             "created_at": row.created_at} for row, user in rows]


def overview(session: Session, user: User) -> dict:
    return {"friends": [{**person(friend), "email": friend.email, "since": link.created_at}
                        for friend, link in friend_users(session, user.id)],
            "incoming": request_rows(session, user.id, incoming=True),
            "outgoing": request_rows(session, user.id, incoming=False)}


def own_request(session: Session, request_id: str, user: User, incoming: bool) -> FriendRequest:
    row = session.get(FriendRequest, request_id)
    owner = (row.to_id if incoming else row.from_id) if row else None
    if row is None or owner != user.id or row.status != "pending":
        raise HTTPException(404, "申请不存在或已处理")
    return row


def invite_of(session: Session, user: User) -> FriendInvite:
    row = session.get(FriendInvite, user.id)
    if row is None:
        row = FriendInvite(user_id=user.id, token=new_id(22), created_at=time.time())
        session.add(row)
        session.commit()
    return row


def invite_view(settings, row: FriendInvite) -> dict:
    return {"token": row.token, "url": f"{settings.site_url}/messages?invite={row.token}",
            "created_at": row.created_at}


def invite_owner(session: Session, token: str) -> User:
    row = session.exec(select(FriendInvite).where(FriendInvite.token == token)).first()
    owner = session.get(User, row.user_id) if row else None
    if owner is None or owner.disabled:
        raise HTTPException(404, "邀请链接不存在或已失效")
    return owner


# —— 接口 ——


@router.get("/api/friends")
def list_friends(request: Request, session: Session = Depends(database)):
    user, _ = current_user(request, session)
    return overview(session, user)


@router.post("/api/friends/requests")
def send_request(body: FriendRequestCreate, request: Request, session: Session = Depends(database)):
    user, _ = current_user(request, session, write=True)
    target = session.exec(select(User).where(func.lower(User.email) == body.email.strip().lower())).first()
    if target is None or target.disabled:
        raise HTTPException(404, "没有找到这个邮箱对应的用户，请确认对方已注册")
    if target.id == user.id:
        raise HTTPException(400, "不能添加自己为好友")
    if are_friends(session, user.id, target.id):
        raise HTTPException(409, "你们已经是好友了")
    pending = pending_between(session, user.id, target.id)
    # 对方已经向你发过申请：直接成为好友。
    if any(row.from_id == target.id for row in pending):
        befriend(session, user, target)
        session.commit()
        audit.record("friend.accept", request, ok=True, user=user.id, target=target.id)
        return {"friend": True, **overview(session, user)}
    if not pending:
        now = time.time()
        waiting = session.exec(select(func.count()).select_from(FriendRequest).where(
            FriendRequest.from_id == user.id, FriendRequest.status == "pending")).one()
        if waiting >= PENDING_LIMIT:
            raise HTTPException(429, f"最多同时有 {PENDING_LIMIT} 个待对方处理的申请")
        recent = session.exec(select(func.count()).select_from(FriendRequest).where(
            FriendRequest.from_id == user.id, FriendRequest.created_at > now - 3600)).one()
        if recent >= HOURLY_LIMIT:
            raise HTTPException(429, "发送申请太频繁，请稍后再试")
        session.add(FriendRequest(id=new_id(), from_id=user.id, to_id=target.id,
                                  message=body.message.strip(), created_at=now))
        session.commit()
        audit.record("friend.request", request, ok=True, user=user.id, target=target.id)
    return {"friend": False, **overview(session, user)}


@router.post("/api/friends/requests/{request_id}/accept")
def accept_request(request_id: str, request: Request, session: Session = Depends(database)):
    user, _ = current_user(request, session, write=True)
    row = own_request(session, request_id, user, incoming=True)
    sender = session.get(User, row.from_id)
    if sender is None or sender.disabled:
        raise HTTPException(404, "申请不存在或已处理")
    befriend(session, user, sender)
    session.commit()
    audit.record("friend.accept", request, ok=True, user=user.id, target=sender.id)
    return overview(session, user)


@router.post("/api/friends/requests/{request_id}/decline")
def decline_request(request_id: str, request: Request, session: Session = Depends(database)):
    user, _ = current_user(request, session, write=True)
    row = own_request(session, request_id, user, incoming=True)
    row.status, row.responded_at = "declined", time.time()
    session.add(row)
    session.commit()
    return overview(session, user)


@router.post("/api/friends/requests/{request_id}/cancel")
def cancel_request(request_id: str, request: Request, session: Session = Depends(database)):
    user, _ = current_user(request, session, write=True)
    row = own_request(session, request_id, user, incoming=False)
    row.status, row.responded_at = "cancelled", time.time()
    session.add(row)
    session.commit()
    return overview(session, user)


@router.post("/api/friends/{friend_id}/remove")
def remove_friend(friend_id: str, request: Request, session: Session = Depends(database)):
    user, _ = current_user(request, session, write=True)
    if not are_friends(session, user.id, friend_id):
        raise HTTPException(404, "对方不是你的好友")
    # 双向一起删除；聊天记录保留，再次成为好友后仍能看到。
    session.exec(delete(Friendship).where(or_(
        (Friendship.user_id == user.id) & (Friendship.friend_id == friend_id),
        (Friendship.user_id == friend_id) & (Friendship.friend_id == user.id))))
    session.commit()
    audit.record("friend.remove", request, ok=True, user=user.id, target=friend_id)
    return overview(session, user)


@router.get("/api/friends/invite")
def get_invite(request: Request, session: Session = Depends(database)):
    user, _ = current_user(request, session)
    return invite_view(request.app.state.settings, invite_of(session, user))


@router.post("/api/friends/invite/reset")
def reset_invite(request: Request, session: Session = Depends(database)):
    user, _ = current_user(request, session, write=True)
    row = invite_of(session, user)
    row.token, row.created_at = new_id(22), time.time()
    session.add(row)
    session.commit()
    return invite_view(request.app.state.settings, row)


@router.get("/api/friends/invite/{token}")
def invite_info(token: str, request: Request, session: Session = Depends(database)):
    user, _ = current_user(request, session)
    owner = invite_owner(session, token)
    return {"user": person(owner), "self": owner.id == user.id,
            "friend": are_friends(session, user.id, owner.id)}


@router.post("/api/friends/invite/{token}/accept")
def accept_invite(token: str, request: Request, session: Session = Depends(database)):
    user, _ = current_user(request, session, write=True)
    owner = invite_owner(session, token)
    if owner.id == user.id:
        raise HTTPException(400, "这是你自己的邀请链接")
    # 链接由对方主动发出，视为对方已同意，打开并确认后直接成为好友。
    befriend(session, user, owner)
    session.commit()
    audit.record("friend.invite", request, ok=True, user=user.id, target=owner.id)
    return {"friend": person(owner), **overview(session, user)}

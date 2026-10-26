"""私信：好友之间一对一的消息，支持文字、云盘文件卡片与协作文档邀请。

不做实时推送：私信页打开时按 updated_at 轮询增量，其他页面只轮询未读数。发送、撤回与邀请被
处理都会更新 updated_at，卡片状态的变化因此也能同步给对方。

文件卡片不生成公开链接，只有对话双方能通过 /api/messages/{id}/file 读取发送者云盘里的文件；
发送者撤回、双方不再是好友、文件被移走或云盘被关闭后即失效。协作邀请被接受时按邀请人当时的
分享权限授予成员身份，邀请人在此期间失去分享权限则邀请失效。
"""

import threading
import time

import anyio.from_thread
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import case, delete, func, or_
from sqlmodel import Session, select

from . import audit
from .accounts import client_ip, current_user
from .docs import RANK, grant, resolve, rooms_of
from .drive import paths
from .drive.errors import DriveError
from .drive.routes import file_response
from .drive.vfs import Drive
from .friends import are_friends, database, friend_users, new_id, person, require_friend
from .models import Doc, DocMember, FriendRequest, Message, User
from .schemas import MessageCreate

router = APIRouter()
PAGE = 50
POLL_LIMIT = 200
# 每分钟最多发送的消息数。
MINUTE_LIMIT = 30
_clock = threading.Lock()
_last = 0.0


def stamp() -> float:
    """严格递增的时间戳：同一毫秒内的消息也能稳定排序，轮询游标不会漏掉同一时刻的变化。"""
    global _last
    with _clock:
        _last = max(time.time(), _last + 1e-6)
        return _last


def pair(user_id: str, peer_id: str):
    return or_((Message.sender_id == user_id) & (Message.recipient_id == peer_id),
               (Message.sender_id == peer_id) & (Message.recipient_id == user_id))


def message_view(row: Message, viewer_id: str) -> dict:
    mine = row.sender_id == viewer_id
    data = {"id": row.id, "sender_id": row.sender_id, "mine": mine, "kind": row.kind,
            "created_at": row.created_at, "updated_at": row.updated_at, "revoked": row.revoked,
            "body": "", "data": None}
    if row.revoked:
        return data
    data["body"] = row.body
    if row.data:
        card = dict(row.data)
        # 文件在发送者云盘里的位置只给发送者看。
        if not mine:
            card.pop("path", None)
        data["data"] = card
    return data


def unread_query(user_id: str):
    return select(Message.sender_id, func.count()).where(
        Message.recipient_id == user_id, Message.read_at == None,  # noqa: E711
        Message.revoked == False,  # noqa: E712
    ).group_by(Message.sender_id)


def own_message(session: Session, message_id: str) -> Message:
    row = session.get(Message, message_id)
    if row is None:
        raise HTTPException(404, "消息不存在")
    return row


def touch(session: Session, row: Message):
    row.updated_at = stamp()
    session.add(row)


# —— 会话 ——


@router.get("/api/messages/summary")
def summary(request: Request, session: Session = Depends(database)):
    """导航栏的红点：来自现有好友的未读消息数，以及待处理的好友申请数。"""
    user, _ = current_user(request, session)
    friends = {friend.id for friend, _ in friend_users(session, user.id)}
    unread = sum(count for sender, count in session.exec(unread_query(user.id)).all()
                 if sender in friends)
    requests = session.exec(select(func.count()).select_from(FriendRequest).where(
        FriendRequest.to_id == user.id, FriendRequest.status == "pending")).one()
    return {"unread": unread, "requests": requests}


@router.get("/api/messages/conversations")
def conversations(request: Request, session: Session = Depends(database)):
    """每位好友一个会话，按最后一条消息（没有消息时按成为好友的时间）排序。"""
    user, _ = current_user(request, session)
    unread = dict(session.exec(unread_query(user.id)).all())
    peer = case((Message.sender_id == user.id, Message.recipient_id), else_=Message.sender_id)
    latest = dict(session.exec(
        select(peer, func.max(Message.created_at))
        .where(or_(Message.sender_id == user.id, Message.recipient_id == user.id)).group_by(peer)
    ).all())
    items = []
    for friend, link in friend_users(session, user.id):
        last = None
        if friend.id in latest:
            row = session.exec(select(Message).where(pair(user.id, friend.id))
                               .order_by(Message.created_at.desc())).first()
            last = message_view(row, user.id) if row else None
        items.append({"user": {**person(friend), "email": friend.email}, "since": link.created_at,
                      "last": last, "unread": unread.get(friend.id, 0),
                      "at": latest.get(friend.id, link.created_at)})
    items.sort(key=lambda item: item["at"], reverse=True)
    return {"items": items}


@router.get("/api/messages/with/{peer_id}")
def history(peer_id: str, request: Request, after: float = Query(default=0, ge=0),
            before: float = Query(default=0, ge=0), session: Session = Depends(database)):
    """after：返回此后有变化的消息（轮询增量）；否则返回 before 之前（默认最新）的一页。"""
    user, _ = current_user(request, session)
    peer = require_friend(session, user.id, peer_id)
    query = select(Message).where(pair(user.id, peer.id))
    if after:
        rows = session.exec(query.where(Message.updated_at > after)
                            .order_by(Message.created_at).limit(POLL_LIMIT)).all()
        more = False
    else:
        if before:
            query = query.where(Message.created_at < before)
        rows = list(session.exec(query.order_by(Message.created_at.desc()).limit(PAGE + 1)).all())
        more = len(rows) > PAGE
        rows = rows[:PAGE][::-1]
    # 打开会话即视为已读。
    now = time.time()
    for row in session.exec(select(Message).where(
            Message.sender_id == peer.id, Message.recipient_id == user.id,
            Message.read_at == None)).all():  # noqa: E711
        row.read_at = now
        session.add(row)
    session.commit()
    return {"user": {**person(peer), "email": peer.email},
            "items": [message_view(row, user.id) for row in rows], "more": more}


@router.post("/api/messages/with/{peer_id}")
def send(peer_id: str, body: MessageCreate, request: Request, session: Session = Depends(database)):
    user, _ = current_user(request, session, write=True)
    peer = require_friend(session, user.id, peer_id)
    now = stamp()
    recent = session.exec(select(func.count()).select_from(Message).where(
        Message.sender_id == user.id, Message.created_at > now - 60)).one()
    if recent >= MINUTE_LIMIT:
        raise HTTPException(429, "发送太频繁，请稍后再试")
    row = Message(id=new_id(), sender_id=user.id, recipient_id=peer.id, kind=body.kind,
                  created_at=now, updated_at=now)
    if body.kind == "text":
        row.body = body.body.strip()
        if not row.body:
            raise HTTPException(400, "消息不能为空")
    elif body.kind == "file":
        row.data = file_card(request, user, body.path)
    else:
        row.data = doc_card(request, session, user, peer, body)
    session.add(row)
    session.commit()
    if body.kind != "text":
        audit.record(f"message.{body.kind}", request, ok=True, user=user.id, target=peer.id,
                     message=row.id)
    return message_view(row, user.id)


@router.post("/api/messages/{message_id}/revoke")
def revoke(message_id: str, request: Request, session: Session = Depends(database)):
    """撤回后对方看不到内容，文件卡片与未处理的协作邀请随之失效；已接受的邀请不受影响。"""
    user, _ = current_user(request, session, write=True)
    row = own_message(session, message_id)
    if row.sender_id != user.id:
        raise HTTPException(404, "消息不存在")
    row.revoked = True
    touch(session, row)
    session.commit()
    return message_view(row, user.id)


# —— 云盘文件 ——


def open_drive(request: Request, user_id: str) -> Drive:
    return Drive(request.app.state.engine, request.app.state.settings, user_id, protocol="web",
                 ip=client_ip(request), ua=request.headers.get("user-agent", ""))


def file_card(request: Request, user: User, path: str) -> dict:
    path = paths.clean(path)
    if path == "/":
        raise HTTPException(400, "请选择要分享的文件")
    entry = open_drive(request, user.id).stat(path)
    if entry.is_dir:
        raise HTTPException(400, "只能分享文件，文件夹请先打包或使用云盘的分享链接")
    return {"path": path, "name": entry.name, "size": entry.size}


@router.get("/api/messages/{message_id}/file")
def message_file(message_id: str, request: Request, inline: bool = False,
                 session: Session = Depends(database)):
    user, _ = current_user(request, session)
    row = own_message(session, message_id)
    if user.id not in {row.sender_id, row.recipient_id} or row.kind != "file":
        raise HTTPException(404, "消息不存在")
    if row.revoked or (user.id != row.sender_id and not are_friends(session, user.id, row.sender_id)):
        raise HTTPException(404, "文件已失效")
    try:
        drive = open_drive(request, row.sender_id)
        drive.stat(row.data["path"])
    except DriveError:
        raise HTTPException(404, "文件已被移动或删除") from None
    return file_response(drive, row.data["path"], request, inline)


# —— 协作文档邀请 ——


def doc_card(request: Request, session: Session, user: User, peer: User, body: MessageCreate) -> dict:
    doc = session.get(Doc, body.doc_id)
    access = resolve(session, request.app.state.settings, doc, user, "", {}) if doc else None
    if access is None:
        raise HTTPException(404, "文档不存在或无权访问")
    if not access.can_share:
        raise HTTPException(403, "没有分享权限")
    if RANK[body.role] > RANK[access.role]:
        raise HTTPException(403, "不能授予超过自己的权限")
    if peer.id == doc.user_id:
        raise HTTPException(400, "对方是这篇文档的所有者")
    return {"doc_id": doc.id, "title": doc.title, "role": body.role, "can_share": body.can_share,
            "status": "pending"}


def pending_invite(session: Session, user: User, message_id: str) -> Message:
    row = own_message(session, message_id)
    if row.recipient_id != user.id or row.kind != "doc_invite":
        raise HTTPException(404, "消息不存在")
    if row.revoked or row.data["status"] != "pending":
        raise HTTPException(409, "邀请已失效或已处理")
    return row


def settle(session: Session, row: Message, status: str):
    row.data = {**row.data, "status": status}
    touch(session, row)


@router.post("/api/messages/{message_id}/accept")
def accept(message_id: str, request: Request, session: Session = Depends(database)):
    user, _ = current_user(request, session, write=True)
    row = pending_invite(session, user, message_id)
    sender = session.get(User, row.sender_id)
    doc = session.get(Doc, row.data["doc_id"])
    access = (resolve(session, request.app.state.settings, doc, sender, "", {})
              if doc and sender and not sender.disabled
              and are_friends(session, user.id, sender.id) else None)
    if access is None or not access.can_share:
        settle(session, row, "expired")
        session.commit()
        raise HTTPException(409, "邀请已失效：文档已删除，或邀请人已没有分享权限")
    role, can_share = row.data["role"], row.data["can_share"]
    existing = session.get(DocMember, (doc.id, user.id))
    if existing:
        # 已经是成员时只升不降。
        role = max(role, existing.role, key=RANK.get)
        can_share = can_share or existing.can_share
    if not existing or (role, can_share) != (existing.role, existing.can_share):
        grant(session, doc, access, sender, user, role, can_share)
    settle(session, row, "accepted")
    session.commit()
    anyio.from_thread.run(rooms_of(request).refresh, doc.id)
    audit.record("doc.member", request, ok=True, user=sender.id, doc=doc.id, target=user.id,
                 role=role, via="message")
    return message_view(row, user.id)


@router.post("/api/messages/{message_id}/decline")
def decline(message_id: str, request: Request, session: Session = Depends(database)):
    user, _ = current_user(request, session, write=True)
    row = pending_invite(session, user, message_id)
    settle(session, row, "declined")
    session.commit()
    return message_view(row, user.id)


def purge_user(session: Session, user_id: str):
    """注销账户时删除其收发的全部私信；调用方负责提交。"""
    session.exec(delete(Message).where(or_(Message.sender_id == user_id,
                                           Message.recipient_id == user_id)))

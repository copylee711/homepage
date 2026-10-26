"""协作文档：多人实时编辑的富文本文档，成员与链接两种授权方式，以及版本历史。

正文是 Yjs 文档。浏览器用 y-websocket 协议连接 /api/docs/ws/{id}，服务器为每篇打开的文档维护一个
房间：合并各端发来的更新并转发给其他人，停止编辑两秒后写回数据库，最后一人离开时立即写回并释放。

未登录访客最多只能通过链接查看，永远不能编辑：可编辑链接对访客也按只读处理，避免匿名用户借文档
发布内容。权限在建立连接时计算，成员或链接设置变化后对在线连接重新计算：失去权限的连接被关闭，权限变化的
连接被要求重连。只读连接发来的修改由服务器直接丢弃，不依赖前端禁用编辑。
"""

import asyncio
import hashlib
import hmac
import re
import secrets
import shutil
import string
import time
from dataclasses import dataclass, field
from pathlib import Path

import anyio.from_thread
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, WebSocket
from fastapi.responses import FileResponse
from pycrdt import Doc as YDoc
from pycrdt import YMessageType, YSyncMessageType, create_sync_message, handle_sync_message
from sqlalchemy import delete, func
from sqlmodel import Session, select

from . import audit, imagehost, images, storage
from .accounts import (
    USER_COOKIE,
    client_ip,
    current_user,
    hash_password,
    record_failure,
    throttle,
    verify_password,
)
from .auth import check_origin, digest
from .drive.shares import secret_key
from .models import Doc, DocImageSetting, DocMember, DocVersion, Team, TeamMember, User, UserSession
from .schemas import (
    DocCreate,
    DocLinkWrite,
    DocMarkdown,
    DocMemberWrite,
    DocUnlock,
    DocUpdate,
    DocVersionCreate,
    ImageTargetWrite,
)

router = APIRouter()
ID_ALPHABET = string.ascii_letters + string.digits
ID_PATTERN = re.compile(r"^[A-Za-z0-9]{16}$")
DOC_LIMIT = 500
MEMBER_LIMIT = 100
MAX_STATE = 8 * 1024 * 1024
MAX_MESSAGE = 4 * 1024 * 1024
SAVE_DELAY = 2.0
AUTO_VERSION_SECONDS = 30 * 60
IDLE_SECONDS = 10 * 60
AUTO_VERSION_KEEP = 50
COOKIE_PREFIX = "copylee_doc_"
RANK = {"view": 1, "edit": 2, "owner": 3}
WRITERS = {"edit", "owner"}
QUERY_AWARENESS = 3
# Yjs v1 编码的空更新：没有新条目，也没有删除。
EMPTY_UPDATE = b"\x00\x00"
# WebSocket 关闭码：前端据此决定提示用户还是重新获取权限后重连。
CLOSE_LOGIN = 4401
CLOSE_FORBIDDEN = 4403
CLOSE_GONE = 4404
CLOSE_RECONNECT = 4409


def new_id(length: int = 16) -> str:
    return "".join(secrets.choice(ID_ALPHABET) for _ in range(length))


def database(request: Request):
    with Session(request.app.state.engine) as session:
        yield session


# —— 权限 ——


@dataclass
class Access:
    role: str  # owner | edit | view
    can_share: bool
    can_copy: bool


def unlock_token(settings, doc: Doc) -> str:
    message = f"doc:{doc.id}:{doc.link_token}:{doc.link_password_hash}".encode()
    return hmac.new(secret_key(settings), message, hashlib.sha256).hexdigest()


def link_open(doc: Doc, link: str) -> bool:
    """链接本身有效（未关闭、未过期、令牌正确），不考虑密码。"""
    return (doc.link_role != "none" and bool(link)
            and secrets.compare_digest(link.encode(), doc.link_token.encode())
            and (not doc.link_expires_at or doc.link_expires_at > time.time()))


def link_unlocked(settings, doc: Doc, cookies) -> bool:
    if not doc.link_password_hash:
        return True
    value = cookies.get(COOKIE_PREFIX + doc.id, "")
    return bool(value) and secrets.compare_digest(value.encode(), unlock_token(settings, doc).encode())


def optional_user(session: Session, cookies) -> User | None:
    token = cookies.get(USER_COOKIE, "")
    row = session.get(UserSession, digest(token)) if token else None
    user = session.get(User, row.user_id) if row and row.expires_at > time.time() else None
    return None if user is None or user.disabled else user


def resolve(session: Session, settings, doc: Doc, user: User | None, link: str, cookies) -> Access | None:
    """团队文档的权限取团队角色与文档自身成员、链接中较高的一个；团队所有者等同文档所有者。"""
    team_role = None
    if doc.team_id and user:
        from .teams import role_of, usable

        team = session.get(Team, doc.team_id)
        team_role = role_of(session, team, user.id) if usable(session, team) else None
    if user and (user.id == doc.user_id or team_role == "owner"):
        return Access("owner", True, True)
    owner = session.get(User, doc.user_id)
    if owner is None or owner.disabled:
        return None
    rank, can_share = RANK.get(team_role, 0), False
    member = session.get(DocMember, (doc.id, user.id)) if user else None
    if member:
        rank, can_share = max(rank, RANK[member.role]), member.can_share
    if link_open(doc, link) and link_unlocked(settings, doc, cookies):
        # 访客永远只读：可编辑链接只对登录用户生效。
        rank = max(rank, RANK[doc.link_role] if user else RANK["view"])
    if not rank:
        return None
    role = "edit" if rank >= RANK["edit"] else "view"
    return Access(role, can_share, role == "edit" or doc.allow_copy)


def load(session: Session, doc_id: str) -> Doc:
    doc = session.get(Doc, doc_id)
    if doc is None:
        raise HTTPException(404, "文档不存在或无权访问")
    return doc


def require(request: Request, session: Session, doc_id: str, link: str = "",
            write: bool = False) -> tuple[Doc, Access, User | None]:
    """按登录用户与链接计算权限；写操作要求登录并校验 CSRF。"""
    if write:
        user, _ = current_user(request, session, write=True)
    else:
        user = optional_user(session, request.cookies)
    doc = load(session, doc_id)
    access = resolve(session, request.app.state.settings, doc, user, link, request.cookies)
    if access is None:
        if link_open(doc, link) and not link_unlocked(request.app.state.settings, doc, request.cookies):
            raise HTTPException(401, "请输入访问密码")
        if user is None:
            raise HTTPException(401, "请先登录")
        raise HTTPException(404, "文档不存在或无权访问")
    return doc, access, user


def can_create(session: Session, user: User) -> bool:
    return user.is_admin or storage.plan(session, user.id).drive_enabled


# —— 视图 ——


def person(user: User | None) -> dict | None:
    return {"id": user.id, "name": user.name, "avatar": user.avatar} if user else None


def link_view(settings, doc: Doc) -> dict:
    return {"role": doc.link_role, "token": doc.link_token,
            "url": f"{settings.drive_base}/d/{doc.link_token}",
            "has_password": bool(doc.link_password_hash), "expires_at": doc.link_expires_at}


def doc_view(session: Session, settings, doc: Doc, access: Access) -> dict:
    data = {"id": doc.id, "title": doc.title, "size": doc.size, "created_at": doc.created_at,
            "updated_at": doc.updated_at, "owner": person(session.get(User, doc.user_id)),
            "updated_by": person(session.get(User, doc.updated_by)) if doc.updated_by else None,
            "role": access.role, "can_share": access.can_share, "can_copy": access.can_copy,
            "allow_copy": doc.allow_copy, "team": None, "folder": doc.folder}
    if doc.team_id:
        team = session.get(Team, doc.team_id)
        data["team"] = {"id": team.id, "name": team.name} if team else None
    if access.role == "owner":
        data["link"] = link_view(settings, doc)
    return data


# —— 文档 ——


@router.get("/api/docs")
def list_docs(request: Request, session: Session = Depends(database)):
    user, _ = current_user(request, session)
    settings = request.app.state.settings
    owned = session.exec(select(Doc).where(Doc.user_id == user.id)
                         .order_by(Doc.updated_at.desc())).all()
    shared = session.exec(
        select(Doc).join(DocMember, DocMember.doc_id == Doc.id)
        .where(DocMember.user_id == user.id).order_by(Doc.updated_at.desc())
    ).all()
    # 所在团队的文档（自己建的已在 owned 里）。
    team_ids = [team.id for team in session.exec(select(Team).where(Team.user_id == user.id)).all()]
    team_ids += session.exec(select(TeamMember.team_id).where(TeamMember.user_id == user.id)).all()
    seen = {doc.id for doc in [*owned, *shared]}
    shared = list(shared) + [doc for doc in session.exec(
        select(Doc).where(Doc.team_id.in_(team_ids)).order_by(Doc.updated_at.desc())
    ).all() if doc.id not in seen]
    shared.sort(key=lambda doc: doc.updated_at, reverse=True)
    views = []
    for doc in shared:
        access = resolve(session, settings, doc, user, "", {})
        if access:
            views.append(doc_view(session, settings, doc, access))
    return {"can_create": can_create(session, user),
            "owned": [doc_view(session, settings, doc, Access("owner", True, True)) for doc in owned],
            "shared": views}


@router.post("/api/docs")
def create_doc(body: DocCreate, request: Request, session: Session = Depends(database)):
    user, _ = current_user(request, session, write=True)
    if not can_create(session, user):
        raise HTTPException(403, "文档功能随云盘开通，目前只向受邀用户开放")
    count = session.exec(select(func.count()).select_from(Doc).where(Doc.user_id == user.id)).one()
    if count >= DOC_LIMIT:
        raise HTTPException(400, f"最多创建 {DOC_LIMIT} 篇文档")
    now = time.time()
    doc = Doc(id=new_id(), user_id=user.id, title=body.title.strip() or "未命名文档",
              link_token=new_id(22), created_at=now, updated_at=now, updated_by=user.id)
    session.add(doc)
    session.commit()
    audit.record("doc.create", request, ok=True, user=user.id, doc=doc.id)
    return doc_view(session, request.app.state.settings, doc, Access("owner", True, True))


@router.get("/api/docs/link/{token}")
def link_info(token: str, request: Request, session: Session = Depends(database)):
    doc = session.exec(select(Doc).where(Doc.link_token == token)).first()
    if doc is None or not link_open(doc, token):
        raise HTTPException(404, "链接不存在或已失效")
    owner = session.get(User, doc.user_id)
    if owner is None or owner.disabled:
        raise HTTPException(404, "链接不存在或已失效")
    signed_in = optional_user(session, request.cookies) is not None
    unlocked = link_unlocked(request.app.state.settings, doc, request.cookies)
    return {"id": doc.id, "title": doc.title if unlocked else "", "role": doc.link_role,
            "signed_in": signed_in, "needs_password": bool(doc.link_password_hash),
            "unlocked": unlocked}


@router.post("/api/docs/link/{token}/unlock")
def link_unlock(token: str, body: DocUnlock, request: Request, response: Response,
                session: Session = Depends(database)):
    check_origin(request)
    key = f"doc-link:{digest(client_ip(request))}"
    throttle(session, key, 10, "密码错误次数过多，请 15 分钟后再试")
    doc = session.exec(select(Doc).where(Doc.link_token == token)).first()
    if doc is None or not link_open(doc, token):
        raise HTTPException(404, "链接不存在或已失效")
    if doc.link_password_hash and not verify_password(doc.link_password_hash, body.password):
        record_failure(session, key)
        raise HTTPException(403, "密码错误")
    settings = request.app.state.settings
    response.set_cookie(COOKIE_PREFIX + doc.id, unlock_token(settings, doc), max_age=7 * 86400,
                        httponly=True, samesite="lax", secure=settings.secure_cookie,
                        path="/api/docs")
    return {"ok": True, "id": doc.id}


@router.get("/api/docs/{doc_id}")
def get_doc(doc_id: str, request: Request, link: str = Query(default="", max_length=64),
            session: Session = Depends(database)):
    doc, access, _ = require(request, session, doc_id, link)
    return doc_view(session, request.app.state.settings, doc, access)


@router.patch("/api/docs/{doc_id}")
def update_doc(doc_id: str, body: DocUpdate, request: Request,
               link: str = Query(default="", max_length=64), session: Session = Depends(database)):
    doc, access, user = require(request, session, doc_id, link, write=True)
    if body.title is not None:
        if access.role not in WRITERS:
            raise HTTPException(403, "没有编辑权限")
        doc.title = body.title.strip() or "未命名文档"
    copy_changed = body.allow_copy is not None and body.allow_copy != doc.allow_copy
    if body.allow_copy is not None:
        if access.role != "owner":
            raise HTTPException(403, "只有所有者可以修改这项设置")
        doc.allow_copy = body.allow_copy
    doc.updated_at = time.time()
    session.add(doc)
    session.commit()
    if copy_changed:
        anyio.from_thread.run(rooms_of(request).refresh, doc.id)
    return doc_view(session, request.app.state.settings, doc, access)


@router.put("/api/docs/{doc_id}/markdown")
def put_markdown(doc_id: str, body: DocMarkdown, request: Request,
                 link: str = Query(default="", max_length=64), session: Session = Depends(database)):
    """正在编辑的浏览器上传正文的 Markdown 快照，供团队 WebDAV 以只读 .md 文件提供。"""
    doc, access, _ = require(request, session, doc_id, link, write=True)
    if access.role not in WRITERS:
        raise HTTPException(403, "没有编辑权限")
    if doc.markdown != body.markdown:
        doc.markdown = body.markdown
        session.add(doc)
        session.commit()
    return {"ok": True}


@router.delete("/api/docs/{doc_id}")
def delete_doc(doc_id: str, request: Request, session: Session = Depends(database)):
    doc, access, user = require(request, session, doc_id, write=True)
    if access.role != "owner":
        raise HTTPException(403, "只有所有者可以删除文档")
    purge(session, [doc.id], request.app.state.settings.data_dir)
    session.commit()
    anyio.from_thread.run(rooms_of(request).close, doc_id, CLOSE_GONE)
    audit.record("doc.delete", request, ok=True, user=user.id, doc=doc_id)
    return {"ok": True}


def purge(session: Session, doc_ids: list[str], data_dir: Path | None = None):
    if not doc_ids:
        return
    session.exec(delete(DocMember).where(DocMember.doc_id.in_(doc_ids)))
    session.exec(delete(DocVersion).where(DocVersion.doc_id.in_(doc_ids)))
    session.exec(delete(Doc).where(Doc.id.in_(doc_ids)))
    if data_dir:
        for doc_id in doc_ids:
            shutil.rmtree(data_dir / "doc-images" / doc_id, ignore_errors=True)


def purge_user(session: Session, user_id: str, data_dir: Path | None = None):
    """注销账户时删除其文档与参与记录；调用方负责提交。"""
    purge(session, list(session.exec(select(Doc.id).where(Doc.user_id == user_id)).all()), data_dir)
    session.exec(delete(DocMember).where(DocMember.user_id == user_id))
    session.exec(delete(DocImageSetting).where(DocImageSetting.user_id == user_id))


# —— 成员 ——


def member_rows(session: Session, doc: Doc) -> list[dict]:
    rows = session.exec(select(DocMember, User).join(User, User.id == DocMember.user_id)
                        .where(DocMember.doc_id == doc.id).order_by(DocMember.created_at)).all()
    return [{**person(user), "email": user.email, "role": member.role,
             "can_share": member.can_share, "created_at": member.created_at}
            for member, user in rows]


def require_sharer(request: Request, session: Session, doc_id: str, write: bool = False):
    doc, access, user = require(request, session, doc_id, write=write)
    if not access.can_share:
        raise HTTPException(403, "没有分享权限")
    return doc, access, user


@router.get("/api/docs/{doc_id}/members")
def list_members(doc_id: str, request: Request, session: Session = Depends(database)):
    doc, access, _ = require_sharer(request, session, doc_id)
    return {"owner": {**person(session.get(User, doc.user_id)),
                      "email": session.get(User, doc.user_id).email},
            "members": member_rows(session, doc)}


def grant(session: Session, doc: Doc, access: Access, granter: User, target: User, role: str,
          can_share: bool) -> DocMember:
    """以 granter 的权限把 target 设为成员；私信里的协作邀请被接受时也走这里。

    调用方负责提交并刷新在线连接。
    """
    if target.disabled:
        raise HTTPException(404, "没有找到这个用户")
    if target.id == doc.user_id:
        raise HTTPException(400, "所有者已拥有全部权限")
    existing = session.get(DocMember, (doc.id, target.id))
    if access.role != "owner":
        # 非所有者只能授予不超过自己的权限，也不能改动比自己权限高的成员。
        if RANK[role] > RANK[access.role] or (existing and RANK[existing.role] > RANK[access.role]):
            raise HTTPException(403, "不能授予超过自己的权限")
    if existing is None:
        count = session.exec(select(func.count()).select_from(DocMember)
                             .where(DocMember.doc_id == doc.id)).one()
        if count >= MEMBER_LIMIT:
            raise HTTPException(400, f"每篇文档最多 {MEMBER_LIMIT} 位成员")
        existing = DocMember(doc_id=doc.id, user_id=target.id, added_by=granter.id, created_at=time.time())
    existing.role, existing.can_share = role, can_share
    session.add(existing)
    return existing


@router.post("/api/docs/{doc_id}/members")
def put_member(doc_id: str, body: DocMemberWrite, request: Request,
               session: Session = Depends(database)):
    doc, access, user = require_sharer(request, session, doc_id, write=True)
    target = session.exec(select(User).where(func.lower(User.email) == body.email.strip().lower())).first()
    if target is None or target.disabled:
        raise HTTPException(404, "没有找到这个邮箱对应的用户，请确认对方已注册")
    grant(session, doc, access, user, target, body.role, body.can_share)
    session.commit()
    anyio.from_thread.run(rooms_of(request).refresh, doc.id)
    audit.record("doc.member", request, ok=True, user=user.id, doc=doc.id, target=target.id,
                 role=body.role)
    return {"members": member_rows(session, doc)}


@router.post("/api/docs/{doc_id}/members/{user_id}/remove")
def remove_member(doc_id: str, user_id: str, request: Request, session: Session = Depends(database)):
    doc, access, user = require(request, session, doc_id, write=True)
    member = session.get(DocMember, (doc.id, user_id))
    if member is None:
        raise HTTPException(404, "成员不存在")
    # 成员可以自行退出；其他情况需要分享权限，且不能移除权限比自己高的人。
    if user_id != user.id:
        if not access.can_share:
            raise HTTPException(403, "没有分享权限")
        if access.role != "owner" and RANK[member.role] > RANK[access.role]:
            raise HTTPException(403, "不能移除权限比自己高的成员")
    session.delete(member)
    session.commit()
    anyio.from_thread.run(rooms_of(request).refresh, doc.id)
    audit.record("doc.member_remove", request, ok=True, user=user.id, doc=doc.id, target=user_id)
    return {"members": member_rows(session, doc) if access.can_share else []}


# —— 链接 ——


@router.put("/api/docs/{doc_id}/link")
def put_link(doc_id: str, body: DocLinkWrite, request: Request, session: Session = Depends(database)):
    doc, access, user = require(request, session, doc_id, write=True)
    if access.role != "owner":
        raise HTTPException(403, "只有所有者可以设置链接分享")
    if body.expires_at and body.expires_at <= time.time():
        raise HTTPException(400, "有效期必须晚于当前时间")
    doc.link_role, doc.link_expires_at = body.role, body.expires_at
    if body.password is not None:
        doc.link_password_hash = hash_password(body.password) if body.password else ""
    if body.regenerate:
        doc.link_token = new_id(22)
    session.add(doc)
    session.commit()
    anyio.from_thread.run(rooms_of(request).refresh, doc.id)
    audit.record("doc.link", request, ok=True, user=user.id, doc=doc.id, role=body.role)
    return link_view(request.app.state.settings, doc)


# —— 版本 ——


def require_editor(request: Request, session: Session, doc_id: str, link: str, write: bool = False):
    doc, access, user = require(request, session, doc_id, link, write=write)
    if access.role not in WRITERS:
        raise HTTPException(403, "只有可编辑的成员可以查看版本历史")
    return doc, access, user


def version_view(session: Session, row: DocVersion) -> dict:
    return {"id": row.id, "label": row.label, "auto": row.auto, "size": row.size,
            "created_at": row.created_at,
            "created_by": person(session.get(User, row.created_by)) if row.created_by else None}


@router.get("/api/docs/{doc_id}/versions")
def list_versions(doc_id: str, request: Request, link: str = Query(default="", max_length=64),
                  session: Session = Depends(database)):
    doc, _, _ = require_editor(request, session, doc_id, link)
    rows = session.exec(select(DocVersion).where(DocVersion.doc_id == doc.id)
                        .order_by(DocVersion.created_at.desc())).all()
    return {"versions": [version_view(session, row) for row in rows]}


@router.post("/api/docs/{doc_id}/versions")
def create_version(doc_id: str, body: DocVersionCreate, request: Request,
                   link: str = Query(default="", max_length=64), session: Session = Depends(database)):
    doc, _, user = require_editor(request, session, doc_id, link, write=True)
    state = anyio.from_thread.run(rooms_of(request).snapshot, doc.id)
    if state is None:
        session.refresh(doc)
        state = doc.state
    row = DocVersion(id=new_id(), doc_id=doc.id, state=state, size=len(state),
                     label=body.label.strip() or "手动保存", auto=False, created_at=time.time(),
                     created_by=user.id)
    session.add(row)
    session.commit()
    return version_view(session, row)


@router.get("/api/docs/{doc_id}/versions/{version_id}")
def version_state(doc_id: str, version_id: str, request: Request,
                  link: str = Query(default="", max_length=64), session: Session = Depends(database)):
    doc, _, _ = require_editor(request, session, doc_id, link)
    row = session.get(DocVersion, version_id)
    if row is None or row.doc_id != doc.id:
        raise HTTPException(404, "版本不存在")
    return Response(row.state, media_type="application/octet-stream",
                    headers={"Cache-Control": "private, max-age=86400"})


# —— 图片 ——
# 粘贴或拖入文档的图片存在 data_dir/doc-images/<文档>/ 下，随文档一起删除。
# 地址含 22 位随机名，打开图片不再校验文档权限（与常见文档产品的图片链接一样），
# 这样只读链接与导出的 Markdown 里的图片也能正常显示。

IMAGE_MAX = 10 * 1024 * 1024
IMAGE_DOC_LIMIT = 200 * 1024 * 1024
IMAGE_NAME = re.compile(r"^[A-Za-z0-9]{22}\.(?:jpg|png|webp|gif)$")
IMAGE_TYPES = {"jpg": "image/jpeg", "png": "image/png", "webp": "image/webp", "gif": "image/gif"}


def image_dir(settings, doc_id: str) -> Path:
    return settings.data_dir / "doc-images" / doc_id


def image_target(session: Session, doc: Doc, uploader: User) -> tuple[str, str, dict | None]:
    """决定这次上传存到哪里，返回（去处、计入哪个账户、第三方配置）。

    所有者为文档指定了去处时，所有编辑者的图片都按它存放，本站图床计入所有者的配额、
    第三方图床使用所有者的配置；否则按上传者自己的默认设置。
    """
    if doc.image_target:
        return doc.image_target, doc.user_id, doc.image_custom
    setting = session.get(DocImageSetting, uploader.id)
    if setting is None:
        return "builtin", uploader.id, None
    return setting.target, uploader.id, setting.custom


async def store_image(settings, engine, doc_id: str, target: str, account: str, custom: dict | None,
                      payload: bytes, extension: str) -> str:
    if target == "site":
        def save_site() -> str:
            with Session(engine) as session:
                row, _ = images.store(session, settings, account, payload)
                return images.url(settings, row.path)
        return await asyncio.to_thread(save_site)
    if target == "custom":
        if not custom:
            raise HTTPException(400, "还没有配置第三方图床")
        return await imagehost.upload(custom, payload, extension)
    folder = image_dir(settings, doc_id)

    def save() -> str:
        folder.mkdir(parents=True, exist_ok=True)
        used = sum(item.stat().st_size for item in folder.iterdir() if item.is_file())
        if used + len(payload) > IMAGE_DOC_LIMIT:
            raise HTTPException(413, "这篇文档的图片已达 200 MiB 上限")
        name = f"{new_id(22)}.{extension}"
        temporary = folder / f".{name}.tmp"
        temporary.write_bytes(payload)
        temporary.replace(folder / name)
        return name

    return f"/api/docs/{doc_id}/images/{await asyncio.to_thread(save)}"


@router.post("/api/docs/{doc_id}/images", status_code=201)
async def upload_image(doc_id: str, request: Request, link: str = Query(default="", max_length=64)):
    settings, engine = request.app.state.settings, request.app.state.engine
    with Session(engine) as session:
        doc, _, user = require_editor(request, session, doc_id, link, write=True)
        target, account, custom = image_target(session, doc, user)
    payload = await images.read_upload(request, IMAGE_MAX)
    extension, _, _ = await asyncio.to_thread(images.inspect, payload)
    url = await store_image(settings, engine, doc_id, target, account, custom, payload, extension)
    return {"url": url, "target": target}


# —— 图片去处设置 ——

def test_png() -> bytes:
    from io import BytesIO

    from PIL import Image

    buffer = BytesIO()
    Image.new("RGB", (8, 8), (59, 110, 245)).save(buffer, "PNG")
    return buffer.getvalue()


def target_view(target: str, custom: dict | None) -> dict:
    return {"target": target, "custom": imagehost.masked(custom)}


def checked_custom(body: ImageTargetWrite, previous: dict | None) -> dict | None:
    if body.target != "custom":
        return previous
    if body.custom is None:
        raise HTTPException(400, "请填写第三方图床的配置")
    config = imagehost.merge(body.custom.model_dump(), previous)
    imagehost.validate(config)
    return config


@router.get("/api/docs-settings/images")
def get_image_settings(request: Request, session: Session = Depends(database)):
    user, _ = current_user(request, session)
    setting = session.get(DocImageSetting, user.id)
    return {**target_view(setting.target if setting else "builtin", setting.custom if setting else None),
            "site_available": user.is_admin or storage.plan(session, user.id).images_enabled}


@router.put("/api/docs-settings/images")
def put_image_settings(body: ImageTargetWrite, request: Request, session: Session = Depends(database)):
    user, _ = current_user(request, session, write=True)
    if body.target == "inherit":
        raise HTTPException(400, "默认设置不能选择“跟随上传者”")
    setting = session.get(DocImageSetting, user.id) or DocImageSetting(user_id=user.id)
    setting.custom = checked_custom(body, setting.custom)
    setting.target, setting.updated_at = body.target, time.time()
    session.add(setting)
    session.commit()
    return target_view(setting.target, setting.custom)


@router.post("/api/docs-settings/images/test")
async def test_image_settings(body: ImageTargetWrite, request: Request):
    """用一张 1×1 的图片试传，确认配置可用；未保存的掩码值沿用已保存的配置。"""
    with Session(request.app.state.engine) as session:
        user, _ = current_user(request, session, write=True)
        setting = session.get(DocImageSetting, user.id)
        config = checked_custom(body, setting.custom if setting else None)
    if body.target != "custom" or not config:
        raise HTTPException(400, "只有第三方图床需要测试")
    return {"url": await imagehost.upload(config, test_png(), "png")}


@router.get("/api/docs/{doc_id}/image-settings")
def get_doc_image_settings(doc_id: str, request: Request, session: Session = Depends(database)):
    doc, access, _ = require(request, session, doc_id)
    if access.role != "owner":
        raise HTTPException(403, "只有所有者可以设置")
    return target_view(doc.image_target or "inherit", doc.image_custom)


@router.put("/api/docs/{doc_id}/image-settings")
def put_doc_image_settings(doc_id: str, body: ImageTargetWrite, request: Request,
                           session: Session = Depends(database)):
    doc, access, _ = require(request, session, doc_id, write=True)
    if access.role != "owner":
        raise HTTPException(403, "只有所有者可以设置")
    doc.image_custom = checked_custom(body, doc.image_custom)
    doc.image_target = "" if body.target == "inherit" else body.target
    session.add(doc)
    session.commit()
    return target_view(doc.image_target or "inherit", doc.image_custom)


@router.get("/api/docs/{doc_id}/images/{name}")
def get_image(doc_id: str, name: str, request: Request):
    if not IMAGE_NAME.match(name) or not ID_PATTERN.match(doc_id):
        raise HTTPException(404, "图片不存在")
    path = image_dir(request.app.state.settings, doc_id) / name
    if not path.is_file():
        raise HTTPException(404, "图片不存在")
    return FileResponse(path, media_type=IMAGE_TYPES[name.rsplit(".", 1)[1]], headers={
        "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff"})


# —— 实时协作 ——


def var_uint(value: int) -> bytes:
    out = bytearray()
    while value > 0x7F:
        out.append(0x80 | (value & 0x7F))
        value >>= 7
    out.append(value)
    return bytes(out)


def read_var_uint(data: bytes, pos: int) -> tuple[int, int]:
    value = shift = 0
    while True:
        byte = data[pos]
        pos += 1
        value |= (byte & 0x7F) << shift
        if byte < 0x80:
            return value, pos
        shift += 7


def awareness_clients(message: bytes) -> dict[int, int]:
    """解析 awareness 消息中的客户端编号与时钟，用于断线时广播离开。"""
    clients = {}
    try:
        size, pos = read_var_uint(message, 1)
        payload = message[pos:pos + size]
        count, pos = read_var_uint(payload, 0)
        for _ in range(count):
            client, pos = read_var_uint(payload, pos)
            clock, pos = read_var_uint(payload, pos)
            length, pos = read_var_uint(payload, pos)
            pos += length
            clients[client] = clock
    except IndexError:
        pass
    return clients


def awareness_leave(clients: dict[int, int]) -> bytes:
    body = bytearray(var_uint(len(clients)))
    for client, clock in clients.items():
        body += var_uint(client) + var_uint(clock + 1) + var_uint(4) + b"null"
    return bytes([YMessageType.AWARENESS]) + var_uint(len(body)) + bytes(body)


@dataclass(eq=False)
class Connection:
    socket: WebSocket
    user_id: str
    role: str
    link: str
    cookies: dict
    clients: dict[int, int] = field(default_factory=dict)
    awareness: bytes | None = None


class Room:
    def __init__(self, rooms: "Rooms", doc_id: str, ydoc: YDoc, size: int):
        self.rooms, self.doc_id, self.ydoc, self.size = rooms, doc_id, ydoc, size
        self.connections: set[Connection] = set()
        self.dirty_by = ""
        self.save_task: asyncio.Task | None = None
        self.deleted = False

    async def send(self, connection: Connection, message: bytes):
        try:
            await connection.socket.send_bytes(message)
        except Exception:  # noqa: BLE001 - 对方已断开，由接收循环清理
            pass

    async def broadcast(self, message: bytes, exclude: Connection | None = None):
        await asyncio.gather(*(self.send(other, message) for other in self.connections
                               if other is not exclude))

    async def receive(self, connection: Connection, message: bytes):
        kind = message[0]
        if kind == YMessageType.SYNC and len(message) > 1:
            if message[1] == YSyncMessageType.SYNC_STEP1:
                reply = handle_sync_message(message[1:], self.ydoc)
                if reply:
                    await self.send(connection, reply)
            elif message[1] in (YSyncMessageType.SYNC_STEP2, YSyncMessageType.SYNC_UPDATE):
                if connection.role not in WRITERS or self.size > MAX_STATE:
                    return
                # 客户端连上时回应的 SYNC_STEP2 往往是空更新，不必应用、转发，也不算修改。
                # 不能用状态向量判断：只删除内容的更新不会改变状态向量。
                length, start = read_var_uint(message, 2)
                if message[start:start + length] == EMPTY_UPDATE:
                    return
                handle_sync_message(message[1:], self.ydoc)
                self.size += len(message)
                await self.broadcast(bytes([YMessageType.SYNC, YSyncMessageType.SYNC_UPDATE])
                                     + message[2:], exclude=connection)
                self.touch(connection.user_id)
        elif kind == YMessageType.AWARENESS:
            connection.clients.update(awareness_clients(message))
            connection.awareness = message
            await self.broadcast(message, exclude=connection)
        elif kind == QUERY_AWARENESS:
            for other in self.connections:
                if other is not connection and other.awareness:
                    await self.send(connection, other.awareness)

    def touch(self, user_id: str):
        self.dirty_by = user_id
        if self.save_task is None or self.save_task.done():
            self.save_task = asyncio.create_task(self.save_later())

    async def save_later(self):
        await asyncio.sleep(SAVE_DELAY)
        await self.flush()

    async def flush(self):
        if not self.dirty_by or self.deleted:
            return
        user_id, self.dirty_by = self.dirty_by, ""
        state = self.ydoc.get_update()
        self.size = len(state)
        await asyncio.to_thread(persist, self.rooms.engine, self.doc_id, state, user_id)


def persist(engine, doc_id: str, state: bytes, user_id: str):
    with Session(engine) as session:
        doc = session.get(Doc, doc_id)
        if doc is None:
            return
        now = time.time()
        # 停顿 10 分钟后重新开始编辑，或连续编辑超过 30 分钟时，先把改动前的内容存为版本，
        # 这样总能退回到“这一轮编辑之前”的样子；空文档不存。
        last = session.exec(select(func.max(DocVersion.created_at))
                            .where(DocVersion.doc_id == doc_id)).one()
        resumed = now - doc.updated_at >= IDLE_SECONDS
        long_run = now - (last or doc.created_at) >= AUTO_VERSION_SECONDS
        if len(doc.state) > 2 and (resumed or long_run):
            session.add(DocVersion(id=new_id(), doc_id=doc_id, state=doc.state, size=len(doc.state),
                                   created_at=doc.updated_at, created_by=doc.updated_by))
            stale = session.exec(select(DocVersion.id).where(DocVersion.doc_id == doc_id,
                                                             DocVersion.auto)
                                 .order_by(DocVersion.created_at.desc())
                                 .offset(AUTO_VERSION_KEEP)).all()
            if stale:
                session.exec(delete(DocVersion).where(DocVersion.id.in_(stale)))
        doc.state, doc.size, doc.updated_at, doc.updated_by = state, len(state), now, user_id
        session.add(doc)
        session.commit()


def read_state(engine, doc_id: str) -> bytes | None:
    with Session(engine) as session:
        doc = session.get(Doc, doc_id)
        return None if doc is None else doc.state


def authorize(engine, settings, doc_id: str, link: str, cookies) -> tuple[str | None, str]:
    with Session(engine) as session:
        doc = session.get(Doc, doc_id)
        if doc is None:
            return None, ""
        user = optional_user(session, cookies)
        access = resolve(session, settings, doc, user, link, cookies)
        return (access.role if access else None), (user.id if user else "")


class Rooms:
    def __init__(self, engine, settings):
        self.engine, self.settings = engine, settings
        self.rooms: dict[str, Room] = {}
        self.lock = asyncio.Lock()

    async def join(self, doc_id: str, connection: Connection) -> Room | None:
        async with self.lock:
            room = self.rooms.get(doc_id)
            if room is None:
                state = await asyncio.to_thread(read_state, self.engine, doc_id)
                if state is None:
                    return None
                ydoc = YDoc()
                if state:
                    ydoc.apply_update(state)
                room = self.rooms[doc_id] = Room(self, doc_id, ydoc, len(state))
            room.connections.add(connection)
            return room

    async def leave(self, room: Room, connection: Connection):
        room.connections.discard(connection)
        if connection.clients:
            await room.broadcast(awareness_leave(connection.clients))
        if not room.connections:
            await room.flush()
            async with self.lock:
                if not room.connections and self.rooms.get(room.doc_id) is room:
                    del self.rooms[room.doc_id]

    async def snapshot(self, doc_id: str) -> bytes | None:
        room = self.rooms.get(doc_id)
        if room is None:
            return None
        await room.flush()
        return room.ydoc.get_update()

    async def refresh(self, doc_id: str):
        """成员或链接设置变化后重新计算在线连接的权限。"""
        room = self.rooms.get(doc_id)
        if room is None:
            return
        for connection in list(room.connections):
            role, _ = await asyncio.to_thread(authorize, self.engine, self.settings, doc_id,
                                              connection.link, connection.cookies)
            if role is None:
                await self.kick(connection, CLOSE_FORBIDDEN)
            elif role != connection.role:
                await self.kick(connection, CLOSE_RECONNECT)

    async def close(self, doc_id: str, code: int):
        room = self.rooms.get(doc_id)
        if room is None:
            return
        room.deleted = True
        for connection in list(room.connections):
            await self.kick(connection, code)

    async def kick(self, connection: Connection, code: int):
        try:
            await connection.socket.close(code)
        except Exception:  # noqa: BLE001 - 已断开
            pass


def rooms_of(scope) -> Rooms:
    app = scope.app
    if not hasattr(app.state, "doc_rooms"):
        app.state.doc_rooms = Rooms(app.state.engine, app.state.settings)
    return app.state.doc_rooms


@router.websocket("/api/docs/ws/{doc_id}")
async def doc_socket(socket: WebSocket, doc_id: str, link: str = ""):
    settings = socket.app.state.settings
    await socket.accept()
    # 浏览器的 WebSocket 不受同源策略限制，必须自行校验来源，防止其他网站借用登录 Cookie。
    if socket.headers.get("origin", "").rstrip("/") not in settings.origins:
        await socket.close(CLOSE_FORBIDDEN)
        return
    cookies = dict(socket.cookies)
    role, user_id = await asyncio.to_thread(authorize, socket.app.state.engine, settings, doc_id,
                                            link[:64], cookies)
    if role is None:
        await socket.close(CLOSE_FORBIDDEN if user_id else CLOSE_LOGIN)
        return
    rooms = rooms_of(socket)
    connection = Connection(socket, user_id, role, link[:64], cookies)
    room = await rooms.join(doc_id, connection)
    if room is None:
        await socket.close(CLOSE_GONE)
        return
    try:
        await room.send(connection, create_sync_message(room.ydoc))
        for other in list(room.connections):
            if other is not connection and other.awareness:
                await room.send(connection, other.awareness)
        while True:
            event = await socket.receive()
            if event["type"] == "websocket.disconnect":
                break
            message = event.get("bytes")
            if not message:
                continue
            if len(message) > MAX_MESSAGE:
                await socket.close(1009)
                break
            await room.receive(connection, message)
    finally:
        # 断线时处理函数可能被取消（如服务关闭），离开房间与最后一次写回不能被打断。
        await asyncio.shield(rooms.leave(room, connection))

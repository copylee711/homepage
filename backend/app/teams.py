"""团队：成员共享的一块存储空间与一组协作文档。

空间在创建时从所有者的总配额里划拨（空着也算占用），文件放在 drive_dir/.teams/<id>/，
网页文件操作复用云盘接口（带 team 参数），WebDAV 在 /t/<id>/ 下单独提供。
成员沿用文档的 edit / view：可编辑成员读写文件、编辑全部团队文档，只读成员只能浏览与下载。
"""

import secrets
import shutil
import string
import time

import anyio.from_thread
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import delete, func, update
from sqlmodel import Session, select

from . import audit, storage, storage_terms
from .accounts import client_ip, current_user
from .drive import accounts as drive_accounts
from .drive import paths
from .drive.errors import Conflict, Invalid
from .drive.vfs import TeamDrive, team_dir
from .models import Doc, DriveCredential, Team, TeamMember, User
from .schemas import (
    AppPasswordCreate,
    TeamCreate,
    TeamDocCreate,
    TeamMemberWrite,
    TeamText,
    TeamUpdate,
)

router = APIRouter()
ID_ALPHABET = string.ascii_lowercase + string.digits
TEAM_LIMIT = 20
MEMBER_LIMIT = 50
MIB = 1024 * 1024
DEFAULT_QUOTA = 1024 * MIB
MIN_QUOTA = 10 * MIB
TREE_LIMIT = 5000
TEXT_MAX = 2 * MIB
RANK = {"view": 1, "edit": 2, "owner": 3}


def database(request: Request):
    with Session(request.app.state.engine) as session:
        yield session


def new_id() -> str:
    return "".join(secrets.choice(ID_ALPHABET) for _ in range(10))


# —— 权限 ——


def role_of(session: Session, team: Team, user_id: str) -> str | None:
    if team.user_id == user_id:
        return "owner"
    member = session.get(TeamMember, (team.id, user_id))
    return member.role if member else None


def usable(session: Session, team: Team | None) -> bool:
    """所有者被停用时团队一起停用。"""
    owner = session.get(User, team.user_id) if team else None
    return owner is not None and not owner.disabled


def require(request: Request, session: Session, team_id: str, write: bool = False,
            role: str = "view") -> tuple[Team, str, User]:
    user, _ = current_user(request, session, write=write)
    team = session.get(Team, team_id)
    current = role_of(session, team, user.id) if usable(session, team) else None
    if current is None:
        raise HTTPException(404, "团队不存在或无权访问")
    if RANK[current] < RANK[role]:
        raise HTTPException(403, "只有所有者可以这样做" if role == "owner" else "没有编辑权限")
    return team, current, user


def open_drive(request: Request, team: Team, user_id: str, role: str) -> TeamDrive:
    return TeamDrive(request.app.state.engine, request.app.state.settings, team.id, user_id,
                     role == "view", protocol="web", ip=client_ip(request),
                     ua=request.headers.get("user-agent", ""))


def can_create(session: Session, user: User) -> bool:
    plan = storage.plan(session, user.id)
    return plan.drive_enabled and storage.agreed(session, user.id)


# —— 视图 ——


def person(user: User | None) -> dict | None:
    return {"id": user.id, "name": user.name, "avatar": user.avatar} if user else None


def dav_url(settings, team: Team) -> str:
    return f"{drive_accounts.connection_info(settings)['dav_url'].rstrip('/')}/t/{team.id}/"


def team_view(session: Session, settings, team: Team, role: str) -> dict:
    members = session.exec(select(func.count()).select_from(TeamMember)
                           .where(TeamMember.team_id == team.id)).one()
    docs = session.exec(select(func.count()).select_from(Doc).where(Doc.team_id == team.id)).one()
    return {"id": team.id, "name": team.name, "description": team.description, "role": role,
            "owner": person(session.get(User, team.user_id)), "quota": team.quota_bytes,
            "used": team.used_bytes, "files": team.used_files, "members": members + 1,
            "docs": docs, "created_at": team.created_at, "updated_at": team.updated_at,
            "dav_url": dav_url(settings, team)}


def member_rows(session: Session, team: Team) -> list[dict]:
    owner = session.get(User, team.user_id)
    rows = session.exec(select(TeamMember, User).join(User, User.id == TeamMember.user_id)
                        .where(TeamMember.team_id == team.id).order_by(TeamMember.created_at)).all()
    return [{**person(owner), "email": owner.email, "role": "owner", "created_at": team.created_at}] + [
        {**person(user), "email": user.email, "role": member.role, "created_at": member.created_at}
        for member, user in rows]


def default_quota(session: Session, user_id: str) -> int:
    left = storage.remaining(session, user_id)
    if left is None or left >= DEFAULT_QUOTA:
        return DEFAULT_QUOTA
    return max(left // 2 // MIB * MIB, 0)


# —— 团队 ——


@router.get("/api/teams")
def list_teams(request: Request, session: Session = Depends(database)):
    user, _ = current_user(request, session)
    settings = request.app.state.settings
    owned = session.exec(select(Team).where(Team.user_id == user.id)
                         .order_by(Team.updated_at.desc())).all()
    joined = session.exec(select(Team, TeamMember.role).join(TeamMember, TeamMember.team_id == Team.id)
                          .where(TeamMember.user_id == user.id).order_by(Team.updated_at.desc())).all()
    allowed = can_create(session, user)
    left = storage.remaining(session, user.id) if allowed else 0
    return {"can_create": allowed, "remaining": left,
            "default_quota": default_quota(session, user.id) if allowed else 0,
            "teams": [team_view(session, settings, team, "owner") for team in owned]
            + [team_view(session, settings, team, role) for team, role in joined if usable(session, team)]}


@router.post("/api/teams")
def create_team(body: TeamCreate, request: Request, session: Session = Depends(database)):
    user, _ = current_user(request, session, write=True)
    if not storage.plan(session, user.id).drive_enabled:
        raise HTTPException(403, "创建团队需要先开通云盘，空间从你的云盘配额里划拨")
    if not storage.agreed(session, user.id):
        raise HTTPException(403, storage_terms.REQUIRED)
    count = session.exec(select(func.count()).select_from(Team).where(Team.user_id == user.id)).one()
    if count >= TEAM_LIMIT:
        raise HTTPException(400, f"最多创建 {TEAM_LIMIT} 个团队")
    quota = body.quota_mb * MIB
    left = storage.remaining(session, user.id)
    if left is not None and quota > left:
        raise HTTPException(400, f"剩余配额不足，最多还能划拨 {max(left, 0) // MIB} MB")
    now = time.time()
    team = Team(id=new_id(), user_id=user.id, name=body.name.strip() or "未命名团队",
                description=body.description.strip(), quota_bytes=quota, created_at=now,
                updated_at=now)
    session.add(team)
    session.commit()
    team_dir(request.app.state.settings, team.id).mkdir(parents=True, exist_ok=True)
    audit.record("team.create", request, ok=True, user=user.id, team=team.id, quota=quota)
    return team_view(session, request.app.state.settings, team, "owner")


@router.get("/api/teams/{team_id}")
def get_team(team_id: str, request: Request, session: Session = Depends(database)):
    team, role, user = require(request, session, team_id)
    data = team_view(session, request.app.state.settings, team, role)
    if role == "owner":
        # 调整额度时的上限：自己的剩余配额加上当前额度。
        left = storage.remaining(session, user.id)
        data["max_quota"] = None if left is None else left + team.quota_bytes
    return data


@router.patch("/api/teams/{team_id}")
def update_team(team_id: str, body: TeamUpdate, request: Request, session: Session = Depends(database)):
    team, role, user = require(request, session, team_id, write=True, role="owner")
    if body.name is not None:
        team.name = body.name.strip() or team.name
    if body.description is not None:
        team.description = body.description.strip()
    if body.quota_mb is not None:
        quota = body.quota_mb * MIB
        if quota < team.used_bytes:
            raise HTTPException(400, "额度不能小于团队已用的空间")
        left = storage.remaining(session, user.id)
        if left is not None and quota - team.quota_bytes > left:
            raise HTTPException(400, f"剩余配额不足，最多还能增加 {max(left, 0) // MIB} MB")
        team.quota_bytes = quota
    team.updated_at = time.time()
    session.add(team)
    session.commit()
    return get_team(team_id, request, session)


def purge(session: Session, settings, team: Team):
    """删除团队的文件、文档与成员；由调用方提交。"""
    from .docs import purge as purge_docs

    purge_docs(session, list(session.exec(select(Doc.id).where(Doc.team_id == team.id)).all()),
               settings.data_dir)
    session.exec(delete(TeamMember).where(TeamMember.team_id == team.id))
    session.delete(team)
    shutil.rmtree(team_dir(settings, team.id), ignore_errors=True)


def purge_user(session: Session, settings, user_id: str):
    """注销账户：删除名下团队，退出参与的团队（其文档转给团队所有者）。由调用方提交。"""
    for team in session.exec(select(Team).where(Team.user_id == user_id)).all():
        purge(session, settings, team)
    for member in session.exec(select(TeamMember).where(TeamMember.user_id == user_id)).all():
        hand_over(session, member.team_id, user_id)
        session.delete(member)


@router.delete("/api/teams/{team_id}")
def delete_team(team_id: str, request: Request, session: Session = Depends(database)):
    team, _, user = require(request, session, team_id, write=True, role="owner")
    doc_ids = list(session.exec(select(Doc.id).where(Doc.team_id == team.id)).all())
    purge(session, request.app.state.settings, team)
    session.commit()
    from .docs import CLOSE_GONE, rooms_of

    rooms = rooms_of(request)
    for doc_id in doc_ids:
        anyio.from_thread.run(rooms.close, doc_id, CLOSE_GONE)
    audit.record("team.delete", request, ok=True, user=user.id, team=team_id)
    return {"ok": True}


# —— 成员 ——


def hand_over(session: Session, team_id: str, user_id: str):
    """成员离开团队时，他在团队里建的文档转给团队所有者。"""
    team = session.get(Team, team_id)
    if team is not None:
        session.exec(update(Doc).where(Doc.team_id == team_id, Doc.user_id == user_id)
                     .values(user_id=team.user_id))


def refresh_rooms(request: Request, session: Session, team: Team):
    """成员变化后，让团队文档的在线连接重新计算权限。"""
    from .docs import rooms_of

    rooms = rooms_of(request)
    for doc_id in session.exec(select(Doc.id).where(Doc.team_id == team.id)).all():
        anyio.from_thread.run(rooms.refresh, doc_id)


@router.get("/api/teams/{team_id}/members")
def list_members(team_id: str, request: Request, session: Session = Depends(database)):
    team, _, _ = require(request, session, team_id)
    return {"members": member_rows(session, team)}


@router.post("/api/teams/{team_id}/members")
def put_member(team_id: str, body: TeamMemberWrite, request: Request,
               session: Session = Depends(database)):
    team, _, user = require(request, session, team_id, write=True, role="owner")
    if body.user_id:
        target = session.get(User, body.user_id)
    else:
        target = session.exec(select(User).where(func.lower(User.email) == body.email.strip().lower())).first()
    if target is None or target.disabled:
        raise HTTPException(404, "没有找到这个用户，请确认对方已注册")
    if target.id == team.user_id:
        raise HTTPException(400, "所有者已拥有全部权限")
    member = session.get(TeamMember, (team.id, target.id))
    if member is None:
        count = session.exec(select(func.count()).select_from(TeamMember)
                             .where(TeamMember.team_id == team.id)).one()
        if count >= MEMBER_LIMIT:
            raise HTTPException(400, f"每个团队最多 {MEMBER_LIMIT} 位成员")
        member = TeamMember(team_id=team.id, user_id=target.id, added_by=user.id,
                            created_at=time.time())
    member.role = body.role
    session.add(member)
    session.commit()
    refresh_rooms(request, session, team)
    audit.record("team.member", request, ok=True, user=user.id, team=team.id, target=target.id,
                 role=body.role)
    return {"members": member_rows(session, team)}


@router.post("/api/teams/{team_id}/members/{user_id}/remove")
def remove_member(team_id: str, user_id: str, request: Request, session: Session = Depends(database)):
    team, role, user = require(request, session, team_id, write=True)
    # 成员可以自行退出；移除别人只有所有者可以。
    if user_id != user.id and role != "owner":
        raise HTTPException(403, "只有所有者可以移除成员")
    member = session.get(TeamMember, (team.id, user_id))
    if member is None:
        raise HTTPException(404, "成员不存在")
    hand_over(session, team.id, user_id)
    session.delete(member)
    session.commit()
    refresh_rooms(request, session, team)
    audit.record("team.member_remove", request, ok=True, user=user.id, team=team.id, target=user_id)
    return {"members": member_rows(session, team) if user_id != user.id else []}


# —— 文件树、文档与文本文件 ——


@router.get("/api/teams/{team_id}/tree")
def tree(team_id: str, request: Request, session: Session = Depends(database)):
    """全部文件夹、文件与文档（最多 TREE_LIMIT 项），前端据此展开文件树、补全 [[文件]] 引用。"""
    team, role, user = require(request, session, team_id)
    drive = open_drive(request, team, user.id, role)
    items, stack, partial = [], ["/"], False
    while stack:
        folder = stack.pop()
        for entry in drive.list(folder):
            if len(items) >= TREE_LIMIT:
                partial, stack = True, []
                break
            path = paths.join(folder, entry.name)
            items.append({"path": path, "name": entry.name, "dir": entry.is_dir, "size": entry.size,
                          "mtime": entry.mtime, "doc": entry.doc})
            if entry.is_dir:
                stack.append(path)
    return {"items": items, "partial": partial, "read_only": role == "view"}


@router.post("/api/teams/{team_id}/docs")
def create_doc(team_id: str, body: TeamDocCreate, request: Request, session: Session = Depends(database)):
    from .docs import Access, doc_view
    from .docs import new_id as doc_id

    team, _, user = require(request, session, team_id, write=True, role="edit")
    folder = paths.clean(body.folder)
    drive = open_drive(request, team, user.id, "edit")
    if folder != "/" and not drive.real_dir(folder):
        raise HTTPException(404, "文件夹不存在")
    now = time.time()
    doc = Doc(id=doc_id(), user_id=user.id, title=body.title.strip() or "未命名文档",
              link_token=doc_id(22), team_id=team.id, folder=folder, created_at=now,
              updated_at=now, updated_by=user.id)
    team.updated_at = now
    session.add(doc)
    session.add(team)
    session.commit()
    audit.record("doc.create", request, ok=True, user=user.id, doc=doc.id, team=team.id)
    return doc_view(session, request.app.state.settings, doc, Access("owner", True, True))


@router.get("/api/teams/{team_id}/text")
def read_text(team_id: str, request: Request, path: str = Query(max_length=4096),
              session: Session = Depends(database)):
    team, role, user = require(request, session, team_id)
    drive = open_drive(request, team, user.id, role)
    path = paths.clean(path)
    entry = drive.stat(path)
    if entry.is_dir or entry.doc:
        raise Invalid("不是文本文件")
    if entry.size > TEXT_MAX:
        raise Invalid("文件超过 2 MiB，不能在线编辑")
    with drive.open_read(path, log=False) as handle:
        data = handle.read(TEXT_MAX + 1)
    try:
        content = data.decode("utf-8")
    except UnicodeDecodeError:
        raise Invalid("不是 UTF-8 文本文件，不能在线编辑") from None
    if "\x00" in content:
        raise Invalid("不是文本文件")
    return {"path": path, "content": content, "version": entry.etag, "read_only": role == "view"}


@router.put("/api/teams/{team_id}/text")
def write_text(team_id: str, body: TeamText, request: Request, session: Session = Depends(database)):
    """保存文本文件：版本与打开时不一致说明期间被别人改过，返回 409 让用户选择覆盖或放弃。"""
    team, _, user = require(request, session, team_id, write=True, role="edit")
    drive = open_drive(request, team, user.id, "edit")
    path = paths.clean(body.path)
    current = drive.stat(path).etag if drive.exists(path) else ""
    if current != body.version and not body.force:
        raise Conflict("文件已被其他人修改")
    mount, _ = drive.writable(path)
    spool = mount.backend.spool()
    spool.write_bytes(body.content.encode())
    drive.write(path, spool)
    entry = drive.stat(path)
    return {"path": path, "version": entry.etag, "size": entry.size, "mtime": entry.mtime}


# —— 映射到本地：应用密码 ——
# 与云盘设置里的是同一套凭据，没有开通云盘的成员也能在这里生成，但只能访问自己所在的团队。


def own_passwords(session: Session, user_id: str) -> list[dict]:
    return [item for item in drive_accounts.credentials(session, user_id)
            if item["kind"] == "app_password"]


@router.get("/api/teams-access")
def access_info(request: Request, session: Session = Depends(database)):
    user, _ = current_user(request, session)
    account = drive_accounts.account_view(session, request.app.state.settings, user)
    return {"login": account["login"] or user.email, "email": user.email,
            "dav_url": account["dav_url"], "passwords": own_passwords(session, user.id)}


@router.post("/api/teams-access/app-passwords")
def add_password(body: AppPasswordCreate, request: Request, session: Session = Depends(database)):
    user, _ = current_user(request, session, write=True)
    try:
        return drive_accounts.add_app_password(session, user.id, body.name or "团队映射")
    except Conflict as error:
        raise HTTPException(400, error.message) from None


@router.post("/api/teams-access/app-passwords/{credential_id}/remove")
def remove_password(credential_id: str, request: Request, session: Session = Depends(database)):
    user, _ = current_user(request, session, write=True)
    row = session.get(DriveCredential, credential_id)
    if row is None or row.user_id != user.id or row.kind != "app_password":
        raise HTTPException(404, "凭据不存在")
    session.delete(row)
    session.commit()
    return {"passwords": own_passwords(session, user.id)}

"""网盘的 Web API：文件管理、可续传上传、打包下载、凭据、分享与后台管理。"""

import asyncio
import mimetypes
import re
import secrets
import time
import zipfile
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from sqlmodel import Session, select

from .. import audit, storage
from ..accounts import client_ip, current_user, record_failure, throttle
from ..auth import check_origin, current_session, digest
from ..images import _Sink
from ..models import DriveAccount, DriveUpload, HostedImage, User
from ..schemas import (
    AppPasswordCreate,
    DriveLogin,
    DrivePath,
    DrivePaths,
    DriveRename,
    DriveTransfer,
    KeyCreate,
    MountCreate,
    MountUpdate,
    ShareCreate,
    ShareUnlock,
    StoragePlanWrite,
    UploadCreate,
)
from . import accounts, paths, shares
from .errors import DriveError, Invalid, NotFound
from .vfs import Drive, rescan

router = APIRouter()
CHUNK = 1024 * 1024
MAX_PART = 32 * 1024 * 1024
UPLOAD_HOURS = 24
RANGE = re.compile(r"^bytes=(\d*)-(\d*)$")
MIB = 1024 * 1024


async def drive_error(_, exc: DriveError):
    return JSONResponse({"detail": exc.message}, status_code=exc.status)


def database(request: Request):
    with Session(request.app.state.engine) as session:
        yield session


def admin(request: Request, session: Session = Depends(database)):
    current_session(request, session, request.method not in {"GET", "HEAD", "OPTIONS"})
    return session


def settings_of(request: Request):
    return request.app.state.settings


def open_drive(request: Request, user_id: str) -> Drive:
    return Drive(request.app.state.engine, settings_of(request), user_id, protocol="web",
                 ip=client_ip(request), ua=request.headers.get("user-agent", ""))


def user_drive(request: Request, session: Session, write: bool = False) -> tuple[User, Drive]:
    user, _ = current_user(request, session, write=write)
    return user, open_drive(request, user.id)


def entry_view(entry, path: str) -> dict:
    return {"name": entry.name, "path": path, "dir": entry.is_dir, "size": entry.size,
            "mtime": entry.mtime}


# —— 下载 ——


def disposition(name: str, inline: bool) -> str:
    kind = "inline" if inline else "attachment"
    fallback = name.encode("ascii", "ignore").decode().replace('"', "") or "download"
    return f"{kind}; filename=\"{fallback}\"; filename*=UTF-8''{quote(name)}"


def file_response(drive: Drive, path: str, request: Request, inline: bool = False,
                  on_start=None) -> Response:
    """支持单段 Range 的流式下载；视频预览与断点续传依赖它。"""
    entry = drive.stat(path)
    if entry.is_dir:
        raise Invalid("不能直接下载目录，请使用打包下载")
    size, start, end, status = entry.size, 0, entry.size - 1, 200
    match = RANGE.match(request.headers.get("range", ""))
    if match and size:
        first, last = match.groups()
        if first:
            start, end = int(first), min(int(last), size - 1) if last else size - 1
        elif last:
            start, end = max(size - int(last), 0), size - 1
        if start > end or start >= size:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
        status = 206
    if on_start and start == 0:
        on_start()
    handle = drive.open_read(path, start, log=start == 0)
    remaining = end - start + 1 if size else 0

    def body():
        nonlocal remaining
        try:
            while remaining > 0:
                chunk = handle.read(min(CHUNK, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk
        finally:
            handle.close()

    media = mimetypes.guess_type(entry.name)[0] or "application/octet-stream"
    # 预览只对不会执行脚本的类型开放，HTML/SVG 等一律作为附件下载。
    previewable = media.split("/")[0] in {"image", "video", "audio"} and media != "image/svg+xml"
    safe_inline = inline and (previewable or media in {"application/pdf", "text/plain"})
    headers = {"Accept-Ranges": "bytes", "Content-Length": str(max(end - start + 1, 0)),
               "Content-Disposition": disposition(entry.name, safe_inline),
               "Cache-Control": "private, no-store"}
    # 浏览器内置 PDF 阅读器在 sandbox 下无法加载，其余类型一律禁止执行脚本。
    if not (safe_inline and media == "application/pdf"):
        headers["Content-Security-Policy"] = "sandbox"
    if status == 206:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    return StreamingResponse(body(), status_code=status, media_type=media, headers=headers)


def zip_stream(drive: Drive, items: list[tuple[str, str]]):
    """边打包边发送；items 为 (网盘路径, 压缩包内名称)。"""
    sink = _Sink()
    with zipfile.ZipFile(sink, "w", zipfile.ZIP_STORED, allowZip64=True) as archive:
        stack = list(reversed(items))
        while stack:
            path, name = stack.pop()
            entry = drive.stat(path)
            if entry.is_dir:
                archive.writestr(name.rstrip("/") + "/", b"")
                for child in reversed(drive.list(path)):
                    stack.append((paths.join(path, child.name), f"{name}/{child.name}"))
                continue
            with drive.open_read(path) as source, archive.open(name, "w", force_zip64=True) as out:
                while chunk := source.read(CHUNK):
                    out.write(chunk)
                    yield sink.take()
            yield sink.take()
    yield sink.take()


def zip_response(drive: Drive, items: list[tuple[str, str]], name: str) -> StreamingResponse:
    return StreamingResponse(zip_stream(drive, items), media_type="application/zip",
                             headers={"Content-Disposition": disposition(f"{name}.zip", False)})


# —— 概览与文件操作 ——


@router.get("/api/drive")
def overview(request: Request, session: Session = Depends(database)):
    user, _ = current_user(request, session)
    summary = storage.summary(session, user.id)
    if not summary["drive_enabled"]:
        return {"enabled": False, "storage": summary}
    return {"enabled": True, "storage": summary, "mounts": accounts.mounts(session, user.id),
            "account": accounts.account_view(session, settings_of(request), user)}


@router.get("/api/drive/list")
def list_dir(request: Request, path: str = "/", session: Session = Depends(database)):
    _, drive = user_drive(request, session)
    path = paths.clean(path)
    entries = drive.list(path)
    mount, _ = drive.resolve(path)
    return {"path": path, "read_only": mount.read_only or mount.backend.read_only,
            "items": [entry_view(entry, paths.join(path, entry.name)) for entry in entries]}


@router.get("/api/drive/download")
def download(request: Request, path: str, inline: bool = False,
             session: Session = Depends(database)):
    _, drive = user_drive(request, session)
    return file_response(drive, paths.clean(path), request, inline)


@router.get("/api/drive/zip")
def download_zip(request: Request, path: list[str] = Query(), session: Session = Depends(database)):
    _, drive = user_drive(request, session)
    targets = [paths.clean(item) for item in path][:500]
    for target in targets:
        drive.stat(target)
    name = paths.name(targets[0]) if len(targets) == 1 else "download"
    return zip_response(drive, [(t, paths.name(t) or "drive") for t in targets], name or "drive")


@router.post("/api/drive/mkdir")
def mkdir(body: DrivePath, request: Request, session: Session = Depends(database)):
    _, drive = user_drive(request, session, write=True)
    drive.mkdir(body.path, parents=body.parents)
    path = paths.clean(body.path)
    return entry_view(drive.stat(path), path)


@router.post("/api/drive/delete")
def delete(body: DrivePaths, request: Request, session: Session = Depends(database)):
    _, drive = user_drive(request, session, write=True)
    for path in body.paths:
        drive.delete(path)
    return {"ok": True}


@router.post("/api/drive/rename")
def rename(body: DriveRename, request: Request, session: Session = Depends(database)):
    _, drive = user_drive(request, session, write=True)
    source = paths.clean(body.path)
    target = paths.join(paths.parent(source), paths.check_name(body.name))
    drive.move(source, target)
    return entry_view(drive.stat(target), target)


@router.post("/api/drive/move")
def move(body: DriveTransfer, request: Request, session: Session = Depends(database)):
    _, drive = user_drive(request, session, write=True)
    for path in body.paths:
        source = paths.clean(path)
        drive.move(source, paths.join(body.target, paths.name(source)), body.overwrite)
    return {"ok": True}


@router.post("/api/drive/copy")
def copy(body: DriveTransfer, request: Request, session: Session = Depends(database)):
    _, drive = user_drive(request, session, write=True)
    for path in body.paths:
        source = paths.clean(path)
        drive.copy(source, paths.join(body.target, paths.name(source)), body.overwrite)
    return {"ok": True}


# —— 可续传上传 ——


def upload_file(settings, upload_id: str) -> Path:
    return settings.drive_dir / ".uploads" / upload_id


def get_upload(session: Session, settings, user_id: str, upload_id: str) -> DriveUpload:
    row = session.get(DriveUpload, upload_id)
    if row is None or row.user_id != user_id or row.expires_at <= time.time():
        raise NotFound("上传会话不存在或已过期，请重新上传")
    if not upload_file(settings, upload_id).exists():
        session.delete(row)
        session.commit()
        raise NotFound("上传会话不存在或已过期，请重新上传")
    return row


def purge_uploads(session: Session, settings):
    for row in session.exec(select(DriveUpload).where(DriveUpload.expires_at <= time.time())).all():
        upload_file(settings, row.id).unlink(missing_ok=True)
        session.delete(row)
    session.commit()


@router.post("/api/drive/uploads")
def upload_create(body: UploadCreate, request: Request, session: Session = Depends(database)):
    user, drive = user_drive(request, session, write=True)
    settings = settings_of(request)
    purge_uploads(session, settings)
    path = paths.clean(body.path)
    mount, rel = drive.writable(path)
    if drive.is_mount(path):
        raise Invalid("同名目录已存在")
    parent = paths.parent(path)
    if not drive.exists(parent) or not drive.stat(parent).is_dir:
        raise NotFound("上级目录不存在")
    existing = mount.backend.stat(rel)
    if existing is not None and existing.is_dir:
        raise Invalid("同名目录已存在")
    drive.reserve(mount, body.size - (existing.size if existing else 0))
    row = DriveUpload(id=secrets.token_hex(16), user_id=user.id, path=path, size=body.size,
                      created_at=time.time(), expires_at=time.time() + UPLOAD_HOURS * 3600)
    target = upload_file(settings, row.id)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.touch()
    session.add(row)
    session.commit()
    return {"id": row.id, "received": 0, "chunk": MAX_PART // 4}


@router.get("/api/drive/uploads/{upload_id}")
def upload_state(upload_id: str, request: Request, session: Session = Depends(database)):
    user, _ = current_user(request, session)
    row = get_upload(session, settings_of(request), user.id, upload_id)
    return {"id": row.id, "received": row.received, "size": row.size, "path": row.path}


@router.put("/api/drive/uploads/{upload_id}")
async def upload_part(upload_id: str, offset: int, request: Request,
                      session: Session = Depends(database)):
    user, _ = current_user(request, session, write=True)
    settings = settings_of(request)
    row = get_upload(session, settings, user.id, upload_id)
    if offset != row.received:
        raise HTTPException(409, f"偏移量不一致，应从 {row.received} 继续")
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_PART or row.received + size > row.size:
            raise HTTPException(413, "分块过大或超出声明的文件大小")
        chunks.append(chunk)

    def append():
        with upload_file(settings, upload_id).open("r+b") as file:
            file.seek(row.received)
            file.write(b"".join(chunks))
            file.truncate()

    await asyncio.to_thread(append)
    row.received += size
    session.add(row)
    session.commit()
    return {"received": row.received}


@router.post("/api/drive/uploads/{upload_id}/finish")
def upload_finish(upload_id: str, request: Request, session: Session = Depends(database)):
    user, drive = user_drive(request, session, write=True)
    settings = settings_of(request)
    row = get_upload(session, settings, user.id, upload_id)
    if row.received != row.size:
        raise HTTPException(409, f"文件尚未传完（{row.received}/{row.size}）")
    session.delete(row)
    session.commit()
    drive.write(row.path, upload_file(settings, upload_id))
    return entry_view(drive.stat(row.path), row.path)


@router.post("/api/drive/uploads/{upload_id}/cancel")
def upload_cancel(upload_id: str, request: Request, session: Session = Depends(database)):
    user, _ = current_user(request, session, write=True)
    settings = settings_of(request)
    row = session.get(DriveUpload, upload_id)
    if row is not None and row.user_id == user.id:
        upload_file(settings, upload_id).unlink(missing_ok=True)
        session.delete(row)
        session.commit()
    return {"ok": True}


# —— 协议登录名与凭据 ——


def enabled_user(request: Request, session: Session, write: bool = True) -> User:
    user, _ = current_user(request, session, write=write)
    if not storage.plan(session, user.id).drive_enabled:
        raise HTTPException(403, "网盘功能尚未为你开启")
    return user


@router.put("/api/drive/login")
def set_login(body: DriveLogin, request: Request, session: Session = Depends(database)):
    user = enabled_user(request, session)
    accounts.set_login(session, user.id, body.login)
    audit.record("drive.set_login", request, ok=True, user=user.id, login=body.login)
    return accounts.account_view(session, settings_of(request), user)


@router.post("/api/drive/keys")
def add_key(body: KeyCreate, request: Request, session: Session = Depends(database)):
    user = enabled_user(request, session)
    with audit.outcome("drive.key_add", request, user=user.id):
        return accounts.add_key(session, user.id, body.name, body.key)


@router.post("/api/drive/app-passwords")
def add_app_password(body: AppPasswordCreate, request: Request,
                     session: Session = Depends(database)):
    user = enabled_user(request, session)
    with audit.outcome("drive.app_password_add", request, user=user.id):
        return accounts.add_app_password(session, user.id, body.name)


@router.post("/api/drive/credentials/{credential_id}/remove")
def remove_credential(credential_id: str, request: Request, session: Session = Depends(database)):
    user, _ = current_user(request, session, write=True)
    accounts.remove_credential(session, user.id, credential_id)
    audit.record("drive.credential_remove", request, ok=True, user=user.id,
                 credential=credential_id)
    return {"ok": True}


@router.post("/api/drive/legacy-password/remove")
def remove_legacy(request: Request, session: Session = Depends(database)):
    user, _ = current_user(request, session, write=True)
    accounts.clear_legacy(session, user.id)
    audit.record("drive.legacy_password_remove", request, ok=True, user=user.id)
    return {"ok": True}


# —— 分享（所有者） ——


@router.get("/api/drive/shares")
def share_list(request: Request, session: Session = Depends(database)):
    user = enabled_user(request, session, write=False)
    return {"items": [shares.view(settings_of(request), row)
                      for row in shares.owned(session, user.id)]}


@router.post("/api/drive/shares")
def share_create(body: ShareCreate, request: Request, session: Session = Depends(database)):
    user, drive = user_drive(request, session, write=True)
    row = shares.create(session, drive, body)
    audit.record("drive.share_create", request, ok=True, user=user.id, share=row.id,
                 paths=row.paths, mode=row.mode)
    return shares.view(settings_of(request), row)


@router.post("/api/drive/shares/{share_id}/remove")
def share_remove(share_id: str, request: Request, session: Session = Depends(database)):
    user, _ = current_user(request, session, write=True)
    shares.remove(session, user.id, share_id)
    audit.record("drive.share_remove", request, ok=True, user=user.id, share=share_id)
    return {"ok": True}


# —— 分享（访客） ——


def share_drive(request: Request, session: Session, share_id: str, need_unlock: bool = True):
    row = shares.active(session, share_id)
    owner = session.get(User, row.user_id)
    if owner is None or owner.disabled:
        raise NotFound("分享不存在或已被取消")
    if need_unlock and not shares.unlocked(settings_of(request), row, request.cookies):
        raise HTTPException(401, "请输入分享密码")
    drive = Drive(request.app.state.engine, settings_of(request), row.user_id, protocol="share",
                  ip=client_ip(request), ua=request.headers.get("user-agent", ""))
    return row, drive


@router.get("/api/s/{share_id}")
def share_info(share_id: str, request: Request, session: Session = Depends(database)):
    row, drive = share_drive(request, session, share_id, need_unlock=False)
    unlocked = shares.unlocked(settings_of(request), row, request.cookies)
    info = {"id": row.id, "name": row.name, "mode": row.mode, "expires_at": row.expires_at,
            "needs_password": bool(row.password_hash), "unlocked": unlocked}
    if unlocked and row.mode == "read":
        info["single_dir"] = shares.single_root(drive, row) is not None
    return info


@router.post("/api/s/{share_id}/unlock")
def share_unlock(share_id: str, body: ShareUnlock, request: Request, response: Response,
                 session: Session = Depends(database)):
    check_origin(request)
    key = f"share:{digest(client_ip(request))}"
    throttle(session, key, 10, "密码错误次数过多，请 15 分钟后再试")
    row = shares.active(session, share_id)
    if not shares.check_password(row, body.password):
        record_failure(session, key)
        raise HTTPException(403, "分享密码错误")
    response.set_cookie(shares.COOKIE_PREFIX + row.id, shares.unlock_token(settings_of(request), row),
                        max_age=7 * 86400, httponly=True, samesite="lax",
                        secure=settings_of(request).secure_cookie, path=f"/api/s/{row.id}")
    return {"ok": True}


@router.get("/api/s/{share_id}/list")
def share_list_dir(share_id: str, request: Request, path: str = "/",
                   session: Session = Depends(database)):
    row, drive = share_drive(request, session, share_id)
    inner = paths.clean(path)
    entries = shares.listing(drive, row, inner)
    return {"path": inner, "items": [entry_view(entry, paths.join(inner, entry.name))
                                     for entry in entries]}


@router.get("/api/s/{share_id}/download")
def share_download(share_id: str, request: Request, path: str, inline: bool = False,
                   session: Session = Depends(database)):
    row, drive = share_drive(request, session, share_id)
    if row.mode != "read":
        raise HTTPException(403, "仅上传分享不能下载")
    target = shares.locate(drive, row, path)
    if target is None:
        raise Invalid("请选择要下载的文件")
    return file_response(drive, target, request, inline,
                         on_start=lambda: shares.consume(session, row))


@router.get("/api/s/{share_id}/zip")
def share_zip(share_id: str, request: Request, path: str = "/",
              session: Session = Depends(database)):
    row, drive = share_drive(request, session, share_id)
    if row.mode != "read":
        raise HTTPException(403, "仅上传分享不能下载")
    target = shares.locate(drive, row, path)
    items = ([(target, paths.name(target))] if target is not None
             else [(item, paths.name(item)) for item in row.paths if drive.exists(item)])
    shares.consume(session, row)
    return zip_response(drive, items, row.name)


@router.put("/api/s/{share_id}/upload")
async def share_upload(share_id: str, name: str, request: Request,
                       session: Session = Depends(database)):
    check_origin(request)
    row, drive = share_drive(request, session, share_id)
    if row.mode != "upload":
        raise HTTPException(403, "该分享不允许上传")
    target = paths.join(row.paths[0], paths.check_name(name))
    if await asyncio.to_thread(drive.exists, target):
        raise HTTPException(409, "同名文件已存在，请改名后再上传")
    upload = await asyncio.to_thread(drive.upload, target)
    try:
        async for chunk in request.stream():
            await asyncio.to_thread(upload.write, chunk)
        await asyncio.to_thread(upload.commit)
    except BaseException:
        await asyncio.to_thread(upload.abort)
        raise
    shares.consume(session, row)
    return {"ok": True, "name": paths.name(target)}


# —— 后台 ——


def require_user(session: Session, user_id: str) -> User:
    user = session.get(User, user_id)
    if user is None:
        raise HTTPException(404, "用户不存在")
    return user


def storage_row(session: Session, user: User) -> dict:
    account = session.get(DriveAccount, user.id)
    return {"id": user.id, "email": user.email, "name": user.name, "disabled": user.disabled,
            "storage": storage.summary(session, user.id),
            "login": account.login if account else "",
            "mounts": accounts.mounts(session, user.id)}


@router.get("/api/admin/storage")
def admin_storage(request: Request, session: Session = Depends(admin)):
    users = session.exec(select(User).order_by(User.created_at.desc())).all()
    return {"users": [storage_row(session, user) for user in users],
            "admin_images": storage.images_used(session, storage.ADMIN),
            "image_count": len(session.exec(select(HostedImage.id)).all()),
            "oss_configured": bool(settings_of(request).oss_bucket),
            "connection": accounts.connection_info(settings_of(request))}


@router.put("/api/admin/storage/users/{user_id}")
def admin_plan(user_id: str, body: StoragePlanWrite, request: Request,
               session: Session = Depends(admin)):
    user = require_user(session, user_id)
    storage.save(session, user_id, images_enabled=body.images_enabled, quota_mb=body.quota_mb,
                 max_image_mb=body.max_image_mb)
    accounts.enable(session, settings_of(request), user_id, body.drive_enabled)
    session.commit()
    audit.record("admin.storage_plan", request, ok=True, user=user_id, **body.model_dump())
    return storage_row(session, user)


@router.put("/api/admin/storage/users/{user_id}/login")
def admin_login(user_id: str, body: DriveLogin, request: Request,
                session: Session = Depends(admin)):
    user = require_user(session, user_id)
    accounts.set_login(session, user_id, body.login)
    audit.record("admin.drive_login", request, ok=True, user=user_id, login=body.login)
    return storage_row(session, user)


@router.post("/api/admin/storage/users/{user_id}/mounts")
def admin_mount_add(user_id: str, body: MountCreate, request: Request,
                    session: Session = Depends(admin)):
    user = require_user(session, user_id)
    accounts.add_mount(session, user_id, body.path, "oss", body.location, body.quota_mb * MIB,
                       body.read_only)
    audit.record("admin.drive_mount_add", request, ok=True, user=user_id, **body.model_dump())
    return storage_row(session, user)


@router.put("/api/admin/storage/users/{user_id}/mounts/{mount_id}")
def admin_mount_update(user_id: str, mount_id: str, body: MountUpdate, request: Request,
                       session: Session = Depends(admin)):
    user = require_user(session, user_id)
    accounts.update_mount(session, user_id, mount_id, body.quota_mb * MIB, body.read_only)
    audit.record("admin.drive_mount_update", request, ok=True, user=user_id, mount=mount_id)
    return storage_row(session, user)


@router.post("/api/admin/storage/users/{user_id}/mounts/{mount_id}/remove")
def admin_mount_remove(user_id: str, mount_id: str, request: Request,
                       session: Session = Depends(admin)):
    user = require_user(session, user_id)
    accounts.remove_mount(session, user_id, mount_id)
    audit.record("admin.drive_mount_remove", request, ok=True, user=user_id, mount=mount_id)
    return storage_row(session, user)


@router.post("/api/admin/storage/users/{user_id}/rescan")
def admin_rescan(user_id: str, request: Request, session: Session = Depends(admin)):
    user = require_user(session, user_id)
    rescan(request.app.state.engine, settings_of(request), user_id)
    return storage_row(session, user)

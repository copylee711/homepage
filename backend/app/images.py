"""图床：上传令牌、配额、存储、导出与旧图片迁移。

图片保存在 data_dir/images/<年>/<月>/<随机 id>.<扩展名>，公开地址与磁盘路径一一对应，
生产环境由 Caddy 在 image 子域名直接提供静态文件。管理员不受配额限制；访客默认关闭，
由后台为受邀用户单独开启并设置配额。
"""

import hashlib
import json
import re
import secrets
import string
import warnings
import zipfile
from datetime import datetime, timezone
from io import BytesIO

from fastapi import HTTPException, Request
from PIL import Image, UnidentifiedImageError
from sqlalchemy import delete, func
from sqlmodel import Session, select
from starlette.datastructures import UploadFile

from .accounts import client_ip, record_failure, throttle
from .auth import digest
from .content import bump, timestamp
from .models import Article, HostedImage, ImageToken, Note, StoragePlan, User
from .notes import bump_notes
from .storage import ADMIN, images_used, plan, shared_used

MAX_IMAGE_BYTES = 20 * 1024 * 1024
TOKEN_LIMIT = 10
PAGE_SIZE = 40
FORMATS = {"JPEG": "jpg", "PNG": "png", "WEBP": "webp", "GIF": "gif"}
ALPHABET = string.ascii_letters + string.digits
PATH = re.compile(r"\d{4}/\d{2}/[A-Za-z0-9]{12}\.(?:jpg|png|webp|gif)")
MEDIA_NAME = r"/media/([a-f0-9]{48}\.(?:jpg|png|webp|gif))"
Image.MAX_IMAGE_PIXELS = 20_000_000


def mib(size: int) -> str:
    return f"{size / 1024 / 1024:g} MiB"


def inspect(payload: bytes) -> tuple[str, int, int]:
    """校验真实图片格式并防御解压炸弹，返回扩展名与像素尺寸。"""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(payload)) as image:
                extension = FORMATS.get(image.format)
                if not extension:
                    raise HTTPException(415, "仅支持 JPEG、PNG、WebP、GIF")
                width, height = image.size
                image.verify()
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError,
            Image.DecompressionBombWarning):
        raise HTTPException(415, "图片损坏或像素尺寸过大") from None
    return extension, width, height


def url(settings, path: str) -> str:
    return f"{settings.image_base}/{path}"


def view(settings, row: HostedImage) -> dict:
    return {"id": row.id, "url": url(settings, row.path), "size": row.size, "width": row.width,
            "height": row.height, "created_at": row.created_at}


# —— 配额 ——


def limits(session: Session, owner: str) -> dict:
    """used 为网盘与图床共用的总用量，images_used 为其中图床部分。"""
    if owner == ADMIN:
        used = images_used(session, owner)
        return {"enabled": True, "quota": None, "max_file": MAX_IMAGE_BYTES, "used": used,
                "images_used": used}
    row = plan(session, owner)
    return {"enabled": row.images_enabled, "quota": row.quota_bytes,
            "max_file": min(row.max_image_bytes, MAX_IMAGE_BYTES),
            "used": shared_used(session, owner), "images_used": images_used(session, owner)}


def require_enabled(session: Session, owner: str) -> dict:
    value = limits(session, owner)
    if not value["enabled"]:
        raise HTTPException(403, "图床功能尚未为你开启")
    return value


def set_quota(session: Session, user_id: str, enabled: bool, quota_mb: int, max_file_mb: int):
    row = plan(session, user_id)
    row.images_enabled = enabled
    row.quota_bytes = quota_mb * 1024 * 1024
    row.max_image_bytes = max_file_mb * 1024 * 1024
    session.add(row)
    if not enabled:
        # 关闭图床同时撤销令牌，已上传的图片保留，重新开启后仍可管理。
        session.exec(delete(ImageToken).where(ImageToken.owner == user_id))
    session.commit()


# —— 读取上传 ——


async def read_stream(request: Request, limit: int) -> bytes:
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise HTTPException(413, f"图片不能超过 {mib(limit)}")
        chunks.append(chunk)
    return b"".join(chunks)


async def read_upload(request: Request, limit: int) -> bytes:
    """接受原始文件流（网页上传）或 multipart 的 file 字段（PicList 等客户端）。"""
    if not request.headers.get("content-type", "").startswith("multipart/form-data"):
        return await read_stream(request, limit)
    # 先按上限读完请求体，再交给 multipart 解析，避免超大请求写入临时文件。
    body = await read_stream(request, limit + 64 * 1024)
    sent = False

    async def replay():
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}

    form = await Request(request.scope, replay).form(max_files=1, max_fields=8)
    try:
        upload = form.get("file")
        if not isinstance(upload, UploadFile):
            upload = next((v for v in form.values() if isinstance(v, UploadFile)), None)
        if upload is None:
            raise HTTPException(422, "请在 file 字段上传图片")
        payload = await upload.read()
    finally:
        await form.close()
    if len(payload) > limit:
        raise HTTPException(413, f"图片不能超过 {mib(limit)}")
    return payload


# —— 存储 ——


def store(session: Session, settings, owner: str, payload: bytes,
          created: datetime | None = None) -> tuple[HostedImage, bool]:
    """保存图片，返回记录与是否新建；同一用户重复上传相同内容时直接返回已有地址。"""
    extension, width, height = inspect(payload)
    checksum = hashlib.sha256(payload).hexdigest()
    # 串行化同一时刻的上传，配额检查与写入之间不会被其他请求插入。
    session.connection().exec_driver_sql("BEGIN IMMEDIATE")
    existing = session.exec(
        select(HostedImage).where(HostedImage.owner == owner, HostedImage.sha256 == checksum)
    ).first()
    if existing:
        session.commit()
        return existing, False
    value = require_enabled(session, owner)
    if len(payload) > value["max_file"]:
        raise HTTPException(413, f"单张图片不能超过 {mib(value['max_file'])}")
    if value["quota"] is not None and value["used"] + len(payload) > value["quota"]:
        raise HTTPException(413, f"存储空间不足（已用 {mib(value['used'])} / {mib(value['quota'])}）")
    created = created or datetime.now(timezone.utc)
    image_id = "".join(secrets.choice(ALPHABET) for _ in range(12))
    path = f"{created:%Y}/{created:%m}/{image_id}.{extension}"
    target = settings.images_dir / path
    for folder in (target.parent.parent, target.parent):
        folder.mkdir(exist_ok=True)
        folder.chmod(0o755)
    temporary = target.parent / f".{target.name}.tmp"
    temporary.write_bytes(payload)
    temporary.replace(target)
    target.chmod(0o644)
    row = HostedImage(id=image_id, owner=owner, path=path, size=len(payload), width=width,
                      height=height, sha256=checksum, created_at=created.isoformat())
    session.add(row)
    try:
        session.commit()
    except Exception:
        target.unlink(missing_ok=True)
        raise
    return row, True


def get_image(session: Session, image_id: str, owner: str | None = None) -> HostedImage:
    row = session.get(HostedImage, image_id)
    if row is None or (owner is not None and row.owner != owner):
        raise HTTPException(404, "图片不存在")
    return row


def remove(session: Session, settings, row: HostedImage):
    (settings.images_dir / row.path).unlink(missing_ok=True)
    session.delete(row)
    session.commit()


def remove_owner(session: Session, settings, owner: str):
    """删除账户时清理该用户的全部图片与令牌；由调用方提交。"""
    for row in session.exec(select(HostedImage).where(HostedImage.owner == owner)).all():
        (settings.images_dir / row.path).unlink(missing_ok=True)
        session.delete(row)
    session.exec(delete(ImageToken).where(ImageToken.owner == owner))
    session.exec(delete(StoragePlan).where(StoragePlan.user_id == owner))


def listing(session: Session, settings, owner: str | None, page: int) -> dict:
    query = select(HostedImage)
    count = select(func.count()).select_from(HostedImage)
    if owner is not None:
        query = query.where(HostedImage.owner == owner)
        count = count.where(HostedImage.owner == owner)
    rows = session.exec(
        query.order_by(HostedImage.created_at.desc(), HostedImage.id)
        .offset(max(page - 1, 0) * PAGE_SIZE).limit(PAGE_SIZE)
    ).all()
    items = [{**view(settings, row), "owner": row.owner} if owner is None else view(settings, row)
             for row in rows]
    return {"items": items, "total": session.exec(count).one(), "page": page,
            "page_size": PAGE_SIZE}


# —— 上传令牌 ——


def token_view(row: ImageToken) -> dict:
    return {"id": row.id, "name": row.name, "created_at": row.created_at,
            "last_used": row.last_used}


def tokens(session: Session, owner: str) -> list[dict]:
    rows = session.exec(
        select(ImageToken).where(ImageToken.owner == owner).order_by(ImageToken.created_at)
    ).all()
    return [token_view(row) for row in rows]


def create_token(session: Session, owner: str, name: str) -> dict:
    count = session.exec(
        select(func.count()).select_from(ImageToken).where(ImageToken.owner == owner)
    ).one()
    if count >= TOKEN_LIMIT:
        raise HTTPException(409, f"最多创建 {TOKEN_LIMIT} 个令牌，请先撤销不用的")
    token = "cpl_" + secrets.token_urlsafe(32)
    row = ImageToken(id=secrets.token_hex(8), token_hash=digest(token), owner=owner,
                     name=name.strip() or "未命名", created_at=timestamp())
    session.add(row)
    session.commit()
    return {**token_view(row), "token": token}


def revoke_token(session: Session, owner: str, token_id: str):
    row = session.get(ImageToken, token_id)
    if row is None or row.owner != owner:
        raise HTTPException(404, "令牌不存在")
    session.delete(row)
    session.commit()


def token_owner(request: Request, session: Session) -> str:
    """Authorization: Bearer <令牌> 鉴权；失败按 IP 限流，防止暴力猜测。"""
    key = f"image-token:{digest(client_ip(request))}"
    throttle(session, key, 20, "令牌验证失败次数过多，请 15 分钟后再试")
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    row = None
    if scheme.lower() == "bearer" and token.strip():
        row = session.exec(
            select(ImageToken).where(ImageToken.token_hash == digest(token.strip()))
        ).first()
    if row is not None and row.owner != ADMIN:
        user = session.get(User, row.owner)
        if user is None or user.disabled:
            row = None
    if row is None:
        record_failure(session, key)
        raise HTTPException(401, "上传令牌无效或已撤销",
                            headers={"WWW-Authenticate": "Bearer"})
    row.last_used = timestamp()
    session.add(row)
    session.commit()
    return row.owner


# —— 导出 ——


class _Sink:
    """只追加的输出缓冲；zipfile 写入不可定位的流时使用数据描述符，可以边写边发送。"""

    def __init__(self):
        self.parts: list[bytes] = []

    def write(self, data) -> int:
        self.parts.append(bytes(data))
        return len(data)

    def flush(self):
        pass

    def take(self) -> bytes:
        data, self.parts = b"".join(self.parts), []
        return data


def manifest(settings, rows: list[HostedImage]) -> dict:
    return {"format": 1, "base": settings.image_base, "images": [
        {"id": row.id, "path": row.path, "url": url(settings, row.path), "size": row.size,
         "sha256": row.sha256, "created_at": row.created_at} for row in rows
    ]}


def export_stream(settings, rows: list[HostedImage]):
    """逐张写入 zip 并立即发送；目录结构与公开地址一致，附带 manifest.json。"""
    sink = _Sink()
    present = []
    with zipfile.ZipFile(sink, "w", zipfile.ZIP_STORED) as archive:
        for row in rows:
            source = settings.images_dir / row.path
            if not source.is_file() or source.is_symlink():
                continue
            archive.write(source, row.path)
            present.append(row)
            yield sink.take()
        archive.writestr("manifest.json", json.dumps(manifest(settings, present), indent=2,
                                                     ensure_ascii=False))
    yield sink.take()


# —— 旧 /media 图片迁移 ——


def migrate_media(session: Session, settings, apply: bool = False) -> dict:
    """把文章与手写笔记引用的 /media 图片导入图床并改写地址；重复执行不会产生变化。

    GitHub 同步的笔记不迁移：下次同步会以仓库内容覆盖，图片继续保存在 media/notes。
    """
    pattern = re.compile(f"(?:{re.escape(settings.site_url)})?{MEDIA_NAME}")
    articles = session.exec(select(Article)).all()
    notes = session.exec(select(Note).where(Note.source == "manual")).all()
    texts = [json.dumps([a.draft, a.published], ensure_ascii=False) for a in articles]
    texts += [note.markdown + note.html for note in notes]
    names = sorted({name for text in texts for name in pattern.findall(text)})
    missing = [name for name in names if not (settings.media_dir / name).is_file()]
    mapping: dict[str, str] = {}
    imported = 0
    for name in names:
        if name in missing:
            continue
        if not apply:
            mapping[name] = ""
            continue
        source = settings.media_dir / name
        modified = datetime.fromtimestamp(source.stat().st_mtime, timezone.utc)
        row, created = store(session, settings, ADMIN, source.read_bytes(), modified)
        imported += created
        mapping[name] = url(settings, row.path)

    def rewrite(text: str) -> str:
        return pattern.sub(lambda m: mapping.get(m.group(1)) or m.group(0), text)

    changed_articles = changed_notes = 0
    for article in articles:
        refs = set(pattern.findall(json.dumps([article.draft, article.published])))
        if not refs & mapping.keys():
            continue
        changed_articles += 1
        if apply:
            article.draft = json.loads(rewrite(json.dumps(article.draft, ensure_ascii=False)))
            if article.published is not None:
                article.published = json.loads(
                    rewrite(json.dumps(article.published, ensure_ascii=False))
                )
            article.revision += 1
            session.add(article)
    for note in notes:
        if not set(pattern.findall(note.markdown + note.html)) & mapping.keys():
            continue
        changed_notes += 1
        if apply:
            note.markdown, note.html = rewrite(note.markdown), rewrite(note.html)
            note.revision += 1
            session.add(note)
    if apply and (changed_articles or changed_notes):
        bump(session, "posts")
        bump_notes(session)
    session.commit()
    return {"images": len(mapping), "imported": imported, "missing": missing,
            "articles": changed_articles, "notes": changed_notes, "applied": apply}

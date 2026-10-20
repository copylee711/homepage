"""笔记：从 GitHub 仓库同步 Markdown，或在后台直接编写。

同步先用一次 API 请求读取分支最新提交；提交未变化时不下载。变化后从 codeload
下载整个仓库的 tar 包（服务器访问 raw.githubusercontent.com 不稳定），解析 Markdown
与被引用的图片。图片保存到 media/notes，正文中的相对链接改写为站内地址。
"""

import asyncio
import fnmatch
import hashlib
import io
import logging
import posixpath
import re
import tarfile
import uuid
from urllib.parse import unquote

import httpx
from fastapi import HTTPException
from sqlalchemy import update
from sqlmodel import Session, select

from .content import require_content, timestamp
from .models import Content, Note
from .rendering import render_markdown

logger = logging.getLogger(__name__)

MAX_ARCHIVE_BYTES = 80 * 1024 * 1024
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_NOTE_BYTES = 500_000
# SVG 可携带脚本，直接访问时会在本站执行，因此不导入。
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
HTML_IMG = re.compile(r"<img\b([^>]*?)/?>(?:\s*</img>)?", re.I)
LINK = re.compile(r'(!?)\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?((?:\s+"[^"\n]*")?)\s*\)')
TOC_MARKER = re.compile(r"^[ \t]*\[toc\][ \t]*$\n?", re.I | re.M)
SYNC_INTERVAL = 1800


# —— 解析 ——


def slugify(path: str) -> str:
    stem = path[:-3] if path.lower().endswith(".md") else path
    return re.sub(r"[^a-z0-9一-鿿]+", "-", stem.lower()).strip("-") or "note"


def is_excluded(path: str, patterns: list[str]) -> bool:
    parts = path.split("/")
    return any(
        fnmatch.fnmatch(path, pattern) or any(fnmatch.fnmatch(part, pattern) for part in parts)
        for pattern in patterns
    )


def title_of(markdown: str, fallback: str) -> str:
    match = re.search(r"^#\s+(.+?)\s*#*\s*$", markdown, re.M)
    return (match.group(1).strip() if match else fallback)[:200]


def summary_of(markdown: str) -> str:
    text = re.sub(r"```.*?```|\$\$.*?\$\$", " ", markdown, flags=re.S)
    for block in re.split(r"\n\s*\n", text):
        block = block.strip()
        if not block or block.startswith(("#", "|", ">", "-", "*", "!", "<", "$", "```")):
            continue
        block = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", block)
        block = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", block)
        block = re.sub(r"[`*_~$=]", "", block)
        block = re.sub(r"\s+", " ", block).strip()
        if len(block) >= 8:
            return block[:140] + ("…" if len(block) > 140 else "")
    return ""


def html_images(markdown: str) -> str:
    """把 <img src="…"> 转成 Markdown 图片，便于统一改写仓库内的相对路径。"""

    def replace(match: re.Match) -> str:
        attributes = dict(re.findall(r"""(\w+)\s*=\s*["']([^"']*)["']""", match.group(1)))
        if not attributes.get("src"):
            return match.group(0)
        return f"![{attributes.get('alt', '')}]({attributes['src'].replace(' ', '%20')})"

    return HTML_IMG.sub(replace, markdown)


def rewrite_links(markdown: str, note_path: str, images: dict, notes: dict) -> str:
    """把仓库内的相对图片和 .md 链接改写为站内地址；外链与锚点保持不变。"""
    base = posixpath.dirname(note_path)

    def replace(match: re.Match) -> str:
        bang, text, target, title = match.groups()
        if re.match(r"^[a-z][a-z0-9+.-]*:|^#|^/", target, re.I):
            return match.group(0)
        raw, _, fragment = target.partition("#")
        resolved = posixpath.normpath(posixpath.join(base, unquote(raw)))
        if bang and resolved in images:
            return f"![{text}]({images[resolved]}{title})"
        if not bang and resolved in notes:
            anchor = f"#{fragment}" if fragment else ""
            return f"[{text}](/notes/{notes[resolved]}{anchor}{title})"
        return match.group(0)

    return LINK.sub(replace, markdown)


def read_archive(data: bytes, patterns: list[str]) -> tuple[dict[str, str], dict[str, bytes]]:
    notes, images = {}, {}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive:
            if not member.isfile():
                continue
            # 去掉 codeload 包的顶层目录 owner-repo-sha/
            path = member.name.split("/", 1)[1] if "/" in member.name else ""
            if not path or is_excluded(path, patterns):
                continue
            extension = posixpath.splitext(path)[1].lower()
            if extension == ".md" and member.size <= MAX_NOTE_BYTES:
                content = archive.extractfile(member).read().decode("utf-8", "replace")
                # Typora 的 [toc] 标记由页面目录代替。
                content = TOC_MARKER.sub("", content.lstrip("\ufeff"))
                notes[path] = html_images(content)
            elif extension in IMAGE_EXTENSIONS and member.size <= MAX_IMAGE_BYTES:
                images[path] = archive.extractfile(member).read()
    return notes, images


def referenced_images(notes: dict[str, str]) -> set[str]:
    found = set()
    for path, markdown in notes.items():
        base = posixpath.dirname(path)
        for bang, _, target, _ in LINK.findall(markdown):
            if bang and not re.match(r"^[a-z][a-z0-9+.-]*:|^/", target, re.I):
                raw = unquote(target.partition("#")[0])
                found.add(posixpath.normpath(posixpath.join(base, raw)))
    return found


# —— 同步 ——


async def fetch_archive(repo: str, branch: str, last: str, token: str, transport=None):
    headers = {"User-Agent": "copylee-homepage"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    async with httpx.AsyncClient(
        timeout=60, headers=headers, transport=transport, follow_redirects=True
    ) as client:
        response = await client.get(
            f"https://api.github.com/repos/{repo}/commits/{branch}",
            headers={"Accept": "application/vnd.github.sha"},
        )
        response.raise_for_status()
        commit = response.text.strip()
        if not re.fullmatch(r"[0-9a-f]{40}", commit):
            raise ValueError("GitHub 返回的提交无效")
        if commit == last:
            return commit, None
        chunks, size = [], 0
        async with client.stream("GET", f"https://codeload.github.com/{repo}/tar.gz/{commit}") as r:
            r.raise_for_status()
            async for chunk in r.aiter_bytes():
                size += len(chunk)
                if size > MAX_ARCHIVE_BYTES:
                    raise ValueError("笔记仓库超过 80 MiB 上限")
                chunks.append(chunk)
        return commit, b"".join(chunks)


def store_images(images: dict[str, bytes], needed: set[str], media_dir) -> dict[str, str]:
    folder = media_dir / "notes"
    folder.mkdir(parents=True, exist_ok=True)
    urls = {}
    for path in needed & images.keys():
        data = images[path]
        extension = posixpath.splitext(path)[1].lower().replace(".jpeg", ".jpg")
        name = hashlib.sha256(data).hexdigest()[:40] + extension
        target = folder / name
        if not target.exists():
            temporary = folder / f".{name}.tmp"
            temporary.write_bytes(data)
            temporary.replace(target)
            target.chmod(0o644)
        urls[path] = f"/media/notes/{name}"
    return urls


def unique_slug(session: Session, wanted: str, taken: set[str]) -> str:
    slug, n = wanted[:110], 2
    while slug in taken or session.exec(select(Note.id).where(Note.slug == slug)).first():
        slug, n = f"{wanted[:105]}-{n}", n + 1
    taken.add(slug)
    return slug


def apply_sync(session: Session, files: dict[str, str], image_urls: dict, auto: bool) -> int:
    """写入仓库笔记，返回变化数量。已有笔记保留地址与显示状态。"""
    existing = {n.path: n for n in session.exec(select(Note).where(Note.source == "github"))}
    taken: set[str] = set()
    slugs = {}
    for path in sorted(files):
        slugs[path] = existing[path].slug if path in existing else unique_slug(
            session, slugify(path), taken
        )
    changed, now = 0, timestamp()
    for path, raw in files.items():
        markdown = rewrite_links(raw, path, image_urls, slugs)
        sha = hashlib.sha256(markdown.encode()).hexdigest()
        name = posixpath.splitext(posixpath.basename(path))[0]
        values = {
            "title": title_of(markdown, name),
            "summary": summary_of(markdown),
            "category": posixpath.dirname(path),
            "markdown": markdown,
            "html": render_markdown(markdown),
            "sha": sha,
        }
        note = existing.get(path)
        if note is None:
            # 以 draft 开头的文件默认不公开，可在后台手动显示。
            visible = auto and not name.lower().startswith("draft")
            session.add(Note(id=uuid.uuid4().hex, slug=slugs[path], source="github", path=path,
                             visible=visible, created_at=now, updated_at=now, **values))
            changed += 1
        elif note.sha != sha:
            for key, value in values.items():
                setattr(note, key, value)
            note.updated_at, note.revision = now, note.revision + 1
            session.add(note)
            changed += 1
    for path, note in existing.items():
        if path not in files:
            session.delete(note)
            changed += 1
    return changed


def update_config(session: Session, **values):
    row = require_content(session, "notes")
    session.exec(
        update(Content).where(Content.key == "notes").values(value={**row.value, **values})
    )


def bump_notes(session: Session):
    session.exec(
        update(Content).where(Content.key == "notes").values(revision=Content.revision + 1)
    )


async def sync_notes(app, force: bool = False, transport=None) -> dict:
    settings = app.state.settings
    async with app.state.notes_lock:
        with Session(app.state.engine) as session:
            config = dict(require_content(session, "notes").value)
        if not config.get("repo"):
            return {"ok": False, "error": "尚未配置笔记仓库", "changed": 0}
        try:
            commit, data = await fetch_archive(
                config["repo"], config["branch"], "" if force else config.get("last_commit", ""),
                settings.github_token, transport,
            )
            files, images = ({}, {}) if data is None else await asyncio.to_thread(
                read_archive, data, config.get("exclude", [])
            )
            error = ""
        except (httpx.HTTPError, ValueError, tarfile.TarError) as exc:
            error = f"笔记同步失败：{type(exc).__name__}"
            if isinstance(exc, httpx.HTTPStatusError):
                error += f" (HTTP {exc.response.status_code})"
            elif isinstance(exc, ValueError):
                error = f"笔记同步失败：{exc}"
            logger.warning(error)
            data = None
        with Session(app.state.engine) as session:
            session.connection().exec_driver_sql("BEGIN IMMEDIATE")
            changed = 0
            if not error and data is not None:
                urls = await asyncio.to_thread(
                    store_images, images, referenced_images(files), settings.media_dir
                )
                changed = apply_sync(session, files, urls, config.get("autoPublish", True))
            values = {"last_error": error}
            if not error:
                values.update(last_commit=commit, last_success=timestamp())
            update_config(session, **values)
            if changed:
                bump_notes(session)
            session.commit()
        return {"ok": not error, "error": error, "changed": changed}


async def sync_loop(app):
    while True:
        try:
            await sync_notes(app)
        except Exception:
            logger.exception("笔记同步任务失败")
        await asyncio.sleep(SYNC_INTERVAL)


# —— 读写 ——


def summary(note: Note) -> dict:
    return {
        "slug": note.slug,
        "title": note.title,
        "summary": note.summary,
        "category": note.category,
        "updated_at": note.updated_at,
    }


def public_notes(session: Session) -> list[dict]:
    rows = session.exec(select(Note).where(Note.visible)).all()
    return [summary(n) for n in sorted(rows, key=lambda n: (n.category, n.title.lower()))]


def public_note(session: Session, slug: str) -> Note:
    note = session.exec(select(Note).where(Note.slug == slug, Note.visible)).first()
    if note is None:
        raise HTTPException(404, "笔记不存在或未公开")
    return note


def admin_view(note: Note, full: bool = False) -> dict:
    data = {
        **summary(note), "id": note.id, "source": note.source, "path": note.path,
        "visible": note.visible, "revision": note.revision,
    }
    if full:
        data["markdown"] = note.markdown
    return data


def get_note(session: Session, note_id: str) -> Note:
    note = session.get(Note, note_id)
    if note is None:
        raise HTTPException(404, "笔记不存在")
    return note


def save_manual(session: Session, note: Note | None, body) -> Note:
    taken = session.exec(select(Note.id).where(Note.slug == body.slug)).first()
    if taken and (note is None or taken != note.id):
        raise HTTPException(409, "这个地址已被其他笔记使用")
    now = timestamp()
    values = {
        "title": body.title, "slug": body.slug, "category": body.category.strip(),
        "summary": body.summary or summary_of(body.markdown), "markdown": body.markdown,
        "html": render_markdown(body.markdown), "visible": body.visible,
    }
    if note is None:
        note = Note(id=uuid.uuid4().hex, source="manual", created_at=now, updated_at=now, **values)
    else:
        if note.source != "manual":
            raise HTTPException(409, "仓库笔记以 GitHub 内容为准，只能切换显示状态")
        if note.revision != body.revision:
            raise HTTPException(409, "笔记已被其他窗口修改，请重新加载")
        for key, value in values.items():
            setattr(note, key, value)
        note.updated_at, note.revision = now, note.revision + 1
    session.add(note)
    bump_notes(session)
    session.commit()
    session.refresh(note)
    return note

import asyncio
import json
import re
import secrets
import warnings
from contextlib import asynccontextmanager, suppress
from io import BytesIO
from pathlib import Path
from xml.etree.ElementTree import Element, SubElement, tostring

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.exception_handlers import http_exception_handler
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from PIL import Image, UnidentifiedImageError
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlmodel import Session, select
from starlette.exceptions import HTTPException as StarletteHTTPException

from .auth import COOKIE, authenticate, current_session
from .content import (
    adjacent_posts,
    bump,
    get_article,
    public_article,
    public_site,
    published_posts,
    reading_stats,
    require_content,
    save_site,
    summaries,
    timestamp,
    update_article,
    versions,
)
from .database import make_engine
from .feed import atom_feed
from .github import sync_loop, sync_repos
from .limits import JsonBodyLimit
from .models import Administrator, Article, Note, Passkey
from .notes import (
    admin_view,
    bump_notes,
    get_note,
    public_note,
    public_notes,
    save_manual,
    sync_notes,
    update_config,
)
from .notes import sync_loop as notes_sync_loop
from .rendering import render_markdown
from .schemas import (
    ArticleDraft,
    ArticleWrite,
    Login,
    NotesConfig,
    NoteVisibility,
    NoteWrite,
    PasskeyResponse,
    PasskeySetup,
    Preview,
    Revision,
    SecurityProof,
    SiteWrite,
)
from .scut import public_scut
from .scut import sync_loop as scut_sync_loop
from .security import (
    factor_action,
    passkey_options,
    passkey_verify,
    remove_passkey,
    unlock,
)
from .settings import Settings

HERE = Path(__file__).parent
MAX_IMAGE_BYTES = 10 * 1024 * 1024
PLAIN_404_PREFIXES = ("/api/", "/media/", "/content-assets/", "/assets/")
Image.MAX_IMAGE_PIXELS = 20_000_000


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    engine = make_engine(settings)

    @asynccontextmanager
    async def lifespan(app):
        task = asyncio.create_task(sync_loop(app)) if settings.sync_enabled else None
        scut_task = asyncio.create_task(scut_sync_loop(app)) if settings.scut_sync_enabled else None
        notes_task = asyncio.create_task(notes_sync_loop(app)) if settings.sync_enabled else None
        yield
        for pending in (task, scut_task, notes_task):
            if not pending:
                continue
            pending.cancel()
            with suppress(asyncio.CancelledError):
                await pending
        engine.dispose()

    app = FastAPI(
        title="Copy Lee 内容服务",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.settings = settings
    app.add_middleware(JsonBodyLimit)
    app.state.engine = engine
    app.state.sync_lock = asyncio.Lock()
    app.state.scut_lock = asyncio.Lock()
    app.state.notes_lock = asyncio.Lock()
    templates = Jinja2Templates(directory=HERE / "templates")
    templates.env.globals["social_icons"] = json.loads(
        (HERE / "static/social-icons.json").read_text(encoding="utf-8")
    )["icons"]

    def database(request: Request):
        with Session(request.app.state.engine) as session:
            yield session

    def authorized(request: Request, session: Session = Depends(database)):
        current_session(request, session, request.method not in {"GET", "HEAD", "OPTIONS"})
        return session

    @app.middleware("http")
    async def headers(request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        if request.url.path.startswith(("/api/", "/admin")):
            response.headers["Cache-Control"] = "no-store"
        elif request.url.path.startswith(("/posts", "/notes", "/sitemap", "/robots", "/feed", "/content-assets/")):
            response.headers["Cache-Control"] = "no-cache"
        return response

    @app.exception_handler(IntegrityError)
    async def duplicate(_, exc):
        return JSONResponse({"detail": "固定链接已存在，请换一个地址"}, status_code=409)

    @app.exception_handler(OperationalError)
    async def busy(_, exc):
        return JSONResponse({"detail": "数据库暂时不可用，请稍后重试"}, status_code=503)

    @app.exception_handler(StarletteHTTPException)
    async def not_found(request: Request, exc: StarletteHTTPException):
        # 页面请求的 404 返回与站点一致的页面；API 与静态资源保持 JSON/空响应。
        if exc.status_code != 404 or request.url.path.startswith(PLAIN_404_PREFIXES):
            return await http_exception_handler(request, exc)
        try:
            with Session(engine) as session:
                context = page_context(
                    session, request.url.path, "页面不存在", "这个页面不存在或已经移走"
                )
        except HTTPException:
            return await http_exception_handler(request, exc)
        context.update(heading="这个页面走丢了。", detail="地址可能有误，或内容已经移走。", nav_active="")
        return templates.TemplateResponse(
            request=request, name="404.html", context=context, status_code=404
        )

    @app.get("/api/health")
    def health(session: Session = Depends(database)):
        versions(session)
        return {"ok": True}

    @app.get("/api/scut")
    def scut(session: Session = Depends(database)):
        return {**public_scut(session), "sync_enabled": settings.scut_sync_enabled}

    @app.get("/api/site")
    def site(session: Session = Depends(database)):
        return {"site": public_site(session), "revision": require_content(session, "site").revision}

    @app.get("/api/repos")
    def repos(session: Session = Depends(database)):
        row = require_content(session, "repos")
        return {"items": row.value["items"], "revision": row.revision}

    @app.get("/api/notes")
    def notes(session: Session = Depends(database)):
        row = require_content(session, "notes")
        return {"items": public_notes(session), "revision": row.revision}

    @app.get("/api/version")
    def version(session: Session = Depends(database)):
        return versions(session)

    @app.get("/api/posts")
    def posts(session: Session = Depends(database)):
        return {"items": summaries(session), "revision": require_content(session, "posts").revision}

    @app.get("/api/posts/{slug}")
    def post(slug: str, session: Session = Depends(database)):
        return public_article(session, slug)

    @app.post("/api/auth/login")
    def login(
        body: Login, request: Request, response: Response, session: Session = Depends(database)
    ):
        token, row = authenticate(request, session, body)
        response.set_cookie(
            COOKIE,
            token,
            max_age=settings.session_hours * 3600,
            httponly=True,
            secure=settings.secure_cookie,
            samesite="lax",
            path="/api",
        )
        return {"csrf": row.csrf}

    @app.get("/api/auth/me")
    def me(request: Request, session: Session = Depends(database)):
        return {"csrf": current_session(request, session).csrf}

    @app.post("/api/auth/passkey/options")
    def key_login_options(request: Request, response: Response, session: Session = Depends(database)):
        return passkey_options(request, response, session)

    @app.post("/api/auth/passkey/verify")
    def key_login(body: PasskeyResponse, request: Request, response: Response,
                  session: Session = Depends(database)):
        token, row = passkey_verify(request, session, body)
        response.set_cookie(COOKIE, token, max_age=settings.session_hours * 3600,
                            httponly=True, secure=settings.secure_cookie, samesite="lax", path="/api")
        response.delete_cookie("copylee_challenge", path="/api")
        return {"csrf": row.csrf}

    @app.get("/api/admin/security")
    def security_state(request: Request, session: Session = Depends(authorized)):
        admin = session.get(Administrator, 1)
        return {"elevated_until": current_session(request, session).elevated_until,
                "totp_enabled": bool(admin.totp_secret),
                "recovery_remaining": len(admin.recovery_hashes),
                "passkeys": [{"id": key.id, "name": key.name, "created_at": key.created_at,
                              "last_used": key.last_used} for key in session.exec(select(Passkey)).all()]}

    @app.post("/api/admin/security/unlock")
    def security_unlock(body: SecurityProof, request: Request,
                        session: Session = Depends(authorized)):
        return unlock(request, session, body)

    @app.post("/api/admin/security/unlock/passkey/options")
    def security_unlock_options(request: Request, response: Response,
                                session: Session = Depends(authorized)):
        return passkey_options(request, response, session, step_up=True)

    @app.post("/api/admin/security/unlock/passkey/verify")
    def security_unlock_verify(body: PasskeyResponse, request: Request,
                               session: Session = Depends(authorized)):
        return passkey_verify(request, session, body, step_up=True)

    @app.post("/api/admin/security/2fa/{operation}")
    def factor_change(operation: str, body: SecurityProof, request: Request,
                      session: Session = Depends(authorized)):
        return factor_action(request, session, body, operation)

    @app.post("/api/admin/security/passkeys/options")
    def key_setup(body: PasskeySetup, request: Request, response: Response,
                  session: Session = Depends(authorized)):
        return passkey_options(request, response, session, body)

    @app.post("/api/admin/security/passkeys/verify")
    def key_register(body: PasskeyResponse, request: Request, session: Session = Depends(authorized)):
        return passkey_verify(request, session, body, register=True)

    @app.post("/api/admin/security/passkeys/{key_id}/remove")
    def key_remove(key_id: str, body: SecurityProof, request: Request,
                   session: Session = Depends(authorized)):
        return remove_passkey(request, session, key_id, body)

    @app.post("/api/auth/logout")
    def logout(request: Request, response: Response, session: Session = Depends(database)):
        row = current_session(request, session, write=True)
        session.delete(row)
        session.commit()
        response.delete_cookie(COOKIE, path="/api")
        return {"ok": True}

    @app.get("/api/admin/site")
    def admin_site(session: Session = Depends(authorized)):
        row = require_content(session, "site")
        return {"site": row.value, "revision": row.revision}

    @app.put("/api/admin/site")
    def admin_save_site(body: SiteWrite, session: Session = Depends(authorized)):
        save_site(session, body.site.model_dump(), body.revision)
        return {"revision": body.revision + 1}

    @app.get("/api/admin/repos")
    def admin_repos(session: Session = Depends(authorized)):
        return require_content(session, "repos").value

    @app.post("/api/admin/repos/sync")
    async def admin_sync(request: Request, session: Session = Depends(authorized)):
        return await sync_repos(request.app)

    @app.get("/api/admin/posts")
    def admin_posts(session: Session = Depends(authorized)):
        rows = session.exec(select(Article).order_by(Article.updated_at.desc())).all()
        return [
            {
                "id": row.id,
                "title": row.draft["title"],
                "slug": row.slug,
                "revision": row.revision,
                "published": row.published is not None,
                "updated_at": row.updated_at,
            }
            for row in rows
        ]

    @app.post("/api/admin/posts", status_code=201)
    def create_post(body: ArticleDraft, session: Session = Depends(authorized)):
        now = timestamp()
        row = Article(
            id=secrets.token_hex(16),
            slug=body.slug,
            draft=body.model_dump(),
            created_at=now,
            updated_at=now,
        )
        session.add(row)
        session.commit()
        session.refresh(row)
        return row

    @app.get("/api/admin/posts/{article_id}")
    def admin_post(article_id: str, session: Session = Depends(authorized)):
        return get_article(session, article_id)

    @app.put("/api/admin/posts/{article_id}")
    def save_draft(article_id: str, body: ArticleWrite, session: Session = Depends(authorized)):
        row = get_article(session, article_id)
        if row.slug_locked and body.draft.slug != row.slug:
            raise HTTPException(422, "首次发布后固定链接不能修改")
        update_article(
            session, row, body.revision, draft=body.draft.model_dump(), slug=body.draft.slug
        )
        session.commit()
        return {"revision": body.revision + 1}

    @app.post("/api/admin/posts/{article_id}/publish")
    def publish(article_id: str, body: Revision, session: Session = Depends(authorized)):
        row = get_article(session, article_id)
        now = timestamp()
        snapshot = {
            **row.draft,
            "html": render_markdown(row.draft["markdown"]),
            "published_at": row.published["published_at"] if row.published else now,
            "updated_at": now,
            "public_revision": body.revision + 1,
        }
        update_article(session, row, body.revision, published=snapshot, slug_locked=True)
        bump(session, "posts")
        session.commit()
        return {"revision": body.revision + 1}

    @app.post("/api/admin/posts/{article_id}/unpublish")
    def unpublish(article_id: str, body: Revision, session: Session = Depends(authorized)):
        row = get_article(session, article_id)
        update_article(session, row, body.revision, published=None)
        bump(session, "posts")
        session.commit()
        return {"revision": body.revision + 1}

    @app.get("/api/admin/notes")
    def admin_notes(session: Session = Depends(authorized)):
        rows = session.exec(select(Note)).all()
        items = sorted(rows, key=lambda n: (n.source, n.category, n.title.lower()))
        config = require_content(session, "notes").value
        return {"items": [admin_view(n) for n in items], "config": config}

    @app.put("/api/admin/notes/config")
    def admin_notes_config(body: NotesConfig, session: Session = Depends(authorized)):
        previous = require_content(session, "notes").value
        changed = (body.repo, body.branch, body.exclude) != (
            previous.get("repo"), previous.get("branch"), previous.get("exclude")
        )
        # 仓库、分支或排除规则变化后，下一次同步重新下载完整内容。
        update_config(session, **body.model_dump(), **({"last_commit": ""} if changed else {}))
        session.commit()
        return require_content(session, "notes").value

    @app.post("/api/admin/notes/sync")
    async def admin_notes_sync(request: Request, session: Session = Depends(authorized)):
        return await sync_notes(request.app, force=True)

    @app.post("/api/admin/notes", status_code=201)
    def create_note(body: NoteWrite, session: Session = Depends(authorized)):
        return admin_view(save_manual(session, None, body), full=True)

    @app.get("/api/admin/notes/{note_id}")
    def admin_note(note_id: str, session: Session = Depends(authorized)):
        return admin_view(get_note(session, note_id), full=True)

    @app.put("/api/admin/notes/{note_id}")
    def save_note(note_id: str, body: NoteWrite, session: Session = Depends(authorized)):
        return admin_view(save_manual(session, get_note(session, note_id), body), full=True)

    @app.post("/api/admin/notes/{note_id}/visibility")
    def note_visibility(
        note_id: str, body: NoteVisibility, session: Session = Depends(authorized)
    ):
        note = get_note(session, note_id)
        if note.revision != body.revision:
            raise HTTPException(409, "笔记已被修改，请重新加载")
        note.visible, note.revision = body.visible, note.revision + 1
        session.add(note)
        bump_notes(session)
        session.commit()
        return admin_view(note)

    @app.post("/api/admin/notes/{note_id}/remove")
    def remove_note(note_id: str, body: Revision, session: Session = Depends(authorized)):
        note = get_note(session, note_id)
        if note.source != "manual":
            raise HTTPException(409, "仓库笔记请在 GitHub 删除，或在这里隐藏")
        if note.revision != body.revision:
            raise HTTPException(409, "笔记已被修改，请重新加载")
        session.delete(note)
        bump_notes(session)
        session.commit()
        return {"ok": True}

    @app.post("/api/admin/preview")
    def preview(body: Preview, session: Session = Depends(authorized)):
        return {"html": render_markdown(body.markdown)}

    @app.post("/api/admin/media", status_code=201)
    async def upload(request: Request, session: Session = Depends(authorized)):
        # 原始文件流代替 multipart；读取上限在解码图片之前执行。
        chunks, size = [], 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > MAX_IMAGE_BYTES:
                raise HTTPException(413, "图片不能超过 10 MiB")
            chunks.append(chunk)
        payload = b"".join(chunks)
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(BytesIO(payload)) as image:
                    extension = {"JPEG": "jpg", "PNG": "png", "WEBP": "webp", "GIF": "gif"}.get(
                        image.format
                    )
                    if not extension:
                        raise HTTPException(415, "仅支持 JPEG、PNG、WebP、GIF")
                    image.verify()
        except (
            UnidentifiedImageError,
            OSError,
            ValueError,
            Image.DecompressionBombError,
            Image.DecompressionBombWarning,
        ):
            raise HTTPException(415, "图片损坏或像素尺寸过大") from None
        name = f"{secrets.token_hex(24)}.{extension}"
        temporary = settings.media_dir / f".{name}.tmp"
        temporary.write_bytes(payload)
        temporary.replace(settings.media_dir / name)
        (settings.media_dir / name).chmod(0o644)
        return {"url": f"/media/{name}"}

    def page_context(session, path, title, description):
        site = public_site(session)
        return {
            "site": site,
            "title": title,
            "description": description,
            "canonical": settings.site_url + path,
            "version": versions(session),
            "css_urls": css_urls(settings.static_dir),
            "math_assets": math_assets(settings.static_dir),
            "year": timestamp()[:4],
        }

    @app.get("/posts", response_class=HTMLResponse)
    def article_list(request: Request, session: Session = Depends(database)):
        context = page_context(session, "/posts", "Articles", "文章与记录")
        context.update(posts=summaries(session), article=None)
        return templates.TemplateResponse(request=request, name="posts.html", context=context)

    @app.get("/posts/{slug}", response_class=HTMLResponse)
    def article_page(slug: str, request: Request, session: Session = Depends(database)):
        try:
            article = public_article(session, slug)
        except HTTPException as exc:
            if exc.status_code != 404:
                raise
            context = page_context(session, f"/posts/{slug}", "文章不存在", "文章不存在或已撤下")
            context.update(heading="这篇文章暂时不在这里。", detail="文章不存在或已撤下。")
            return templates.TemplateResponse(
                request=request, name="404.html", context=context, status_code=404
            )
        context = page_context(session, f"/posts/{slug}", article["title"], article["summary"])
        cover = article["cover"]
        cover_absolute = settings.site_url + cover if cover.startswith("/") else cover
        newer, older = adjacent_posts(session, slug)
        context.update(
            article=article,
            reading=reading_stats(article["markdown"]),
            math='class="math' in article["html"],
            newer=newer,
            older=older,
            cover_absolute=cover_absolute,
            structured={
                "@context": "https://schema.org",
                "@type": "BlogPosting",
                "headline": article["title"],
                "description": article["summary"],
                "datePublished": article["published_at"],
                "dateModified": article["updated_at"],
                "author": {"@type": "Person", "name": context["site"]["name"]},
                "mainEntityOfPage": context["canonical"],
                **({"image": cover_absolute} if cover else {}),
            },
        )
        return templates.TemplateResponse(request=request, name="article.html", context=context)

    @app.get("/notes", response_class=HTMLResponse)
    def note_list(request: Request, session: Session = Depends(database)):
        context = page_context(session, "/notes", "Notes", "学习过程中留下的 Markdown 笔记")
        items = public_notes(session)
        groups: dict[str, list] = {}
        for item in items:
            groups.setdefault(item["category"] or "General", []).append(item)
        context.update(notes=items, groups=groups, nav_active="notes")
        return templates.TemplateResponse(request=request, name="notes.html", context=context)

    @app.get("/notes/{slug}", response_class=HTMLResponse)
    def note_page(slug: str, request: Request, session: Session = Depends(database)):
        try:
            note = public_note(session, slug)
        except HTTPException:
            context = page_context(session, f"/notes/{slug}", "笔记不存在", "笔记不存在或未公开")
            context.update(
                heading="这篇笔记暂时不在这里。", detail="笔记不存在或未公开。", nav_active="notes"
            )
            return templates.TemplateResponse(
                request=request, name="404.html", context=context, status_code=404
            )
        context = page_context(session, f"/notes/{slug}", note.title, note.summary or note.title)
        siblings = [n for n in public_notes(session) if n["category"] == note.category]
        index = next(i for i, n in enumerate(siblings) if n["slug"] == slug)
        context.update(
            note=note,
            # 页面标题已显示笔记名，去掉正文开头重复的一级标题。
            body=re.sub(r"^\s*<h1>.*?</h1>\s*", "", note.html, count=1, flags=re.S),
            nav_active="notes",
            reading=reading_stats(note.markdown),
            prev_note=siblings[index - 1] if index > 0 else None,
            next_note=siblings[index + 1] if index + 1 < len(siblings) else None,
            math='class="math' in note.html,
        )
        return templates.TemplateResponse(request=request, name="note.html", context=context)

    @app.get("/sitemap.xml")
    def sitemap(session: Session = Depends(database)):
        root = Element("urlset", xmlns="http://www.sitemaps.org/schemas/sitemap/0.9")
        for path, modified in [("/", None), ("/scut", None), ("/posts", None)] + [
            (f"/posts/{p['slug']}", p["updated_at"]) for p in published_posts(session)
        ] + [("/notes", None)] + [
            (f"/notes/{n['slug']}", n["updated_at"]) for n in public_notes(session)
        ]:
            entry = SubElement(root, "url")
            SubElement(entry, "loc").text = settings.site_url + path
            if modified:
                SubElement(entry, "lastmod").text = modified
        return Response(
            tostring(root, encoding="utf-8", xml_declaration=True), media_type="application/xml"
        )

    @app.get("/feed.xml")
    def feed(session: Session = Depends(database)):
        body = atom_feed(public_site(session), published_posts(session)[:20], settings.site_url)
        return Response(body, media_type="application/atom+xml; charset=utf-8")

    @app.get("/robots.txt", response_class=PlainTextResponse)
    def robots():
        return f"User-agent: *\nDisallow: /admin\nDisallow: /api/\nSitemap: {settings.site_url}/sitemap.xml\n"

    # 开发/SSH 隧道时直连后端也能查看完整站点；生产静态资源由 Caddy 服务。
    app.mount("/media", StaticFiles(directory=settings.media_dir), name="media")
    app.mount("/content-assets", StaticFiles(directory=HERE / "static"), name="content-assets")
    @app.get("/favicon.svg", include_in_schema=False)
    def favicon():
        icon = settings.static_dir / "favicon.svg"
        if not icon.is_file():
            raise HTTPException(404)
        return FileResponse(icon, media_type="image/svg+xml")

    if (settings.static_dir / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=settings.static_dir / "assets"), name="assets")

    @app.get("/", response_class=HTMLResponse)
    @app.get("/scut", response_class=HTMLResponse)
    @app.get("/scut/", response_class=HTMLResponse)
    @app.get("/admin", response_class=HTMLResponse)
    @app.get("/admin/{path:path}", response_class=HTMLResponse)
    def frontend(path: str = ""):
        index = settings.static_dir / "index.html"
        if not index.exists():
            raise HTTPException(503, "前端尚未构建")
        return HTMLResponse(
            index.read_text(encoding="utf-8"), headers={"Cache-Control": "no-cache"}
        )

    return app


def read_manifest(static_dir: Path) -> dict:
    try:
        return json.loads((static_dir / ".vite/manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def css_urls(static_dir: Path) -> list[str]:
    entry = read_manifest(static_dir).get("index.html", {})
    return ["/" + name for name in entry.get("css", [])]


def math_assets(static_dir: Path) -> dict:
    """KaTeX 单独打包，仅在含公式的页面加载。"""
    entry = read_manifest(static_dir).get("src/math.ts")
    if not entry:
        return {}
    return {"js": "/" + entry["file"], "css": ["/" + name for name in entry.get("css", [])]}

import asyncio
import json
import logging
import re
import secrets
import smtplib
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from urllib.parse import quote
from xml.etree.ElementTree import Element, SubElement, tostring

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.exception_handlers import http_exception_handler
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    PlainTextResponse,
    StreamingResponse,
)
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy import delete, func
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlmodel import Session, select
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import accounts, audit, feedback, games, images, storage, user_security
from .accounts import current_user, profile
from .auth import (
    COOKIE,
    admin_access,
    authenticate,
    check_origin,
    current_session,
    issue_session,
)
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
    stored_site,
    summaries,
    timestamp,
    update_article,
    versions,
)
from .database import make_engine
from .docs import router as docs_router
from .drive import accounts as drive_accounts
from .drive.errors import DriveError
from .drive.routes import drive_error
from .drive.routes import router as drive_router
from .feed import atom_feed
from .github import sync_loop, sync_repos
from .limits import JsonBodyLimit
from .models import (
    Article,
    Favorite,
    Feedback,
    GameScore,
    History,
    HostedImage,
    Note,
    ScutReading,
    User,
    UserChallenge,
    UserPasskey,
    UserSession,
)
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
    AccountDelete,
    AccountsConfig,
    ArticleDraft,
    ArticleWrite,
    CodeRequest,
    FeedbackUpdate,
    FeedbackWrite,
    ImageQuotaWrite,
    Login,
    NotesConfig,
    NoteVisibility,
    NoteWrite,
    PasskeyResponse,
    PasskeySetup,
    PasswordChange,
    PasswordReset,
    Preview,
    ProfileWrite,
    ReadingWrite,
    Register,
    Revision,
    ScoreWrite,
    SecurityProof,
    SiteWrite,
    Target,
    TestMail,
    TokenCreate,
    UserLogin,
    UserState,
)
from .scut import public_scut
from .scut import sync_loop as scut_sync_loop
from .settings import Settings

HERE = Path(__file__).parent
logger = logging.getLogger(__name__)
PRIVACY_EFFECTIVE = "2026 年 10 月 24 日"
PLAIN_404_PREFIXES = ("/api/", "/media/", "/images/", "/content-assets/", "/assets/")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    engine = make_engine(settings)
    audit.setup(settings.audit_dir)

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
    app.add_exception_handler(DriveError, drive_error)
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

    def prune_images(session: Session):
        """文章或笔记变更后清理不再被引用的系统图片；失败不影响内容保存。"""
        try:
            images.prune_system(session, settings)
        except Exception:  # noqa: BLE001
            logger.exception("清理系统图片失败")

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

    app.include_router(drive_router)
    app.include_router(docs_router)

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
        with audit.outcome("admin.login", request, email=body.email.strip().lower()[:254]):
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
        row = current_session(request, session)
        return {"csrf": row.csrf, "user": profile(session.get(User, row.user_id))}

    @app.post("/api/auth/passkey/options")
    def key_login_options(request: Request, response: Response, session: Session = Depends(database)):
        admin_access(request)
        check_origin(request)
        return user_security.login_options(request, response, session)

    @app.post("/api/auth/passkey/verify")
    def key_login(body: PasskeyResponse, request: Request, response: Response,
                  session: Session = Depends(database)):
        admin_access(request)
        check_origin(request)
        with audit.outcome("admin.login_passkey", request):
            user = user_security.passkey_user(request, response, session, body)
            if not user.is_admin:
                session.commit()
                raise HTTPException(403, "该账户不是管理员")
            token, row = issue_session(request, session, user.id)
        response.set_cookie(COOKIE, token, max_age=settings.session_hours * 3600,
                            httponly=True, secure=settings.secure_cookie, samesite="lax", path="/api")
        return {"csrf": row.csrf}

    @app.post("/api/auth/logout")
    def logout(request: Request, response: Response, session: Session = Depends(database)):
        row = current_session(request, session, write=True)
        session.delete(row)
        session.commit()
        audit.record("admin.logout", request, ok=True)
        response.delete_cookie(COOKIE, path="/api")
        return {"ok": True}

    # —— 访客账户 ——

    @app.get("/api/account/config")
    def account_config(session: Session = Depends(database)):
        return {**accounts.public_config(session), "captcha": {
            "enabled": settings.email_captcha_enabled,
            "prefix": settings.email_captcha_prefix,
            "sceneId": settings.email_captcha_scene_id,
            "feedbackSceneId": settings.feedback_captcha_scene_id,
        }}

    @app.post("/api/account/code")
    async def account_code(body: CodeRequest, request: Request,
                           session: Session = Depends(database)):
        check_origin(request)
        prepared = accounts.prepare_code(request, session, body.email, body.purpose)
        if prepared:
            name = public_site(session)["name"]
            mail = accounts.code_mail(prepared["code"], body.purpose, name)
            try:
                await asyncio.to_thread(accounts.send_mail, prepared["config"], settings,
                                        prepared["email"], *mail)
            except (smtplib.SMTPException, OSError) as exc:
                session.exec(delete(accounts.EmailCode).where(accounts.EmailCode.id == prepared["row"]))
                session.commit()
                logger.warning("验证码邮件发送失败：%s", type(exc).__name__)
                raise HTTPException(502, "验证码邮件发送失败，请稍后再试") from None
        return {"ok": True, "resend_after": accounts.RESEND_SECONDS}

    @app.post("/api/account/register")
    def account_register(body: Register, request: Request, response: Response,
                         session: Session = Depends(database)):
        with audit.outcome("account.register", request, email=body.email.strip().lower()):
            return accounts.register(request, response, session, body)

    @app.post("/api/account/login")
    def account_login(body: UserLogin, request: Request, response: Response,
                      session: Session = Depends(database)):
        with audit.outcome("account.login", request, email=body.email.strip().lower()):
            return accounts.login(request, response, session, body)

    @app.post("/api/account/reset")
    def account_reset(body: PasswordReset, request: Request, response: Response,
                      session: Session = Depends(database)):
        with audit.outcome("account.reset_password", request, email=body.email.strip().lower()):
            return accounts.reset_password(request, response, session, body)

    @app.post("/api/account/logout")
    def account_logout(request: Request, response: Response, session: Session = Depends(database)):
        user, row = current_user(request, session, write=True)
        session.delete(row)
        session.commit()
        audit.record("account.logout", request, ok=True, user=user.id, email=user.email)
        accounts.clear_cookie(response, settings)
        return {"ok": True}

    @app.get("/api/account/me")
    def account_me(request: Request, response: Response, session: Session = Depends(database)):
        user, row = current_user(request, session)
        accounts.share_cookie(request, response, row)
        plan = storage.plan(session, user.id)
        # 前端据此显示或隐藏云盘、图床与后台入口；新用户默认都没有。
        features = {"drive": plan.drive_enabled, "images": plan.images_enabled,
                    "admin": user.is_admin, "terms": storage.agreed(session, user.id)}
        return {"user": profile(user), "csrf": row.csrf, "features": features}

    # —— 意见反馈 ——

    @app.get("/api/account/feedback")
    def account_feedback(request: Request, session: Session = Depends(database)):
        user, _ = current_user(request, session)
        return {"items": feedback.mine(session, user.id)}

    @app.post("/api/account/feedback")
    def account_feedback_submit(body: FeedbackWrite, request: Request,
                                session: Session = Depends(database)):
        user, _ = current_user(request, session, write=True)
        with audit.outcome("account.feedback", request, user=user.id):
            return feedback.submit(request, session, user, body)

    @app.put("/api/account/profile")
    def account_profile(body: ProfileWrite, request: Request, session: Session = Depends(database)):
        user, _ = current_user(request, session, write=True)
        user.name = body.name.strip()
        session.add(user)
        session.commit()
        return profile(user)

    @app.post("/api/account/password")
    def account_password(body: PasswordChange, request: Request,
                         session: Session = Depends(database)):
        user, row = current_user(request, session, write=True)
        with audit.outcome("account.change_password", request, user=user.id, email=user.email):
            accounts.change_password(session, user, row, body)
        return {"ok": True}

    @app.get("/api/account/security")
    def account_security(request: Request, session: Session = Depends(database)):
        user, _ = current_user(request, session)
        return user_security.state(session, user)

    @app.post("/api/account/security/2fa/{operation}")
    def account_factor(operation: str, body: SecurityProof, request: Request,
                       session: Session = Depends(database)):
        user, _ = current_user(request, session)
        with audit.outcome(f"account.2fa_{operation}", request, user=user.id):
            return user_security.factor_action(request, session, body, operation)

    @app.post("/api/account/security/passkeys/options")
    def account_key_options(body: PasskeySetup, request: Request, response: Response,
                            session: Session = Depends(database)):
        return user_security.register_options(request, response, session, body)

    @app.post("/api/account/security/passkeys/verify")
    def account_key_register(body: PasskeyResponse, request: Request,
                             session: Session = Depends(database)):
        user, _ = current_user(request, session)
        with audit.outcome("account.passkey_add", request, user=user.id):
            return user_security.register_verify(request, session, body)

    @app.post("/api/account/security/passkeys/{key_id}/remove")
    def account_key_remove(key_id: str, body: SecurityProof, request: Request,
                           session: Session = Depends(database)):
        user, _ = current_user(request, session)
        with audit.outcome("account.passkey_remove", request, user=user.id):
            return user_security.remove_passkey(request, session, key_id, body)

    @app.post("/api/account/passkey/options")
    def account_passkey_options(request: Request, response: Response,
                                session: Session = Depends(database)):
        return user_security.login_options(request, response, session)

    @app.post("/api/account/passkey/verify")
    def account_passkey_login(body: PasskeyResponse, request: Request, response: Response,
                              session: Session = Depends(database)):
        with audit.outcome("account.login_passkey", request):
            return user_security.login_verify(request, response, session, body)

    @app.post("/api/account/avatar")
    async def account_avatar(request: Request, session: Session = Depends(database)):
        user, _ = current_user(request, session, write=True)
        chunks, size = [], 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > accounts.MAX_AVATAR_BYTES:
                raise HTTPException(413, "头像不能超过 2 MiB")
            chunks.append(chunk)
        user.avatar = await asyncio.to_thread(
            accounts.save_avatar, b"".join(chunks), user, settings.media_dir
        )
        session.add(user)
        session.commit()
        return profile(user)

    @app.post("/api/account/delete")
    def account_delete(body: AccountDelete, request: Request, response: Response,
                       session: Session = Depends(database)):
        user, _ = current_user(request, session, write=True)
        with audit.outcome("account.delete", request, user=user.id, email=user.email):
            accounts.delete_account(session, user, body.password, settings.media_dir)
            images.remove_owner(session, settings, user.id)
            drive_accounts.remove_user(session, settings, user.id)
            session.commit()
        accounts.clear_cookie(response, settings)
        return {"ok": True}

    @app.get("/api/account/favorites")
    def account_favorites(request: Request, session: Session = Depends(database)):
        user, _ = current_user(request, session)
        return {"items": accounts.entries(session, Favorite, user, Favorite.created_at)}

    @app.get("/api/account/favorites/check")
    def account_favorite_check(kind: str, slug: str, request: Request,
                               session: Session = Depends(database)):
        user, _ = current_user(request, session)
        return {"favorite": session.get(Favorite, (user.id, kind, slug)) is not None}

    @app.post("/api/account/favorites")
    def account_favorite(body: Target, request: Request, session: Session = Depends(database)):
        user, _ = current_user(request, session, write=True)
        accounts.add_favorite(session, user, body.kind, body.slug)
        return {"favorite": True}

    @app.post("/api/account/favorites/remove")
    def account_unfavorite(body: Target, request: Request, session: Session = Depends(database)):
        user, _ = current_user(request, session, write=True)
        row = session.get(Favorite, (user.id, body.kind, body.slug))
        if row:
            session.delete(row)
            session.commit()
        return {"favorite": False}

    @app.get("/api/account/history")
    def account_history(request: Request, session: Session = Depends(database)):
        user, _ = current_user(request, session)
        return {"items": accounts.entries(session, History, user, History.viewed_at)}

    @app.post("/api/account/history")
    def account_view(body: Target, request: Request, session: Session = Depends(database)):
        user, _ = current_user(request, session, write=True)
        accounts.record_view(session, user, body.kind, body.slug)
        return {"ok": True}

    @app.post("/api/account/history/clear")
    def account_history_clear(request: Request, session: Session = Depends(database)):
        user, _ = current_user(request, session, write=True)
        session.exec(delete(History).where(History.user_id == user.id))
        session.commit()
        return {"ok": True}

    @app.get("/api/account/scut")
    def account_scut(request: Request, session: Session = Depends(database)):
        user, _ = current_user(request, session)
        row = session.get(ScutReading, user.id)
        return {"state": row.state if row else None, "updated_at": row.updated_at if row else None}

    @app.put("/api/account/scut")
    def account_scut_save(body: ReadingWrite, request: Request,
                          session: Session = Depends(database)):
        user, _ = current_user(request, session, write=True)
        row = session.get(ScutReading, user.id) or ScutReading(user_id=user.id, state={},
                                                               updated_at="")
        row.state, row.updated_at = body.state.model_dump(), timestamp()
        session.add(row)
        session.commit()
        return {"updated_at": row.updated_at}

    @app.get("/api/games/{game}/leaderboard")
    def game_leaderboard(game: str, request: Request, session: Session = Depends(database)):
        try:
            user, _ = current_user(request, session)
        except HTTPException:
            user = None
        return games.leaderboard(session, game, user)

    @app.get("/api/account/games")
    def account_games(request: Request, session: Session = Depends(database)):
        user, _ = current_user(request, session)
        return games.mine(session, user)

    @app.post("/api/account/games/{game}")
    def account_game_submit(game: str, body: ScoreWrite, request: Request,
                            session: Session = Depends(database)):
        user, _ = current_user(request, session, write=True)
        return games.submit(session, user, game, body)

    # —— 后台：收件箱 ——

    @app.get("/api/admin/inbox")
    def admin_inbox(status: str = "", page: int = 1, session: Session = Depends(authorized)):
        if status not in {"", "new", "read", "done"}:
            raise HTTPException(422, "状态不正确")
        return feedback.inbox(session, status, page)

    @app.put("/api/admin/inbox/{feedback_id}")
    def admin_inbox_update(feedback_id: str, body: FeedbackUpdate, request: Request,
                           session: Session = Depends(authorized)):
        result = feedback.update(session, feedback_id, body)
        audit.record("admin.feedback_update", request, ok=True, feedback=feedback_id,
                     status=body.status, replied=body.reply is not None)
        return result

    @app.post("/api/admin/inbox/{feedback_id}/remove")
    def admin_inbox_remove(feedback_id: str, request: Request,
                           session: Session = Depends(authorized)):
        feedback.remove(session, feedback_id)
        audit.record("admin.feedback_remove", request, ok=True, feedback=feedback_id)
        return {"ok": True}

    # —— 后台：注册与邮件配置、用户管理 ——

    @app.get("/api/admin/accounts")
    def admin_accounts(session: Session = Depends(authorized)):
        users = session.exec(select(User).order_by(User.created_at.desc())).all()
        return {"config": accounts.admin_config(session), "users": [
            {**profile(u), "disabled": u.disabled, "last_login": u.last_login, "admin": u.is_admin,
             "images": images.limits(session, u.id), "totp": bool(u.totp_secret),
             "passkeys": len(user_security.state(session, u)["passkeys"])} for u in users
        ]}

    @app.put("/api/admin/accounts/config")
    def admin_accounts_config(body: AccountsConfig, session: Session = Depends(authorized)):
        data = body.model_dump(exclude={"smtpPassword"})
        return accounts.save_config(session, data, body.smtpPassword, settings)

    @app.post("/api/admin/accounts/test-email")
    async def admin_accounts_test(body: TestMail, session: Session = Depends(authorized)):
        value = accounts.config(session)
        if not accounts.smtp_ready(value):
            raise HTTPException(409, "请先填写并保存 SMTP 服务器、账号与授权码")
        to = accounts.normalize_email(body.to, session, check_domain=False)
        name = public_site(session)["name"]
        try:
            await asyncio.to_thread(
                accounts.send_mail, value, settings, to, f"{name} · 邮件发送测试",
                "这是一封测试邮件，说明验证码邮件可以正常发送。",
                "<p>这是一封测试邮件，说明验证码邮件可以正常发送。</p>",
            )
        except smtplib.SMTPAuthenticationError:
            raise HTTPException(502, "SMTP 登录失败：请检查账号与授权码（不是邮箱登录密码）") from None
        except (smtplib.SMTPException, OSError) as exc:
            raise HTTPException(502, f"邮件发送失败：{type(exc).__name__}") from None
        return {"ok": True}

    @app.post("/api/admin/accounts/users/{user_id}/state")
    def admin_user_state(user_id: str, body: UserState, session: Session = Depends(authorized)):
        user = session.get(User, user_id)
        if user is None:
            raise HTTPException(404, "用户不存在")
        if user.is_admin and body.disabled:
            raise HTTPException(409, "不能停用管理员账户，请先用命令行取消管理员身份")
        user.disabled = body.disabled
        if body.disabled:
            session.exec(delete(UserSession).where(UserSession.user_id == user.id))
        session.add(user)
        session.commit()
        return {"ok": True}

    @app.post("/api/admin/accounts/users/{user_id}/reset-security")
    def admin_user_reset_security(user_id: str, request: Request,
                                  session: Session = Depends(authorized)):
        user = session.get(User, user_id)
        if user is None:
            raise HTTPException(404, "用户不存在")
        user_security.reset(session, user)
        audit.record("admin.user_reset_security", request, ok=True, user=user.id)
        return {"ok": True}

    @app.post("/api/admin/accounts/users/{user_id}/remove")
    def admin_user_remove(user_id: str, session: Session = Depends(authorized)):
        user = session.get(User, user_id)
        if user is None:
            raise HTTPException(404, "用户不存在")
        if user.is_admin:
            raise HTTPException(409, "不能删除管理员账户")
        for table in (Favorite, History, UserSession, ScutReading, GameScore, UserPasskey,
                      UserChallenge, Feedback):
            session.exec(delete(table).where(table.user_id == user.id))
        accounts.remove_avatar(user, settings.media_dir)
        images.remove_owner(session, settings, user.id)
        drive_accounts.remove_user(session, settings, user.id)
        session.delete(user)
        session.commit()
        return {"ok": True}

    # —— 图床 ——

    @app.post("/api/upload")
    async def image_upload(request: Request, session: Session = Depends(database)):
        """PicList 等客户端上传：Bearer 令牌鉴权，multipart 的 file 字段或原始文件流。"""
        owner = images.token_owner(request, session)
        value = images.require_enabled(session, owner)
        payload = await images.read_upload(request, value["max_file"])
        row, _ = await asyncio.to_thread(images.store, session, settings, owner, payload)
        return images.view(settings, row)

    @app.get("/api/account/images")
    def account_images(request: Request, page: int = 1, session: Session = Depends(database)):
        user, _ = current_user(request, session)
        value = images.limits(session, user.id)
        if not value["enabled"]:
            return {"limits": value}
        return {"limits": value, "tokens": images.tokens(session, user.id),
                "upload_url": settings.upload_url, **images.listing(session, settings, user.id, page)}

    @app.post("/api/account/images")
    async def account_image_upload(request: Request, session: Session = Depends(database)):
        user, _ = current_user(request, session, write=True)
        value = images.require_enabled(session, user.id)
        payload = await images.read_upload(request, value["max_file"])
        row, created = await asyncio.to_thread(images.store, session, settings, user.id, payload)
        return {**images.view(settings, row), "created": created}

    @app.post("/api/account/images/{image_id}/remove")
    def account_image_remove(image_id: str, request: Request,
                             session: Session = Depends(database)):
        user, _ = current_user(request, session, write=True)
        images.remove(session, settings, images.get_image(session, image_id, user.id))
        return {"ok": True}

    @app.post("/api/account/images/tokens")
    def account_token_create(body: TokenCreate, request: Request,
                             session: Session = Depends(database)):
        user, _ = current_user(request, session, write=True)
        images.require_enabled(session, user.id)
        with audit.outcome("image.token_create", request, user=user.id):
            return images.create_token(session, user.id, body.name)

    @app.post("/api/account/images/tokens/{token_id}/remove")
    def account_token_remove(token_id: str, request: Request,
                             session: Session = Depends(database)):
        user, _ = current_user(request, session, write=True)
        images.revoke_token(session, user.id, token_id)
        audit.record("image.token_revoke", request, ok=True, user=user.id, token=token_id)
        return {"ok": True}

    @app.get("/api/account/images/export")
    def account_image_export(request: Request, session: Session = Depends(database)):
        user, _ = current_user(request, session)
        images.require_enabled(session, user.id)
        key = f"image-export:{user.id}"
        accounts.throttle(session, key, 1, "导出过于频繁，请 15 分钟后再试")
        accounts.record_failure(session, key)
        rows = session.exec(
            select(HostedImage).where(HostedImage.owner == user.id)
            .order_by(HostedImage.created_at)
        ).all()
        name = f"images-{timestamp()[:10]}.zip"
        return StreamingResponse(images.export_stream(settings, rows), media_type="application/zip",
                                 headers={"Content-Disposition": f'attachment; filename="{name}"'})

    @app.get("/api/admin/images")
    def admin_images(request: Request, owner: str = "", page: int = 1,
                     session: Session = Depends(authorized)):
        rows = session.exec(
            select(HostedImage.owner, func.count(), func.sum(HostedImage.size))
            .group_by(HostedImage.owner)
        ).all()
        users = {u.id: u for u in session.exec(select(User)).all()}
        usage = [{"owner": key, "count": count, "size": size,
                  "label": "系统（文章与笔记）" if key == images.SYSTEM else
                  "旧管理员" if key == images.ADMIN else
                  users[key].email if key in users else key} for key, count, size in rows]
        return {**images.listing(session, settings, owner or None, page), "usage": usage}

    @app.post("/api/admin/images/{image_id}/remove")
    def admin_image_remove(image_id: str, request: Request,
                           session: Session = Depends(authorized)):
        row = images.get_image(session, image_id)
        if row.owner == images.SYSTEM:
            raise HTTPException(409, "文章与笔记引用的图片会随内容自动清理，不能单独删除")
        audit.record("admin.image_remove", request, ok=True, image=row.id, owner=row.owner)
        images.remove(session, settings, row)
        return {"ok": True}

    @app.put("/api/admin/accounts/users/{user_id}/images")
    def admin_user_images(user_id: str, body: ImageQuotaWrite, request: Request,
                          session: Session = Depends(authorized)):
        if session.get(User, user_id) is None:
            raise HTTPException(404, "用户不存在")
        images.set_quota(session, user_id, body.enabled, body.quota_mb, body.max_file_mb)
        audit.record("admin.image_quota", request, ok=True, user=user_id, **body.model_dump())
        return images.limits(session, user_id)

    @app.get("/api/admin/site")
    def admin_site(session: Session = Depends(authorized)):
        row = require_content(session, "site")
        return {"site": stored_site(session), "revision": row.revision}

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
        prune_images(session)
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

    @app.post("/api/admin/posts/{article_id}/delete")
    def delete_post(article_id: str, body: Revision, session: Session = Depends(authorized)):
        row = get_article(session, article_id)
        if row.published is not None:
            raise HTTPException(409, "请先撤下文章再删除")
        result = session.exec(
            delete(Article).where(Article.id == row.id, Article.revision == body.revision)
        )
        if result.rowcount != 1:
            raise HTTPException(409, "文章已被其他窗口修改，请重新加载后再操作")
        session.commit()
        prune_images(session)
        return {"ok": True}

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
        result = admin_view(save_manual(session, get_note(session, note_id), body), full=True)
        prune_images(session)
        return result

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
        prune_images(session)
        return {"ok": True}

    @app.post("/api/admin/preview")
    def preview(body: Preview, session: Session = Depends(authorized)):
        return {"html": render_markdown(body.markdown)}

    @app.post("/api/admin/media", status_code=201)
    async def upload(request: Request, session: Session = Depends(authorized)):
        # 编辑器上传的图片存入系统图床：随文章与笔记的引用自动保留或清理，不能单独删除。
        payload = await images.read_upload(request, images.MAX_IMAGE_BYTES)
        row, _ = await asyncio.to_thread(images.store, session, settings, images.SYSTEM, payload)
        return {"url": images.url(settings, row.path)}

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
        for path, modified in [
            ("/", None), ("/scut", None), ("/games", None),
            *[(f"/games/{game}", None) for game in games.GAMES],
            ("/posts", None),
        ] + [
            (f"/posts/{p['slug']}", p["updated_at"]) for p in published_posts(session)
        ] + [("/notes", None), ("/privacy", None)] + [
            (f"/notes/{n['slug']}", n["updated_at"]) for n in public_notes(session)
        ]:
            entry = SubElement(root, "url")
            SubElement(entry, "loc").text = settings.site_url + quote(path, safe="/")
            if modified:
                SubElement(entry, "lastmod").text = modified
        return Response(
            tostring(root, encoding="utf-8", xml_declaration=True), media_type="application/xml"
        )

    @app.get("/feed.xml")
    def feed(session: Session = Depends(database)):
        body = atom_feed(public_site(session), published_posts(session)[:20], settings.site_url)
        return Response(body, media_type="application/atom+xml; charset=utf-8")

    @app.get("/privacy", response_class=HTMLResponse)
    def privacy(request: Request, session: Session = Depends(database)):
        context = page_context(session, "/privacy", "隐私政策", "本站如何收集、使用与保存个人信息")
        context.update(
            nav_active="", effective=PRIVACY_EFFECTIVE, site_host=settings.site_url.split("://", 1)[1]
        )
        return templates.TemplateResponse(request=request, name="privacy.html", context=context)

    @app.get("/robots.txt", response_class=PlainTextResponse)
    def robots():
        return f"User-agent: *\nDisallow: /admin\nDisallow: /api/\nSitemap: {settings.site_url}/sitemap.xml\n"

    # 开发/SSH 隧道时直连后端也能查看完整站点；生产静态资源由 Caddy 服务。
    app.mount("/media", StaticFiles(directory=settings.media_dir), name="media")
    app.mount("/images", StaticFiles(directory=settings.images_dir), name="images")
    app.mount("/content-assets", StaticFiles(directory=HERE / "static"), name="content-assets")
    @app.get("/favicon.svg", include_in_schema=False)
    @app.get("/beian-police.png", include_in_schema=False)
    def public_icon(request: Request):
        icon = settings.static_dir / request.url.path.lstrip("/")
        if not icon.is_file():
            raise HTTPException(404)
        return FileResponse(icon)

    if (settings.static_dir / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=settings.static_dir / "assets"), name="assets")

    @app.get("/", response_class=HTMLResponse)
    @app.get("/scut", response_class=HTMLResponse)
    @app.get("/scut/", response_class=HTMLResponse)
    @app.get("/account", response_class=HTMLResponse)
    @app.get("/admin", response_class=HTMLResponse)
    @app.get("/admin/{path:path}", response_class=HTMLResponse)
    @app.get("/drive", response_class=HTMLResponse)
    @app.get("/drive/{path:path}", response_class=HTMLResponse)
    @app.get("/s/{path:path}", response_class=HTMLResponse)
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

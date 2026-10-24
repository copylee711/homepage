"""后台登录：管理员就是带 is_admin 标记的站点用户。

后台使用独立的会话 Cookie 与较短的有效期；即使已在前台登录，进入后台仍需再次验证
密码（及两步验证）或 Passkey。公网访问受 admin_access 限制。
"""
import hashlib
import secrets
import time

from fastapi import HTTPException, Request
from sqlalchemy import delete, update
from sqlmodel import Session, select

from .models import AuthChallenge, HostedImage, ImageToken, LoginAttempt, LoginSession, User
from .schemas import Login

COOKIE = "copylee_session"


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def admin_access(request: Request):
    settings = request.app.state.settings
    local = request.url.hostname in {"localhost", "127.0.0.1", "::1"}
    loopback = request.client and request.client.host in {"127.0.0.1", "::1", "testclient"}
    if not settings.public_admin and not (local and loopback):
        raise HTTPException(403, "公网管理尚未开启，请通过 SSH 隧道访问")
    if settings.public_admin and (
        not settings.secure_cookie or not settings.site_url.startswith("https://")
    ):
        raise HTTPException(503, "公网管理需要 HTTPS 和安全 Cookie")
    if settings.public_admin and request.url.scheme != "https":
        raise HTTPException(403, "公网管理只能通过 HTTPS 访问")


def check_origin(request: Request):
    if request.headers.get("origin", "").rstrip("/") not in request.app.state.settings.origins:
        raise HTTPException(403, "请求来源不允许")


def current_session(request: Request, session: Session, write: bool = False) -> LoginSession:
    admin_access(request)
    token = request.cookies.get(COOKIE, "")
    row = session.get(LoginSession, digest(token)) if token else None
    user = session.get(User, row.user_id) if row and row.user_id else None
    if row is None or row.expires_at <= time.time() or user is None or not user.is_admin \
            or user.disabled:
        raise HTTPException(401, "请重新登录")
    if write:
        check_origin(request)
        if not secrets.compare_digest(
            request.headers.get("x-csrf-token", "").encode(), row.csrf.encode()
        ):
            raise HTTPException(403, "CSRF 校验失败")
    return row


def authenticate(request: Request, session: Session, body: Login) -> tuple[str, LoginSession]:
    from .accounts import DUMMY_HASH, verify_password
    from .security import OTP_REQUIRED, verify_factor

    admin_access(request)
    check_origin(request)
    # 串行执行，保证密码重置与登录之间不会出现旧密码创建新会话的竞争。
    session.connection().exec_driver_sql("BEGIN IMMEDIATE")
    # 后台登录全局限流，攻击者无法用大量邮箱/IP 扩大尝试次数。
    rate_check(session)
    user = session.exec(select(User).where(User.email == body.email.strip().lower())).first()
    valid = verify_password(user.password_hash if user else DUMMY_HASH, body.password)
    if not user or not valid or not user.is_admin or user.disabled:
        fail_login(session, "账号或密码错误")
    if user.totp_secret:
        if not body.otp:
            raise HTTPException(403, OTP_REQUIRED)
        if not verify_factor(request.app.state.settings, user, body.otp):
            fail_login(session, "验证码无效、已使用或已过期")
        session.add(user)
    session.exec(delete(LoginAttempt).where(LoginAttempt.key == "admin"))
    return issue_session(request, session, user.id)


def issue_session(request: Request, session: Session, user_id: str) -> tuple[str, LoginSession]:
    session.exec(delete(LoginSession).where(LoginSession.expires_at <= time.time()))
    token = secrets.token_urlsafe(48)
    row = LoginSession(
        token_hash=digest(token),
        csrf=secrets.token_urlsafe(32),
        expires_at=time.time() + request.app.state.settings.session_hours * 3600,
        user_id=user_id,
    )
    session.add(row)
    session.commit()
    return token, row


def rate_check(session: Session):
    attempt = session.get(LoginAttempt, "admin")
    if attempt and time.time() - attempt.window_start < 900 and attempt.failures >= 5:
        raise HTTPException(429, "登录失败过多，请 15 分钟后重试", headers={"Retry-After": "900"})


def fail_login(session: Session, message: str, status: int = 401):
    now = time.time()
    attempt = session.get(LoginAttempt, "admin") or LoginAttempt(key="admin", window_start=now)
    if now - attempt.window_start >= 900:
        attempt.window_start, attempt.failures = now, 0
    attempt.failures += 1
    session.add(attempt)
    session.commit()
    raise HTTPException(status, message)


def set_admin(session: Session, email: str) -> User:
    """把站点用户设为管理员；原管理员名下的图床图片与令牌转给该用户。"""
    user = session.exec(select(User).where(User.email == email.strip().lower())).first()
    if user is None:
        raise ValueError("该邮箱尚未注册，请先在网站注册")
    user.is_admin, user.disabled = True, False
    session.add(user)
    session.exec(update(HostedImage).where(HostedImage.owner == "admin").values(owner=user.id))
    session.exec(update(ImageToken).where(ImageToken.owner == "admin").values(owner=user.id))
    session.exec(delete(LoginSession))
    session.exec(delete(LoginAttempt).where(LoginAttempt.key == "admin"))
    session.exec(delete(AuthChallenge))
    session.commit()
    return user


def revoke_admin(session: Session, email: str) -> User:
    user = session.exec(select(User).where(User.email == email.strip().lower())).first()
    if user is None or not user.is_admin:
        raise ValueError("该邮箱不是管理员")
    user.is_admin = False
    session.add(user)
    session.exec(delete(LoginSession).where(LoginSession.user_id == user.id))
    session.commit()
    return user

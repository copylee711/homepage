import hashlib
import secrets
import time

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError
from fastapi import HTTPException, Request
from sqlalchemy import delete
from sqlmodel import Session

from .models import Administrator, AuthChallenge, LoginAttempt, LoginSession
from .schemas import Login

hasher = PasswordHasher()
COOKIE = "copylee_session"
# 未配置账号时也执行一次哈希验证，避免用户名探测时的明显耗时差异。
DUMMY_HASH = hasher.hash(secrets.token_urlsafe(32))


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
    if row is None or row.expires_at <= time.time():
        raise HTTPException(401, "请重新登录")
    if write:
        check_origin(request)
        if not secrets.compare_digest(
            request.headers.get("x-csrf-token", "").encode(), row.csrf.encode()
        ):
            raise HTTPException(403, "CSRF 校验失败")
    return row


def authenticate(request: Request, session: Session, body: Login) -> tuple[str, LoginSession]:
    admin_access(request)
    check_origin(request)
    # 串行执行 Argon2 校验，避免低内存服务器同时分配多份哈希工作区。
    # 同时保证密码重置与登录之间不会出现旧密码创建新会话的竞争。
    session.connection().exec_driver_sql("BEGIN IMMEDIATE")
    now = time.time()
    # 单管理员全局限制同时阻止攻击者用大量用户名/IP 扩大数据库。
    attempt = session.get(LoginAttempt, "admin")
    if attempt and now - attempt.window_start < 900 and attempt.failures >= 5:
        raise HTTPException(429, "登录失败过多，请 15 分钟后重试", headers={"Retry-After": "900"})
    admin = session.get(Administrator, 1)
    try:
        valid = hasher.verify(admin.password_hash if admin else DUMMY_HASH, body.password)
    except VerificationError:
        valid = False
    if (
        not admin
        or not valid
        or not secrets.compare_digest(admin.username.encode(), body.username.encode())
    ):
        fail_login(session, "账号或密码错误")
    from .security import verify_factor
    if admin.totp_secret:
        if not body.otp:
            raise HTTPException(403, "请输入两步验证码或恢复码")
        if not verify_factor(request.app.state.settings, admin, body.otp):
            fail_login(session, "验证码无效、已使用或已过期")
        session.add(admin)
    if attempt:
        session.delete(attempt)
    session.exec(delete(LoginSession).where(LoginSession.expires_at <= now))
    return issue_session(request, session)


def issue_session(request: Request, session: Session) -> tuple[str, LoginSession]:
    session.exec(delete(LoginSession).where(LoginSession.expires_at <= time.time()))
    token = secrets.token_urlsafe(48)
    row = LoginSession(
        token_hash=digest(token),
        csrf=secrets.token_urlsafe(32),
        expires_at=time.time() + request.app.state.settings.session_hours * 3600,
    )
    session.add(row)
    session.commit()
    return token, row


def rate_check(session: Session):
    attempt = session.get(LoginAttempt, "admin")
    if attempt and time.time() - attempt.window_start < 900 and attempt.failures >= 5:
        raise HTTPException(429, "登录失败过多，请 15 分钟后重试", headers={"Retry-After": "900"})


def fail_login(session: Session, message: str):
    now = time.time()
    attempt = session.get(LoginAttempt, "admin") or LoginAttempt(key="admin", window_start=now)
    if now - attempt.window_start >= 900:
        attempt.window_start, attempt.failures = now, 0
    attempt.failures += 1
    session.add(attempt)
    session.commit()
    raise HTTPException(401, message)


def set_admin(session: Session, username: str, password: str):
    if not username.strip() or len(username) > 80 or not 12 <= len(password) <= 200:
        raise ValueError("账号不能为空；密码需要 12–200 个字符")
    admin = session.get(Administrator, 1) or Administrator(username=username, password_hash="")
    admin.username, admin.password_hash = username, hasher.hash(password)
    session.add(admin)
    session.exec(delete(LoginSession))
    session.exec(delete(LoginAttempt))
    session.exec(delete(AuthChallenge))
    session.commit()

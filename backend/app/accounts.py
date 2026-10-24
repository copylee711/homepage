"""访客账户：邮箱注册、登录、收藏、浏览记录与头像。

与管理员认证完全分离：独立的 Cookie、会话表与限流键。验证码通过站长配置的
SMTP 邮箱发送，按邮箱、IP 与每日总量限流，避免个人邮箱被滥用。
"""

import re
import secrets
import smtplib
import ssl
import threading
import time
import uuid
import warnings
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import formataddr
from io import BytesIO

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from fastapi import HTTPException, Request, Response
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import delete, func, update
from sqlmodel import Session, select

from .auth import check_origin, digest
from .content import require_content, timestamp
from .models import (
    Article,
    Content,
    EmailCode,
    Favorite,
    GameScore,
    History,
    LoginAttempt,
    Note,
    ScutReading,
    User,
    UserChallenge,
    UserPasskey,
    UserSession,
)

USER_COOKIE = "copylee_user"
SESSION_DAYS = 30
CODE_SECONDS = 600
RESEND_SECONDS = 60
HISTORY_LIMIT = 200
FAVORITE_LIMIT = 500
MAX_AVATAR_BYTES = 2 * 1024 * 1024
BEIJING = timezone(timedelta(hours=8))
EMAIL = re.compile(r"^[A-Za-z0-9._%+-]{1,64}@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)$")
# OWASP 推荐的低内存参数；并发哈希限制为 2，避免 2G 内存服务器被登录请求占满。
hasher = PasswordHasher(time_cost=2, memory_cost=19456, parallelism=1)
HASH_SLOTS = threading.BoundedSemaphore(2)
DUMMY_HASH = hasher.hash(secrets.token_urlsafe(16))

ACCOUNTS_DEFAULTS = {
    "registrationOpen": False,
    "allowedDomains": [
        "qq.com", "foxmail.com", "163.com", "126.com", "yeah.net", "sina.com", "sina.cn",
        "sohu.com", "aliyun.com", "139.com", "189.cn", "gmail.com", "outlook.com",
        "hotmail.com", "live.com", "icloud.com", "me.com", "yahoo.com", "proton.me",
        "protonmail.com", "mail.scut.edu.cn",
    ],
    "dailyLimit": 100,
    "smtp": {"host": "smtp.qq.com", "port": 465, "security": "ssl", "username": "",
             "fromName": "Copy Lee", "fromAddress": ""},
    "smtpPassword": "",
}


# —— 配置与工具 ——


def config(session: Session) -> dict:
    return {**ACCOUNTS_DEFAULTS, **require_content(session, "accounts").value}


def public_config(session: Session) -> dict:
    value = config(session)
    return {"registrationOpen": value["registrationOpen"], "allowedDomains": value["allowedDomains"]}


def admin_config(session: Session) -> dict:
    value = dict(config(session))
    value["hasSmtpPassword"] = bool(value.pop("smtpPassword"))
    return value


def save_config(session: Session, body: dict, password: str | None, settings) -> dict:
    from .security import cipher

    value = config(session)
    value.update(body)
    if password is not None:
        value["smtpPassword"] = (
            cipher(settings, create=True).encrypt(password.encode()).decode() if password else ""
        )
    session.exec(update(Content).where(Content.key == "accounts").values(value=value))
    session.commit()
    return admin_config(session)


def normalize_email(value: str, session: Session, check_domain: bool = True) -> str:
    email = value.strip().lower()
    match = EMAIL.match(email)
    if not match:
        raise HTTPException(422, "邮箱格式不正确")
    if check_domain and match.group(1) not in config(session)["allowedDomains"]:
        raise HTTPException(422, "暂不支持该邮箱，请使用 QQ、163、Gmail 等常见邮箱")
    return email


def client_ip(request: Request) -> str:
    return request.client.host if request.client else ""


def verify_password(stored: str, password: str) -> bool:
    with HASH_SLOTS:
        try:
            return hasher.verify(stored, password)
        except (VerificationError, InvalidHashError):
            return False


def hash_password(password: str) -> str:
    with HASH_SLOTS:
        return hasher.hash(password)


def throttle(session: Session, key: str, limit: int, message: str):
    attempt = session.get(LoginAttempt, key)
    if attempt and time.time() - attempt.window_start < 900 and attempt.failures >= limit:
        raise HTTPException(429, message, headers={"Retry-After": "900"})


def record_failure(session: Session, *keys: str):
    now = time.time()
    for key in keys:
        attempt = session.get(LoginAttempt, key) or LoginAttempt(key=key, window_start=now)
        if now - attempt.window_start >= 900:
            attempt.window_start, attempt.failures = now, 0
        attempt.failures += 1
        session.add(attempt)
    session.commit()


# —— 邮件 ——


def smtp_ready(value: dict) -> bool:
    smtp = value["smtp"]
    return bool(smtp["host"] and smtp["username"] and value["smtpPassword"])


def send_mail(value: dict, settings, to: str, subject: str, text: str, html: str):
    from .security import decrypt

    smtp = value["smtp"]
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = formataddr((smtp["fromName"], smtp["fromAddress"] or smtp["username"]))
    message["To"] = to
    message.set_content(text)
    message.add_alternative(html, subtype="html")
    password = decrypt(settings, value["smtpPassword"])
    context = ssl.create_default_context()
    if smtp["security"] == "ssl":
        client = smtplib.SMTP_SSL(smtp["host"], smtp["port"], context=context, timeout=20)
    else:
        client = smtplib.SMTP(smtp["host"], smtp["port"], timeout=20)
    with client:
        if smtp["security"] == "starttls":
            client.starttls(context=context)
        client.login(smtp["username"], password)
        client.send_message(message)


def code_mail(code: str, purpose: str, site_name: str) -> tuple[str, str, str]:
    action = "注册账户" if purpose == "register" else "重置密码"
    subject = f"{site_name} · {action}验证码 {code}"
    text = f"你正在 {site_name} {action}。验证码：{code}\n\n10 分钟内有效。如非本人操作，请忽略本邮件。"
    html = f"""<div style="font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;max-width:480px;margin:auto;padding:32px;color:#111114">
<p style="color:#9ca3af;font-size:12px;letter-spacing:.18em;text-transform:uppercase;margin:0">{site_name}</p>
<h1 style="font-size:22px;margin:12px 0 8px">{action}验证码</h1>
<p style="color:#4b5563;margin:0 0 24px">请在页面中输入以下验证码，10 分钟内有效。</p>
<p style="font:600 34px/1 ui-monospace,Consolas,monospace;letter-spacing:.3em;color:#3b6ef5;background:#eef2fb;border-radius:12px;padding:20px;text-align:center;margin:0">{code}</p>
<p style="color:#9ca3af;font-size:12px;margin:24px 0 0">如非本人操作，请忽略本邮件，你的邮箱不会被注册。</p></div>"""
    return subject, text, html


def prepare_code(request: Request, session: Session, email: str, purpose: str) -> dict | None:
    """校验与限流后写入验证码，返回待发送内容；不需要发送时返回 None。"""
    value = config(session)
    email = normalize_email(email, session, check_domain=purpose == "register")
    existing = session.exec(select(User).where(User.email == email)).first()
    if purpose == "register":
        if not value["registrationOpen"]:
            raise HTTPException(403, "暂未开放注册")
        if existing:
            raise HTTPException(409, "该邮箱已注册，请直接登录")
    if not smtp_ready(value):
        raise HTTPException(503, "邮件服务尚未配置，请稍后再试")
    now = time.time()
    session.exec(delete(EmailCode).where(EmailCode.expires_at <= now))
    latest = session.exec(
        select(EmailCode).where(EmailCode.email == email, EmailCode.purpose == purpose)
        .order_by(EmailCode.created_at.desc())
    ).first()
    if latest and now - latest.created_at < RESEND_SECONDS:
        wait = int(RESEND_SECONDS - (now - latest.created_at)) + 1
        raise HTTPException(429, f"发送太频繁，请 {wait} 秒后再试")
    ip_hash = digest(client_ip(request))
    recent_ip = session.exec(
        select(func.count()).select_from(EmailCode)
        .where(EmailCode.ip_hash == ip_hash, EmailCode.created_at > now - 3600)
    ).one()
    if recent_ip >= 10:
        raise HTTPException(429, "发送次数过多，请一小时后再试")
    today = datetime.now(BEIJING).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    sent_today = session.exec(
        select(func.count()).select_from(EmailCode).where(EmailCode.created_at >= today)
    ).one()
    if sent_today >= value["dailyLimit"]:
        raise HTTPException(429, "今日验证码发送已达上限，请明天再试")
    if purpose == "reset" and (existing is None or existing.disabled):
        return None  # 不暴露邮箱是否注册
    code = f"{secrets.randbelow(10**6):06d}"
    session.exec(delete(EmailCode).where(EmailCode.email == email, EmailCode.purpose == purpose))
    row = EmailCode(id=uuid.uuid4().hex, email=email, purpose=purpose,
                    code_hash=digest(f"{email}:{purpose}:{code}"), ip_hash=ip_hash,
                    created_at=now, expires_at=now + CODE_SECONDS)
    session.add(row)
    session.commit()
    return {"row": row.id, "email": email, "code": code, "config": value}


def consume_code(session: Session, email: str, purpose: str, code: str):
    now = time.time()
    row = session.exec(
        select(EmailCode).where(EmailCode.email == email, EmailCode.purpose == purpose,
                                EmailCode.expires_at > now)
    ).first()
    if row is None or row.attempts >= 5:
        raise HTTPException(400, "验证码错误或已过期，请重新获取")
    if not secrets.compare_digest(row.code_hash, digest(f"{email}:{purpose}:{code.strip()}")):
        row.attempts += 1
        session.add(row)
        session.commit()
        raise HTTPException(400, "验证码错误或已过期，请重新获取")
    session.delete(row)


# —— 会话 ——


def issue(request: Request, response: Response, session: Session, user: User) -> dict:
    session.exec(delete(UserSession).where(UserSession.expires_at <= time.time()))
    token = secrets.token_urlsafe(48)
    row = UserSession(token_hash=digest(token), user_id=user.id, csrf=secrets.token_urlsafe(32),
                      expires_at=time.time() + SESSION_DAYS * 86400)
    user.last_login = timestamp()
    session.add(row)
    session.add(user)
    session.commit()
    settings = request.app.state.settings
    # 设置了 cookie_domain 时主站与网盘子域名共用登录；先清掉旧的仅限当前主机的 Cookie。
    if settings.cookie_domain:
        response.delete_cookie(USER_COOKIE, path="/api")
    response.set_cookie(USER_COOKIE, token, max_age=SESSION_DAYS * 86400, httponly=True,
                        secure=settings.secure_cookie, samesite="lax", path="/api",
                        domain=settings.cookie_domain or None)
    return {"user": profile(user), "csrf": row.csrf}


def clear_cookie(response: Response, settings):
    response.delete_cookie(USER_COOKIE, path="/api")
    if settings.cookie_domain:
        response.delete_cookie(USER_COOKIE, path="/api", domain=settings.cookie_domain)


def current_user(request: Request, session: Session, write: bool = False) -> tuple[User, UserSession]:
    token = request.cookies.get(USER_COOKIE, "")
    row = session.get(UserSession, digest(token)) if token else None
    user = session.get(User, row.user_id) if row and row.expires_at > time.time() else None
    if user is None or user.disabled:
        raise HTTPException(401, "请先登录")
    if write:
        check_origin(request)
        if not secrets.compare_digest(
            request.headers.get("x-csrf-token", "").encode(), row.csrf.encode()
        ):
            raise HTTPException(403, "CSRF 校验失败")
    return user, row


def profile(user: User) -> dict:
    return {"id": user.id, "email": user.email, "name": user.name, "avatar": user.avatar,
            "created_at": user.created_at}


def register(request, response, session, body) -> dict:
    check_origin(request)
    if not config(session)["registrationOpen"]:
        raise HTTPException(403, "暂未开放注册")
    email = normalize_email(body.email, session)
    if session.exec(select(User).where(User.email == email)).first():
        raise HTTPException(409, "该邮箱已注册，请直接登录")
    consume_code(session, email, "register", body.code)
    user = User(id=uuid.uuid4().hex, email=email, password_hash=hash_password(body.password),
                name=body.name.strip() or email.split("@")[0], created_at=timestamp())
    session.add(user)
    return issue(request, response, session, user)


def login(request, response, session, body) -> dict:
    check_origin(request)
    email = body.email.strip().lower()
    keys = (f"user:{digest(email)}", f"ip:{digest(client_ip(request))}")
    throttle(session, keys[0], 5, "登录失败次数过多，请 15 分钟后再试")
    throttle(session, keys[1], 20, "登录失败次数过多，请 15 分钟后再试")
    user = session.exec(select(User).where(User.email == email)).first()
    valid = verify_password(user.password_hash if user else DUMMY_HASH, body.password)
    if not user or not valid:
        record_failure(session, *keys)
        raise HTTPException(401, "邮箱或密码错误")
    if user.disabled:
        raise HTTPException(403, "账户已被停用")
    second_factor(request, session, user, body.otp, keys)
    session.exec(delete(LoginAttempt).where(LoginAttempt.key == keys[0]))
    return issue(request, response, session, user)


def second_factor(request, session, user: User, otp: str, keys: tuple[str, ...]):
    """开启两步验证的账户还需验证码或恢复码；密码正确但未填写时提示前端弹出第二步。"""
    from .security import OTP_REQUIRED, verify_factor

    if not user.totp_secret:
        return
    if not otp.strip():
        raise HTTPException(403, OTP_REQUIRED)
    if not verify_factor(request.app.state.settings, user, otp):
        record_failure(session, *keys)
        raise HTTPException(401, "两步验证码或恢复码错误")
    session.add(user)


def reset_password(request, response, session, body) -> dict:
    check_origin(request)
    email = body.email.strip().lower()
    key = f"reset-2fa:{digest(email)}"
    throttle(session, key, 5, "两步验证失败次数过多，请 15 分钟后再试")
    user = session.exec(select(User).where(User.email == email)).first()
    # 邮箱验证码不能绕过两步验证；先提示输入，避免白白消耗验证码。
    if user and user.totp_secret and not body.otp.strip() and not user.disabled:
        from .security import OTP_REQUIRED

        raise HTTPException(403, OTP_REQUIRED)
    consume_code(session, email, "reset", body.code)
    if user is None or user.disabled:
        raise HTTPException(400, "验证码错误或已过期，请重新获取")
    second_factor(request, session, user, body.otp, (key,))
    user.password_hash = hash_password(body.password)
    session.exec(delete(UserSession).where(UserSession.user_id == user.id))
    session.exec(delete(LoginAttempt).where(LoginAttempt.key == f"user:{digest(email)}"))
    session.add(user)
    return issue(request, response, session, user)


def change_password(session, user: User, current: UserSession, body):
    if not verify_password(user.password_hash, body.current):
        raise HTTPException(403, "当前密码不正确")
    user.password_hash = hash_password(body.password)
    # 其他设备上的登录随之失效，当前设备保持登录。
    session.exec(delete(UserSession).where(UserSession.user_id == user.id,
                                           UserSession.token_hash != current.token_hash))
    session.add(user)
    session.commit()


def delete_account(session, user: User, password: str, media_dir):
    if not verify_password(user.password_hash, password):
        raise HTTPException(403, "密码不正确")
    for table in (Favorite, History, UserSession, ScutReading, GameScore, UserPasskey,
                  UserChallenge):
        session.exec(delete(table).where(table.user_id == user.id))
    session.exec(delete(EmailCode).where(EmailCode.email == user.email))
    remove_avatar(user, media_dir)
    session.delete(user)
    session.commit()


# —— 头像 ——


def remove_avatar(user: User, media_dir):
    if user.avatar.startswith("/media/avatars/"):
        (media_dir / "avatars" / user.avatar.rsplit("/", 1)[1]).unlink(missing_ok=True)


def save_avatar(payload: bytes, user: User, media_dir) -> str:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(payload)) as image:
                if image.format not in {"JPEG", "PNG", "WEBP", "GIF"}:
                    raise HTTPException(415, "仅支持 JPEG、PNG、WebP、GIF")
                image.seek(0)
                picture = ImageOps.exif_transpose(image).convert("RGBA")
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError,
            Image.DecompressionBombWarning):
        raise HTTPException(415, "图片损坏或尺寸过大") from None
    # 居中裁成正方形并重新编码，去除 EXIF 等元数据。
    picture = ImageOps.fit(picture, (256, 256), Image.Resampling.LANCZOS)
    folder = media_dir / "avatars"
    folder.mkdir(parents=True, exist_ok=True)
    folder.chmod(0o755)
    name = f"{secrets.token_hex(16)}.webp"
    temporary = folder / f".{name}.tmp"
    picture.save(temporary, "WEBP", quality=85)
    temporary.replace(folder / name)
    (folder / name).chmod(0o644)
    remove_avatar(user, media_dir)
    return f"/media/avatars/{name}"


# —— 收藏与浏览记录 ——


def target_title(session: Session, kind: str, slug: str) -> str | None:
    if kind == "note":
        note = session.exec(select(Note).where(Note.slug == slug, Note.visible)).first()
        return note.title if note else None
    article = session.exec(select(Article).where(Article.slug == slug)).first()
    return article.published["title"] if article and article.published else None


def entries(session: Session, model, user: User, order) -> list[dict]:
    rows = session.exec(select(model).where(model.user_id == user.id).order_by(order.desc())).all()
    result = []
    for row in rows:
        title = target_title(session, row.kind, row.slug)
        result.append({
            "kind": row.kind, "slug": row.slug, "title": title or row.title,
            "available": title is not None,
            "url": f"/{'notes' if row.kind == 'note' else 'posts'}/{row.slug}",
            "at": getattr(row, "created_at", None) or getattr(row, "viewed_at", None),
        })
    return result


def require_target(session: Session, kind: str, slug: str) -> str:
    title = target_title(session, kind, slug)
    if title is None:
        raise HTTPException(404, "内容不存在或未公开")
    return title


def add_favorite(session: Session, user: User, kind: str, slug: str):
    title = require_target(session, kind, slug)
    if session.get(Favorite, (user.id, kind, slug)) is None:
        count = session.exec(
            select(func.count()).select_from(Favorite).where(Favorite.user_id == user.id)
        ).one()
        if count >= FAVORITE_LIMIT:
            raise HTTPException(409, f"最多收藏 {FAVORITE_LIMIT} 篇")
        session.add(Favorite(user_id=user.id, kind=kind, slug=slug, title=title,
                             created_at=timestamp()))
        session.commit()


def record_view(session: Session, user: User, kind: str, slug: str):
    title = require_target(session, kind, slug)
    row = session.get(History, (user.id, kind, slug)) or History(user_id=user.id, kind=kind,
                                                                 slug=slug, viewed_at="")
    row.title, row.viewed_at = title, timestamp()
    session.add(row)
    session.commit()
    stale = session.exec(
        select(History).where(History.user_id == user.id)
        .order_by(History.viewed_at.desc()).offset(HISTORY_LIMIT)
    ).all()
    for old in stale:
        session.delete(old)
    if stale:
        session.commit()

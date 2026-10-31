"""GitHub OAuth login and explicit linking, reusing Homepage user sessions.

Only stable GitHub IDs are identities. Emails never automatically merge accounts.
Browser-bound, single-use challenges hold PKCE and short-lived pending login state;
GitHub access tokens are used only to read identity and are never persisted.
"""

import base64
import hashlib
import json
import secrets
import time
import uuid
from urllib.parse import urlencode, urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete
from sqlmodel import Session, select

from . import accounts, audit, user_security
from .auth import check_origin, digest
from .content import timestamp
from .models import GitHubIdentity, User, UserChallenge
from .schemas import SecurityProof

router = APIRouter(prefix="/api/account/github", tags=["account"])
COOKIE = "copylee_github"
PATH = "/api/account/github"
TTL = 600


class Start(SecurityProof):
    link: bool = False
    next: str = Field(default="", max_length=2048)


class Complete(BaseModel):
    state: str = Field(min_length=20, max_length=128)
    code: str = Field(default="", max_length=1024)
    otp: str = Field(default="", max_length=80)
    password: str = Field(default="", max_length=128)
    consent: bool = False


def database(request: Request):
    with Session(request.app.state.engine) as session:
        yield session


def enabled(settings) -> bool:
    return bool(settings.github_client_id and settings.github_client_secret)


def callback(settings) -> str:
    return settings.site_url + "/account/auth"


def safe_next(value: str, settings) -> str:
    if not value or "\\" in value or any(ord(char) < 32 for char in value):
        return ""
    if value.startswith("/") and not value.startswith("//"):
        return value
    try:
        target = urlsplit(value)
    except ValueError:
        return ""
    # Preserve the existing Cloud return flow without opening arbitrary subdomains.
    allowed = {urlsplit(url)[:2] for url in (settings.site_url, settings.drive_url) if url}
    return value if target[:2] in allowed and not target.username and not target.password else ""


def lock(session):
    session.connection().exec_driver_sql("BEGIN IMMEDIATE")
    session.expire_all()


def challenge(request, session, state):
    row = session.get(UserChallenge, digest(state))
    if not row or row.kind != "github" or row.expires_at <= time.time():
        raise HTTPException(400, "GitHub 登录已失效，请重新开始")
    data = json.loads(row.challenge)
    data.setdefault("link", bool(row.session_hash))  # Preserve in-flight flows across rollout.
    browser = request.cookies.get(COOKIE, "")
    if not browser or not secrets.compare_digest(data["browser"], digest(browser)):
        raise HTTPException(400, "GitHub 登录校验失败，请在原浏览器重新开始")
    return row, data


@router.post("/start")
def start(body: Start, request: Request, response: Response,
          session: Session = Depends(database)):
    check_origin(request)
    settings = request.app.state.settings
    if not enabled(settings):
        raise HTTPException(503, "GitHub 登录尚未配置")
    lock(session)
    ip_key = "github-start:" + digest(accounts.client_ip(request))
    accounts.throttle(session, ip_key, 30, "请求过多，请 15 分钟后再试")
    user_id, session_hash = "", ""
    if body.link:
        user, current = accounts.current_user(request, session, write=True)
        user_security.reauthenticate(request, session, user, body)
        if session.exec(select(GitHubIdentity).where(GitHubIdentity.user_id == user.id)).first():
            raise HTTPException(409, "该账户已绑定 GitHub，请先解除绑定")
        user_id, session_hash = user.id, current.token_hash
    state, browser, verifier = (secrets.token_urlsafe(32) for _ in range(3))
    session.exec(delete(UserChallenge).where(UserChallenge.kind == "github",
                                            UserChallenge.expires_at <= time.time()))
    session.add(UserChallenge(
        id=digest(state), kind="github", user_id=user_id, session_hash=session_hash,
        challenge=json.dumps({"browser": digest(browser), "verifier": verifier,
                              "next": safe_next(body.next, settings), "stage": "code",
                              "link": body.link}),
        expires_at=time.time() + TTL,
    ))
    accounts.record_failure(session, ip_key)  # Count starts, including successful ones.
    response.headers["Cache-Control"] = "no-store"
    response.set_cookie(COOKIE, browser, max_age=TTL, httponly=True,
                        secure=settings.secure_cookie, samesite="lax", path=PATH)
    params = {"client_id": settings.github_client_id, "redirect_uri": callback(settings),
              "scope": "user:email", "state": state, "code_challenge_method": "S256",
              "code_challenge": base64.urlsafe_b64encode(
                  hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()}
    return {"url": "https://github.com/login/oauth/authorize?" + urlencode(params)}


def fetch_identity(settings, code: str, verifier: str) -> dict:
    """Never include provider response bodies or tokens in errors/audit logs."""
    try:
        with httpx.Client(timeout=15, follow_redirects=False) as client:
            result = client.post("https://github.com/login/oauth/access_token",
                                 headers={"Accept": "application/json"}, data={
                                     "client_id": settings.github_client_id,
                                     "client_secret": settings.github_client_secret,
                                     "redirect_uri": callback(settings), "code": code,
                                     "code_verifier": verifier,
                                 })
            result.raise_for_status()
            token = result.json().get("access_token")
            if not isinstance(token, str) or not token:
                raise ValueError("missing token")
            headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"}
            result = client.get("https://api.github.com/user", headers=headers)
            result.raise_for_status()
            user = result.json()
            if type(user.get("id")) is not int or user["id"] <= 0 or not user.get("login"):
                raise ValueError("invalid identity")
            result = client.get("https://api.github.com/user/emails", headers=headers)
            result.raise_for_status()
            emails = result.json()
            verified = [item for item in emails if item.get("verified") is True]
            verified.sort(key=lambda item: item.get("primary") is True, reverse=True)
            return {"id": str(user["id"]), "login": str(user["login"])[:80],
                    "name": str(user.get("name") or user["login"])[:40],
                    "email": str(verified[0]["email"]).lower() if verified else ""}
    except (httpx.HTTPError, ValueError, TypeError, KeyError, AttributeError):
        raise HTTPException(502, "暂时无法完成 GitHub 验证，请重新开始登录") from None


def discard(session, row, response):
    session.delete(row)
    session.commit()
    response.delete_cookie(COOKIE, path=PATH)


@router.post("/complete")
def complete(body: Complete, request: Request, response: Response,
             session: Session = Depends(database)):
    check_origin(request)
    settings = request.app.state.settings
    response.headers["Cache-Control"] = "no-store"
    if not enabled(settings):
        raise HTTPException(503, "GitHub 登录尚未配置")
    lock(session)
    row, data = challenge(request, session, body.state)
    if data["stage"] == "code":
        if not body.code:
            raise HTTPException(400, "缺少 GitHub 授权码，请重新开始")
        verifier = data.pop("verifier")
        data["stage"] = "exchanging"
        row.challenge = json.dumps(data)
        session.add(row)
        session.commit()  # Claim once before network I/O; no database lock over the network.
        try:
            identity = fetch_identity(settings, body.code, verifier)
        except HTTPException:
            lock(session)
            row = session.get(UserChallenge, digest(body.state))
            if row:
                discard(session, row, response)
            audit.record("account.github_login", request, ok=False, reason="provider_error")
            raise
        lock(session)
        row, data = challenge(request, session, body.state)
        data.update(stage="identity", identity=identity)
        # Once known, associate pending TOTP logins with the user too, so existing
        # security-factor changes/reset revoke these challenges with the others.
        if not data["link"]:
            binding = session.get(GitHubIdentity, identity["id"])
            if binding:
                row.user_id = binding.user_id
        row.challenge = json.dumps(data)
        session.add(row)
        session.commit()
        lock(session)
        row, data = challenge(request, session, body.state)
    if data["stage"] != "identity":
        raise HTTPException(409, "GitHub 登录正在处理中，请稍后重新开始")
    identity = data["identity"]
    binding = session.get(GitHubIdentity, identity["id"])
    if data["link"]:
        user, current = accounts.current_user(request, session, write=True)
        if user.id != row.user_id or current.token_hash != row.session_hash:
            discard(session, row, response)
            raise HTTPException(403, "绑定会话已变更，请重新开始")
        other = session.exec(select(GitHubIdentity).where(GitHubIdentity.user_id == user.id)).first()
        if binding or other:
            discard(session, row, response)
            raise HTTPException(409, "GitHub 或本站账户已绑定，请先解除原有绑定")
        session.add(GitHubIdentity(github_id=identity["id"], user_id=user.id,
                                   login=identity["login"], created_at=timestamp()))
        user_security.revoke_others(session, user, current)
        # revoke_others also removes this challenge.
        session.commit()
        response.delete_cookie(COOKIE, path=PATH)
        audit.record("account.github_link", request, user=user.id, ok=True)
        return {"linked": True, "next": "/account?tab=settings"}
    if binding:
        user = session.get(User, binding.user_id)
        if row.user_id and binding.user_id != row.user_id:
            discard(session, row, response)
            raise HTTPException(403, "GitHub 绑定已变更，请重新开始")
        if user is None or user.disabled:
            discard(session, row, response)
            raise HTTPException(403, "账户已被停用")
        key = "github-2fa:" + digest(user.id)
        accounts.throttle(session, key, 5, "两步验证失败次数过多，请 15 分钟后再试")
        accounts.second_factor(request, session, user, body.otp, (key,))
        binding.login = identity["login"]
        session.add(binding)
    else:
        if not accounts.config(session)["registrationOpen"]:
            discard(session, row, response)
            raise HTTPException(403, "暂未开放注册；已有账户请先用邮箱或 Passkey 登录后绑定 GitHub")
        if not identity["email"]:
            discard(session, row, response)
            raise HTTPException(403, "GitHub 没有已验证邮箱，请验证邮箱后重新开始")
        email = accounts.normalize_email(identity["email"], session, check_domain=False)
        if session.exec(select(User).where(User.email == email)).first():
            discard(session, row, response)
            raise HTTPException(409, "该邮箱已有账户，请先登录本站，再在账户设置中绑定 GitHub")
        email = accounts.normalize_email(email, session)
        if not body.consent or not body.password:
            return {"registration_required": True, "email": email, "name": identity["name"]}
        if len(body.password) < 8:
            raise HTTPException(422, "密码至少需要 8 个字符")
        user = User(id=uuid.uuid4().hex, email=email, name=identity["name"],
                    password_hash=accounts.hash_password(body.password), created_at=timestamp())
        session.add(user)
        session.flush()
        session.add(GitHubIdentity(github_id=identity["id"], user_id=user.id,
                                   login=identity["login"], created_at=timestamp()))
    destination = data["next"]
    session.delete(row)
    result = accounts.issue(request, response, session, user)
    response.delete_cookie(COOKIE, path=PATH)
    audit.record("account.github_login", request, user=user.id, ok=True)
    return {**result, "next": destination}


@router.get("")
def status(request: Request, response: Response, session: Session = Depends(database)):
    user, _ = accounts.current_user(request, session)
    binding = session.exec(select(GitHubIdentity).where(GitHubIdentity.user_id == user.id)).first()
    response.headers["Cache-Control"] = "no-store"
    return {"enabled": enabled(request.app.state.settings),
            "login": binding.login if binding else None}


@router.post("/disconnect")
def disconnect(body: SecurityProof, request: Request, session: Session = Depends(database)):
    user, current = user_security.locked_user(request, session)
    user_security.reauthenticate(request, session, user, body)
    session.exec(delete(GitHubIdentity).where(GitHubIdentity.user_id == user.id))
    user_security.revoke_others(session, user, current)
    session.commit()
    audit.record("account.github_unlink", request, user=user.id, ok=True)
    return {"ok": True}

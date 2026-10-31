"""First-party SSO for the Agent app. No shared-domain app cookies or implicit execution grants."""

import base64
import hashlib
import json
import secrets
import time
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete
from sqlmodel import Session

from . import accounts, audit
from .auth import digest
from .models import AgentSession, User, UserChallenge, UserSession

router = APIRouter(prefix="/api/agent", tags=["agent-sso"])


def database(request: Request):
    with Session(request.app.state.engine) as session:
        yield session


def settings_for(request):
    settings = request.app.state.settings
    if not settings.agent_url or len(settings.agent_client_secret) < 32:
        raise HTTPException(503, "Agent 登录尚未配置")
    return settings


def client(request):
    settings = settings_for(request)
    supplied = request.headers.get("x-agent-client-secret", "")
    if not secrets.compare_digest(supplied.encode(), settings.agent_client_secret.encode()):
        raise HTTPException(401, "应用认证失败")
    return settings


class Exchange(BaseModel):
    code: str = Field(min_length=20, max_length=128)
    verifier: str = Field(min_length=43, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")


class Token(BaseModel):
    token: str = Field(min_length=20, max_length=128)


@router.get("/authorize")
def authorize(request: Request, state: str = Query(min_length=20, max_length=128,
                                                 pattern=r"^[A-Za-z0-9_-]+$"),
              code_challenge: str = Query(pattern=r"^[A-Za-z0-9_-]{43}$"),
              session: Session = Depends(database)):
    settings = settings_for(request)
    try:
        user, parent = accounts.current_user(request, session)
    except HTTPException as exc:
        if exc.status_code != 401:
            raise
        next_path = "/api/agent/authorize?" + urlencode({"state": state,
                                                        "code_challenge": code_challenge})
        return RedirectResponse("/account?" + urlencode({"next": next_path}), status_code=302)
    key = "agent-sso:" + digest(user.id)
    accounts.throttle(session, key, 30, "登录请求过多，请稍后重试")
    code = secrets.token_urlsafe(32)
    session.exec(delete(UserChallenge).where(UserChallenge.kind == "agent-sso",
                                            UserChallenge.expires_at <= time.time()))
    session.add(UserChallenge(id=digest(code), kind="agent-sso", user_id=user.id,
                              session_hash=parent.token_hash, expires_at=time.time() + 60,
                              challenge=json.dumps({"pkce": code_challenge})))
    accounts.record_failure(session, key)
    audit.record("agent.authorize", request, user=user.id, ok=True)
    return RedirectResponse(settings.agent_url + "/auth/callback?" + urlencode({
        "code": code, "state": state}), status_code=302,
        headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})


@router.post("/exchange")
def exchange(body: Exchange, request: Request, session: Session = Depends(database)):
    client(request)
    session.connection().exec_driver_sql("BEGIN IMMEDIATE")
    row = session.get(UserChallenge, digest(body.code))
    if not row or row.kind != "agent-sso" or row.expires_at <= time.time():
        raise HTTPException(400, "授权码已失效")
    challenge = base64.urlsafe_b64encode(hashlib.sha256(body.verifier.encode()).digest())
    if not secrets.compare_digest(json.loads(row.challenge)["pkce"],
                                  challenge.rstrip(b"=").decode()):
        raise HTTPException(400, "授权码校验失败")
    parent = session.get(UserSession, row.session_hash)
    user = session.get(User, row.user_id)
    if not parent or parent.user_id != row.user_id or parent.expires_at <= time.time() \
            or not user or user.disabled:
        raise HTTPException(401, "本站登录已失效")
    session.exec(delete(AgentSession).where(AgentSession.expires_at <= time.time()))
    token = secrets.token_urlsafe(48)
    expires = min(parent.expires_at, time.time() + 8 * 3600)
    session.add(AgentSession(token_hash=digest(token), user_id=user.id,
                             parent_hash=parent.token_hash, expires_at=expires))
    session.delete(row)
    session.commit()
    audit.record("agent.session", request, user=user.id, ok=True)
    return {"token": token, "expires_at": expires}


@router.post("/introspect")
def introspect(body: Token, request: Request, session: Session = Depends(database)):
    client(request)
    row = session.get(AgentSession, digest(body.token))
    parent = session.get(UserSession, row.parent_hash) if row else None
    user = session.get(User, row.user_id) if row else None
    if not row or row.expires_at <= time.time() or not parent \
            or parent.expires_at <= time.time() or not user or user.disabled:
        raise HTTPException(401, "Agent 登录已失效")
    # Phase one is admin-only execution. A GitHub identity never grants a role.
    return {"user": {"id": user.id, "name": user.name}, "admin": user.is_admin,
            "can_execute": user.is_admin, "expires_at": row.expires_at}


@router.post("/revoke")
def revoke(body: Token, request: Request, session: Session = Depends(database)):
    client(request)
    row = session.get(AgentSession, digest(body.token))
    if row:
        session.delete(row)
        session.commit()
    return {"ok": True}

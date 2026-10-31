import json
import time
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from urllib.parse import parse_qs, urlsplit

import httpx
import pyotp
import pytest
from sqlmodel import Session, select
from test_content import ADMIN_EMAIL, ORIGIN, PASSWORD

from app import github_oauth, user_security
from app.auth import digest
from app.models import Content, GitHubIdentity, User, UserChallenge
from app.security import cipher

HEADERS = {"Origin": ORIGIN}


@pytest.fixture
def oauth(server, monkeypatch):
    client, app, settings = server
    settings.github_client_id = "test-client"
    settings.github_client_secret = "test-secret"
    identity = {"id": "711", "login": "reader", "email": "reader@qq.com", "name": "Reader"}
    calls = []

    def fetch(settings, code, verifier):
        calls.append((code, verifier))
        return dict(identity)

    monkeypatch.setattr(github_oauth, "fetch_identity", fetch)
    return client, app, settings, identity, calls


def start(client, **body):
    response = client.post("/api/account/github/start", json=body, headers=HEADERS)
    assert response.status_code == 200, response.text
    return parse_qs(urlsplit(response.json()["url"]).query)["state"][0]


def finish(client, state, **body):
    return client.post("/api/account/github/complete", headers=HEADERS,
                       json={"state": state, "code": "provider-code", **body})


def open_registration(app):
    with Session(app.state.engine) as session:
        row = session.get(Content, "accounts")
        row.value = {**row.value, "registrationOpen": True}
        session.add(row)
        session.commit()


def bound(app, totp=False):
    with Session(app.state.engine) as session:
        user = session.exec(select(User).where(User.email == ADMIN_EMAIL)).one()
        if totp:
            secret = pyotp.random_base32()
            user.totp_secret = cipher(app.state.settings, create=True).encrypt(secret.encode()).decode()
            session.add(user)
        session.add(GitHubIdentity(github_id="711", user_id=user.id, login="old", created_at="now"))
        session.commit()
        return secret if totp else user.id


def user_login(client):
    result = client.post("/api/account/login", headers=HEADERS,
                         json={"email": ADMIN_EMAIL, "password": PASSWORD})
    assert result.status_code == 200, result.text
    return {**HEADERS, "X-CSRF-Token": result.json()["csrf"]}


def test_disabled_and_origin(server):
    client, _, _ = server
    assert client.get("/api/account/config").json()["githubEnabled"] is False
    assert client.post("/api/account/github/start", headers=HEADERS, json={}).status_code == 503
    assert client.post("/api/account/github/start", json={}).status_code == 403


def test_pkce_browser_state_and_replay(oauth):
    client, app, settings, _, calls = oauth
    uid = bound(app)
    response = client.post("/api/account/github/start", headers=HEADERS, json={"next": "//evil.test"})
    query = parse_qs(urlsplit(response.json()["url"]).query)
    assert query["redirect_uri"] == [ORIGIN + "/account/auth"]
    assert query["scope"] == ["user:email"] and query["code_challenge_method"] == ["S256"]
    assert len(query["code_challenge"][0]) == 43
    assert "HttpOnly" in response.headers["set-cookie"]
    state = query["state"][0]
    assert finish(client, "wrong-state-long-enough").status_code == 400
    browser = client.cookies.get(github_oauth.COOKIE)
    client.cookies.clear()
    assert finish(client, state).status_code == 400
    client.cookies.set(github_oauth.COOKIE, browser)
    response = finish(client, state)
    assert response.status_code == 200 and response.json()["user"]["id"] == uid
    assert response.json()["next"] == ""
    assert len(calls) == 1 and len(calls[0][1]) == 43
    assert finish(client, state).status_code == 400
    # Original admin and feature flags are retained, not assigned by GitHub profile.
    assert client.get("/api/account/me").json()["features"]["admin"] is True


def test_closed_registration_and_no_automatic_email_merge(oauth):
    client, app, _, identity, _ = oauth
    assert finish(client, start(client)).status_code == 403
    open_registration(app)
    identity["email"] = ADMIN_EMAIL
    result = finish(client, start(client))
    assert result.status_code == 409 and "先登录" in result.json()["detail"]
    with Session(app.state.engine) as session:
        assert session.exec(select(GitHubIdentity)).all() == []


def test_registration_consent_password_and_features(oauth):
    client, app, _, _, calls = oauth
    open_registration(app)
    state = start(client, next="/notes")
    response = finish(client, state)
    assert response.json()["registration_required"] is True
    assert client.get("/api/account/me").status_code == 401
    assert finish(client, state, consent=True, password="short").status_code == 422
    result = finish(client, state, consent=True, password="new-password-123")
    assert result.status_code == 200 and result.json()["next"] == "/notes"
    user = result.json()["user"]
    features = client.get("/api/account/me").json()["features"]
    assert not features["admin"] and not features["drive"] and not features["images"]
    assert len(calls) == 1
    # The supplied site password also works for existing clients and security settings.
    client.cookies.clear()
    result = client.post("/api/account/login", headers=HEADERS,
                         json={"email": user["email"], "password": "new-password-123"})
    assert result.status_code == 200


@pytest.mark.parametrize("email,status", [("", 403), ("reader@unsupported.example", 422)])
def test_registration_email_rules(oauth, email, status):
    client, app, _, identity, _ = oauth
    open_registration(app)
    identity["email"] = email
    assert finish(client, start(client), consent=True, password="new-password-123").status_code == status


def test_link_requires_reauthentication_and_original_session(oauth):
    client, _, _, _, _ = oauth
    headers = user_login(client)
    assert client.post("/api/account/github/start", headers=HEADERS,
                       json={"link": True, "password": PASSWORD}).status_code == 403
    assert client.post("/api/account/github/start", headers=headers,
                       json={"link": True, "password": "wrong"}).status_code == 403
    result = client.post("/api/account/github/start", headers=headers,
                         json={"link": True, "password": PASSWORD})
    state = parse_qs(urlsplit(result.json()["url"]).query)["state"][0]
    headers = user_login(client)  # Same user, different session must not complete the binding.
    result = client.post("/api/account/github/complete", headers=headers,
                         json={"state": state, "code": "code"})
    assert result.status_code == 403


def test_link_login_unlink_and_delete(oauth):
    client, app, _, _, _ = oauth
    headers = user_login(client)
    result = client.post("/api/account/github/start", headers=headers,
                         json={"link": True, "password": PASSWORD})
    state = parse_qs(urlsplit(result.json()["url"]).query)["state"][0]
    result = client.post("/api/account/github/complete", headers=headers,
                         json={"state": state, "code": "code"})
    assert result.status_code == 200 and result.json()["linked"]
    assert client.get("/api/account/github").json()["login"] == "reader"
    client.cookies.clear()
    result = finish(client, start(client))
    assert result.status_code == 200
    headers = {**HEADERS, "X-CSRF-Token": result.json()["csrf"]}
    assert client.post("/api/account/github/disconnect", headers=headers,
                       json={"password": "wrong"}).status_code == 403
    assert client.post("/api/account/github/disconnect", headers=headers,
                       json={"password": PASSWORD}).status_code == 200
    assert client.get("/api/account/github").json()["login"] is None
    bound(app)
    # Cascading deletion also removes the provider identity.
    with Session(app.state.engine) as session:
        user = session.exec(select(User).where(User.email == ADMIN_EMAIL)).one()
        session.delete(user)
        session.commit()
        assert not session.exec(select(GitHubIdentity)).all()


def test_totp_required_retry_does_not_exchange_code_twice(oauth):
    client, app, _, _, calls = oauth
    secret = bound(app, totp=True)
    state = start(client)
    result = finish(client, state)
    assert result.status_code == 403 and result.json()["detail"] == "请输入两步验证码或恢复码"
    assert client.get("/api/account/me").status_code == 401
    assert finish(client, state, otp="wrong").status_code == 401
    result = finish(client, state, code="", otp=pyotp.TOTP(secret).now())
    assert result.status_code == 200 and len(calls) == 1


def test_totp_bruteforce_and_disabled_user(oauth):
    client, app, _, _, _ = oauth
    bound(app, totp=True)
    state = start(client)
    for _ in range(5):
        assert finish(client, state, otp="wrong").status_code == 401
    assert finish(client, state, otp="wrong").status_code == 429
    with Session(app.state.engine) as session:
        user = session.exec(select(User).where(User.email == ADMIN_EMAIL)).one()
        user.disabled = True
        session.add(user)
        session.commit()
    assert finish(client, start(client)).status_code == 403


def test_security_reset_revokes_pending_oauth_login(oauth):
    client, app, _, _, _ = oauth
    bound(app, totp=True)
    state = start(client)
    assert finish(client, state).status_code == 403
    with Session(app.state.engine) as session:
        user = session.exec(select(User).where(User.email == ADMIN_EMAIL)).one()
        assert session.get(UserChallenge, digest(state)).user_id == user.id
        user_security.reset(session, user)
    assert finish(client, state).status_code == 400


def test_expired_inflight_and_provider_failure(oauth, monkeypatch):
    client, app, _, _, _ = oauth
    state = start(client)
    with Session(app.state.engine) as session:
        row = session.get(UserChallenge, digest(state))
        row.expires_at = time.time() - 1
        session.add(row)
        session.commit()
    assert finish(client, state).status_code == 400
    state = start(client)
    with Session(app.state.engine) as session:
        row = session.get(UserChallenge, digest(state))
        data = json.loads(row.challenge)
        data["stage"] = "exchanging"
        row.challenge = json.dumps(data)
        session.add(row)
        session.commit()
    assert finish(client, state).status_code == 409

    def fail(*args):
        from fastapi import HTTPException
        raise HTTPException(502, "provider unavailable")

    monkeypatch.setattr(github_oauth, "fetch_identity", fail)
    state = start(client)
    assert finish(client, state).status_code == 502
    assert finish(client, state).status_code == 400


def test_provider_exchange_contract(server, monkeypatch):
    _, _, settings = server
    requests = []

    def handler(request):
        requests.append(request)
        if request.url.path.endswith("access_token"):
            assert b"code_verifier=verifier" in request.content
            return httpx.Response(200, json={"access_token": "private-token"})
        assert request.headers["Authorization"] == "Bearer private-token"
        if request.url.path == "/user":
            return httpx.Response(200, json={"id": 711, "login": "reader", "name": None})
        return httpx.Response(200, json=[
            {"email": "fake@qq.com", "primary": True, "verified": False},
            {"email": "secondary@qq.com", "primary": False, "verified": True},
            {"email": "Primary@qq.com", "primary": True, "verified": True},
        ])

    original = httpx.Client
    monkeypatch.setattr(github_oauth.httpx, "Client",
                        lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    result = github_oauth.fetch_identity(settings, "code", "verifier")
    assert result["email"] == "primary@qq.com" and result["id"] == "711"
    assert len(requests) == 3 and "private-token" not in str(result)


def test_safe_return_targets(server):
    _, _, settings = server
    settings.drive_url = "https://cloud.copylee.cn"
    for value in ("//evil.test", "/\\evil.test", "https://evil.test", "https://ai.copylee.cn",
                  "https://[", "/\x00invalid"):
        assert github_oauth.safe_next(value, settings) == ""
    assert github_oauth.safe_next("https://cloud.copylee.cn/docs", settings).endswith("/docs")


def test_start_rate_limit(oauth):
    client, _, _, _, _ = oauth
    for _ in range(30):
        start(client)
    assert client.post("/api/account/github/start", headers=HEADERS, json={}).status_code == 429


def test_concurrent_callback_claims_code_once(oauth, monkeypatch):
    client, app, _, identity, _ = oauth
    bound(app)
    entered, release = Event(), Event()
    calls = []

    def fetch(*args):
        calls.append(True)
        entered.set()
        assert release.wait(5)
        return dict(identity)

    monkeypatch.setattr(github_oauth, "fetch_identity", fetch)
    state = start(client)
    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(finish, client, state)
        assert entered.wait(5)
        try:
            second = finish(client, state)
            assert second.status_code == 409
        finally:
            release.set()
        assert first.result().status_code == 200
    assert len(calls) == 1


def test_callback_page_headers(server):
    client, _, settings = server
    settings.static_dir.mkdir()
    (settings.static_dir / "index.html").write_text("<html>OAuth</html>")
    response = client.get("/account/auth?code=private&state=private")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert response.headers["x-robots-tag"] == "noindex"

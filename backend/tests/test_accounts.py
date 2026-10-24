import json
from io import BytesIO

import pytest
from PIL import Image
from test_content import ORIGIN, login, server  # noqa: F401

from app import accounts
from app.cli import backup, restore

EMAIL = "reader@qq.com"
PASSWORD = "reader-password-1"


@pytest.fixture
def site(server, monkeypatch):  # noqa: F811
    client, app, settings = server
    sent = []
    monkeypatch.setattr(accounts, "send_mail",
                        lambda value, settings, to, subject, text, html: sent.append((to, text)))
    admin = login(client)
    config = client.get("/api/admin/accounts", headers=admin).json()["config"]
    config.update(registrationOpen=True, smtpPassword="smtp-app-code")
    config["smtp"].update(username="me@qq.com")
    config.pop("hasSmtpPassword")
    saved = client.put("/api/admin/accounts/config", json=config, headers=admin)
    assert saved.status_code == 200, saved.text
    assert saved.json()["hasSmtpPassword"] is True and "smtpPassword" not in saved.json()
    note = {"title": "可收藏的笔记", "slug": "fav-note", "markdown": "正文内容足够长一些。"}
    assert client.post("/api/admin/notes", json=note, headers=admin).status_code == 201
    client.post("/api/auth/logout", headers=admin)
    return client, app, settings, sent


def code_for(sent):
    return sent[-1][1].split("验证码：")[1][:6]


def test_esa_captcha_blocks_origin_bypass_before_sending(site):
    client, _, settings, sent = site
    settings.email_captcha_enabled = True
    settings.esa_origin_secret = "test-only-origin-secret"
    body = {"email": EMAIL, "purpose": "register"}
    for extra in ({}, {"captcha-verify-param": "forged-ticket"},
                  {"captcha-verify-param": "forged-ticket", "X-Captcha-Verify-Code": "T001",
                   "X-Copylee-Esa-Origin": "forged-secret"},
                  {"X-Copylee-Esa-Origin": settings.esa_origin_secret}):
        response = client.post("/api/account/code", json=body,
                               headers={"Origin": ORIGIN, **extra})
        assert response.status_code == 403
        assert not sent
    public = client.get("/api/account/config").json()
    assert public["captcha"]["enabled"] is True
    assert settings.esa_origin_secret not in str(public)
    encoded = client.post("/api/account/%63ode", json=body, headers={
        "Origin": ORIGIN, "captcha-verify-param": "ticket",
        "X-Copylee-Esa-Origin": settings.esa_origin_secret,
    })
    assert encoded.status_code == 403 and not sent
    # 只有匹配 ESA 规则、已验签的请求才能获得回源密钥。
    response = client.post("/api/account/code", json=body, headers={
        "Origin": ORIGIN, "captcha-verify-param": "edge-verified-ticket",
        "X-Copylee-Esa-Origin": settings.esa_origin_secret,
    })
    assert response.status_code == 200 and len(sent) == 1


def test_esa_missing_secret_fails_closed(site):
    client, _, settings, sent = site
    settings.email_captcha_enabled = True
    settings.esa_origin_secret = ""
    response = client.post("/api/account/code", json={"email": EMAIL, "purpose": "register"},
                           headers={"Origin": ORIGIN, "captcha-verify-param": "ticket"})
    assert response.status_code == 503 and not sent


def signup(client, sent, email=EMAIL):
    response = client.post("/api/account/code", json={"email": email, "purpose": "register"},
                           headers={"Origin": ORIGIN})
    assert response.status_code == 200, response.text
    response = client.post("/api/account/register", headers={"Origin": ORIGIN}, json={
        "email": email, "code": code_for(sent), "name": "读者", "password": PASSWORD,
    })
    assert response.status_code == 200, response.text
    return {"Origin": ORIGIN, "X-CSRF-Token": response.json()["csrf"]}


def test_registration_rules(site):
    client, _, _, sent = site
    origin = {"Origin": ORIGIN}
    assert client.get("/api/account/config").json()["registrationOpen"] is True
    bad = client.post("/api/account/code", json={"email": "a@example.org", "purpose": "register"},
                      headers=origin)
    assert bad.status_code == 422 and "常见邮箱" in bad.json()["detail"]
    assert client.post("/api/account/code", json={"email": EMAIL, "purpose": "register"},
                       headers=origin).status_code == 200
    again = client.post("/api/account/code", json={"email": EMAIL, "purpose": "register"},
                        headers=origin)
    assert again.status_code == 429
    wrong = client.post("/api/account/register", headers=origin, json={
        "email": EMAIL, "code": "000000" if code_for(sent) != "000000" else "111111",
        "password": PASSWORD})
    assert wrong.status_code == 400
    assert client.post("/api/account/register", headers=origin, json={
        "email": EMAIL, "code": code_for(sent), "password": "short"}).status_code == 422
    ok = client.post("/api/account/register", headers=origin, json={
        "email": EMAIL.upper(), "code": code_for(sent), "password": PASSWORD})
    assert ok.status_code == 200, ok.text
    assert "HttpOnly" in ok.headers["set-cookie"]
    assert ok.json()["user"]["name"] == "reader"
    # 验证码只能使用一次
    assert client.post("/api/account/register", headers=origin, json={
        "email": EMAIL, "code": code_for(sent), "password": PASSWORD}).status_code == 409


def test_login_profile_and_password(site):
    client, _, _, sent = site
    headers = signup(client, sent)
    assert client.get("/api/account/me").json()["user"]["email"] == EMAIL
    assert client.put("/api/account/profile", json={"name": "新名字"},
                      headers={"Origin": ORIGIN}).status_code == 403  # 缺少 CSRF
    assert client.put("/api/account/profile", json={"name": "新名字"},
                      headers=headers).json()["name"] == "新名字"
    client.post("/api/account/logout", headers=headers)
    assert client.get("/api/account/me").status_code == 401
    for _ in range(5):
        assert client.post("/api/account/login", headers={"Origin": ORIGIN},
                           json={"email": EMAIL, "password": "wrong-pass"}).status_code == 401
    assert client.post("/api/account/login", headers={"Origin": ORIGIN},
                       json={"email": EMAIL, "password": PASSWORD}).status_code == 429


def test_reset_password_does_not_reveal_accounts(site):
    client, _, _, sent = site
    origin = {"Origin": ORIGIN}
    signup(client, sent)
    count = len(sent)
    unknown = client.post("/api/account/code", json={"email": "nobody@163.com", "purpose": "reset"},
                          headers=origin)
    assert unknown.status_code == 200 and len(sent) == count
    assert client.post("/api/account/code", json={"email": EMAIL, "purpose": "reset"},
                       headers=origin).status_code == 200
    reset = client.post("/api/account/reset", headers=origin, json={
        "email": EMAIL, "code": code_for(sent), "password": "brand-new-password"})
    assert reset.status_code == 200, reset.text
    assert client.post("/api/account/login", headers=origin,
                       json={"email": EMAIL, "password": "brand-new-password"}).status_code == 200


def test_favorites_history_avatar_and_delete(site):
    client, app, settings, sent = site
    headers = signup(client, sent)
    target = {"kind": "note", "slug": "fav-note"}
    assert client.post("/api/account/favorites", json=target, headers=headers).status_code == 200
    assert client.post("/api/account/favorites", json={"kind": "post", "slug": "missing"},
                       headers=headers).status_code == 404
    assert client.get("/api/account/favorites/check", params=target).json()["favorite"] is True
    items = client.get("/api/account/favorites").json()["items"]
    assert items[0]["title"] == "可收藏的笔记" and items[0]["url"] == "/notes/fav-note"
    assert client.post("/api/account/history", json=target, headers=headers).status_code == 200
    assert client.post("/api/account/history", json=target, headers=headers).status_code == 200
    assert len(client.get("/api/account/history").json()["items"]) == 1
    assert client.post("/api/account/favorites/remove", json=target, headers=headers).json() == {
        "favorite": False}

    buffer = BytesIO()
    Image.new("RGB", (640, 320), "red").save(buffer, "PNG")
    avatar = client.post("/api/account/avatar", content=buffer.getvalue(),
                         headers={**headers, "Content-Type": "image/png"})
    assert avatar.status_code == 200, avatar.text
    path = avatar.json()["avatar"]
    with Image.open(settings.media_dir / path.removeprefix("/media/")) as image:
        assert image.size == (256, 256) and image.format == "WEBP"
    assert client.post("/api/account/avatar", content=b"not an image",
                       headers=headers).status_code == 415
    restored = settings.data_dir.parent / "restored"
    restore(backup(settings), restored)
    assert (restored / path.removeprefix("/")).is_file() or (
        restored / "media" / "avatars" / path.rsplit("/", 1)[1]).is_file()

    assert client.post("/api/account/delete", json={"password": "wrong"},
                       headers=headers).status_code == 403
    assert client.post("/api/account/delete", json={"password": PASSWORD},
                       headers=headers).status_code == 200
    assert not (settings.media_dir / path.removeprefix("/media/")).exists()
    assert client.get("/api/account/me").status_code == 401


def test_admin_manages_users(site):
    client, _, _, sent = site
    signup(client, sent)
    admin = login(client)
    users = client.get("/api/admin/accounts", headers=admin).json()["users"]
    assert users[0]["email"] == EMAIL
    assert client.post(f"/api/admin/accounts/users/{users[0]['id']}/state", json={"disabled": True},
                       headers=admin).status_code == 200
    assert client.get("/api/account/me").status_code == 401
    assert client.post("/api/account/login", headers={"Origin": ORIGIN},
                       json={"email": EMAIL, "password": PASSWORD}).status_code == 403
    config = client.get("/api/admin/accounts", headers=admin).json()["config"]
    config.pop("hasSmtpPassword")
    config["registrationOpen"] = False
    assert client.put("/api/admin/accounts/config", json=config, headers=admin).status_code == 200
    assert client.post("/api/account/code", json={"email": "new@163.com", "purpose": "register"},
                       headers={"Origin": ORIGIN}).status_code == 403


def test_scut_reading_follows_the_account(site):
    client, _, _, sent = site
    headers = signup(client, sent)
    assert client.get("/api/account/scut").json()["state"] is None
    state = {"baseline": "2026-10-01T00:00:00Z", "read": ["a", "b"], "unread": ["c"]}
    assert client.put("/api/account/scut", json={"state": state}, headers=headers).status_code == 200
    assert client.get("/api/account/scut").json()["state"] == state
    too_long = {"baseline": "x", "read": ["x" * 101], "unread": []}
    assert client.put("/api/account/scut", json={"state": too_long},
                      headers=headers).status_code == 422
    client.post("/api/account/logout", headers=headers)
    assert client.get("/api/account/scut").status_code == 401


def test_audit_log_records_account_events(site):
    client, _, settings, sent = site
    headers = signup(client, sent)
    client.post("/api/account/logout", headers=headers)
    client.post("/api/account/login", headers={"Origin": ORIGIN},
                json={"email": EMAIL, "password": "wrong-pass"})
    lines = (settings.audit_dir / "audit.log").read_text(encoding="utf-8").splitlines()
    events = [json.loads(line) for line in lines]
    assert [(e["event"], e["ok"]) for e in events if e["event"].startswith("account.")] == [
        ("account.register", True), ("account.logout", True), ("account.login", False)]
    assert events[-1]["email"] == EMAIL and events[-1]["status"] == 401
    assert all("password" not in line for line in lines)
    assert any(e["event"] == "admin.login" and e["ok"] for e in events)


def test_privacy_page_and_police_number(site):
    client, _, _, _ = site
    page = client.get("/privacy")
    assert page.status_code == 200 and "日志留存" in page.text and "六个月" in page.text
    admin = login(client)
    current = client.get("/api/admin/site", headers=admin).json()
    current["site"]["police"] = {"text": "粤公网安备", "code": "44011302006057"}
    assert current["site"]["police"]  # 旧格式：文字与编号分开
    saved = client.put("/api/admin/site", headers=admin,
                       json={"revision": current["revision"], "site": current["site"]})
    assert saved.status_code == 200, saved.text
    police = client.get("/api/site").json()["site"]["police"]
    assert police == {"text": "粤公网安备44011302006057号", "code": "44011302006057"}
    html = client.get("/posts").text
    assert "code=44011302006057" in html and "beian-police.png" in html and "/privacy" in html

import hashlib
import json
import struct
import time

import cbor2
import pyotp
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from sqlmodel import Session
from test_accounts import site  # noqa: F401
from test_content import ADMIN_EMAIL, ORIGIN, PASSWORD, login
from webauthn.helpers import bytes_to_base64url

from app.auth import revoke_admin, set_admin
from app.models import User

ANON = {"Origin": ORIGIN}


def post(client, headers, path, **body):
    return client.post(path, headers=headers, json=body)


def credential(options, private, cred_id, register, counter=1, origin=ORIGIN, uv=True):
    client_data = json.dumps({"type": "webauthn.create" if register else "webauthn.get",
                              "challenge": options["challenge"], "origin": origin,
                              "crossOrigin": False}, separators=(",", ":")).encode()
    rp_id = options["rp"]["id"] if register else options["rpId"]
    flags = 1 | (4 if uv else 0) | (64 if register else 0)
    auth_data = hashlib.sha256(rp_id.encode()).digest() + bytes([flags]) + \
        struct.pack(">I", 0 if register else counter)
    if register:
        point = private.public_key().public_numbers()
        cose = {1: 2, 3: -7, -1: 1, -2: point.x.to_bytes(32, "big"),
                -3: point.y.to_bytes(32, "big")}
        auth_data += bytes(16) + struct.pack(">H", len(cred_id)) + cred_id + cbor2.dumps(cose)
        response = {"attestationObject": bytes_to_base64url(
            cbor2.dumps({"fmt": "none", "authData": auth_data, "attStmt": {}}))}
    else:
        signature = private.sign(auth_data + hashlib.sha256(client_data).digest(),
                                 ec.ECDSA(hashes.SHA256()))
        response = {"authenticatorData": bytes_to_base64url(auth_data),
                    "signature": bytes_to_base64url(signature),
                    "userHandle": bytes_to_base64url(b"copylee-user")}
    response["clientDataJSON"] = bytes_to_base64url(client_data)
    return {"id": bytes_to_base64url(cred_id), "rawId": bytes_to_base64url(cred_id),
            "type": "public-key", "response": response, "clientExtensionResults": {}}


def account_login(client, email=ADMIN_EMAIL, **extra):
    response = post(client, ANON, "/api/account/login", email=email, password=PASSWORD, **extra)
    assert response.status_code == 200, response.text
    return {**ANON, "X-CSRF-Token": response.json()["csrf"]}


def admin_login(client, **extra):
    return post(client, ANON, "/api/auth/login", email=ADMIN_EMAIL, password=PASSWORD, **extra)


def test_only_flagged_users_can_enter_admin(server):
    client, app, _ = server
    with Session(app.state.engine) as session:
        revoke_admin(session, ADMIN_EMAIL)
    assert admin_login(client).status_code == 401
    me = client.get("/api/account/me")
    assert me.status_code == 401
    headers = account_login(client)
    assert client.get("/api/account/me").json()["features"] == {
        "drive": True, "images": True, "admin": False}
    with Session(app.state.engine) as session:
        set_admin(session, ADMIN_EMAIL)
    assert client.get("/api/account/me").json()["features"]["admin"] is True
    assert admin_login(client).status_code == 200
    assert client.get("/api/auth/me").json()["user"]["email"] == ADMIN_EMAIL
    # 停用或撤销管理员后，已有的后台会话立即失效。
    with Session(app.state.engine) as session:
        user = session.get(User, "admin-user")
        user.disabled = True
        session.add(user)
        session.commit()
    assert client.get("/api/auth/me").status_code == 401
    assert headers


def test_admin_login_uses_account_two_factor(server, monkeypatch):
    client, _, _ = server
    now = [1_800_000_000.0]
    monkeypatch.setattr(time, "time", lambda: now[0])
    headers = account_login(client)
    path = "/api/account/security/2fa/"
    secret = post(client, headers, path + "setup", password=PASSWORD).json()["secret"]
    enabled = post(client, headers, path + "enable", password=PASSWORD,
                   otp=pyotp.TOTP(secret).at(now[0]))
    assert enabled.status_code == 200, enabled.text
    recovery = enabled.json()["recovery_codes"]
    asked = admin_login(client)
    assert asked.status_code == 403 and "两步验证" in asked.json()["detail"]
    now[0] += 60
    assert admin_login(client, otp="000000").status_code == 401
    assert admin_login(client, otp=pyotp.TOTP(secret).at(now[0])).status_code == 200
    assert admin_login(client, otp=pyotp.TOTP(secret).at(now[0])).status_code == 401  # 防重放
    assert admin_login(client, otp=recovery[0]).status_code == 200


def test_admin_passkey_login_with_account_passkey(server):
    client, _, _ = server
    headers = account_login(client)
    private = ec.generate_private_key(ec.SECP256R1())
    cred_id = b"admin-account-credential-32bytes"
    path = "/api/account/security/passkeys/"
    options = post(client, headers, path + "options", password=PASSWORD, name="电脑").json()
    data = credential(options["options"], private, cred_id, True)
    assert post(client, headers, path + "verify", challenge_id=options["challenge_id"],
                credential=data, name="电脑").status_code == 200

    start = post(client, ANON, "/api/auth/passkey/options").json()
    assertion = credential(start["options"], private, cred_id, False)
    response = post(client, ANON, "/api/auth/passkey/verify", challenge_id=start["challenge_id"],
                    credential=assertion)
    assert response.status_code == 200, response.text
    assert client.get("/api/auth/me").status_code == 200


def test_admin_images_belong_to_admin_account(server):
    client, _, settings = server
    from test_images import picture

    headers = login(client)
    response = client.post("/api/admin/media", content=picture(), headers=headers)
    assert response.status_code == 201, response.text
    listing = client.get("/api/admin/images").json()
    assert listing["items"][0]["owner"] == "admin-user"
    account_login(client)
    mine = client.get("/api/account/images").json()
    assert mine["limits"]["enabled"] is True and mine["limits"]["quota"] == 20 * 1024 ** 3
    assert mine["total"] == 1


def test_feedback_inbox_and_limits(site):  # noqa: F811
    from test_accounts import signup

    client, _, _, sent = site
    user = signup(client, sent)
    assert post(client, user, "/api/account/feedback", content="短").status_code == 422
    for index in range(3):
        response = post(client, user, "/api/account/feedback", content=f"第 {index} 条建议内容",
                        page="/account")
        assert response.status_code == 200, response.text
    limited = post(client, user, "/api/account/feedback", content="第四条会被限流")
    assert limited.status_code == 429
    assert post(client, {**ANON}, "/api/account/feedback", content="缺少 CSRF 令牌").status_code == 403

    admin = login(client)
    inbox = client.get("/api/admin/inbox").json()
    assert inbox["unread"] == 3 and inbox["items"][0]["user"]["email"]
    first = inbox["items"][0]["id"]
    updated = client.put(f"/api/admin/inbox/{first}", headers=admin,
                         json={"status": "done", "reply": "谢谢，已经改好了"})
    assert updated.status_code == 200 and updated.json()["replied_at"]
    assert client.get("/api/admin/inbox", params={"status": "new"}).json()["total"] == 2
    mine = client.get("/api/account/feedback").json()["items"]
    assert any(item["reply"] == "谢谢，已经改好了" for item in mine)
    assert client.post(f"/api/admin/inbox/{first}/remove", headers=admin).status_code == 200

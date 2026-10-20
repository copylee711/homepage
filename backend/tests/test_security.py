import hashlib
import json
import struct
import time
from contextlib import closing

import cbor2
import pyotp
import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from sqlmodel import Session
from test_content import ORIGIN, PASSWORD, login
from webauthn.helpers import bytes_to_base64url

from app.cli import backup, reset_security, restore
from app.models import Administrator, AuthChallenge, Passkey
from app.security import decrypt


def post(client, headers, path, **body):
    return client.post(path, headers=headers, json=body)


def bind_totp(client, headers, now, monkeypatch):
    monkeypatch.setattr(time, "time", lambda: now[0])
    response = post(client, headers, "/api/admin/security/2fa/setup", password=PASSWORD)
    assert response.status_code == 200, response.text
    setup = response.json()
    assert setup["qr"].startswith("data:image/png;base64,")
    secret = setup["secret"]
    response = post(client, headers, "/api/admin/security/2fa/enable", password=PASSWORD,
                    otp=pyotp.TOTP(secret).at(now[0]))
    assert response.status_code == 200, response.text
    return secret, response.json()["recovery_codes"]


def test_totp_replay_recovery_password_reset_and_backup(server, monkeypatch, tmp_path):
    client, app, settings = server
    headers = login(client)
    now = [time.time()]
    secret, codes = bind_totp(client, headers, now, monkeypatch)
    assert len(set(codes)) == 10
    state = client.get("/api/admin/security").json()
    assert state["totp_enabled"] and state["recovery_remaining"] == 10
    with Session(app.state.engine) as session:
        row = session.get(Administrator, 1)
        assert row.totp_secret != secret
        assert decrypt(settings, row.totp_secret) == secret
        assert codes[0] not in row.recovery_hashes
    archive = backup(settings)
    assert (archive / "2fa.key").is_file()
    target = tmp_path / "restore"
    restore(archive, target)
    assert (target / "2fa.key").read_bytes() == (settings.data_dir / "2fa.key").read_bytes()
    import sqlite3
    with closing(sqlite3.connect(target / "content.db")) as connection:
        assert connection.execute("SELECT count(*) FROM login_session").fetchone()[0] == 0
        assert connection.execute("SELECT totp_secret FROM administrator").fetchone()[0]
    client.post("/api/auth/logout", headers=headers)
    base = {"username": "admin", "password": PASSWORD}
    assert post(client, {"Origin": ORIGIN}, "/api/auth/login", **base).status_code == 403
    # 绑定时使用的 TOTP 不允许重放。
    assert post(client, {"Origin": ORIGIN}, "/api/auth/login", **base,
                otp=pyotp.TOTP(secret).at(now[0])).status_code == 401
    now[0] += 30
    assert post(client, {"Origin": ORIGIN}, "/api/auth/login", **base,
                otp=pyotp.TOTP(secret).at(now[0])).status_code == 200
    assert post(client, {"Origin": ORIGIN}, "/api/auth/login", **base, otp=codes[0]).status_code == 200
    assert post(client, {"Origin": ORIGIN}, "/api/auth/login", **base, otp=codes[0]).status_code == 401
    from app.auth import set_admin
    with Session(app.state.engine) as session:
        set_admin(session, "admin", PASSWORD)
        assert session.get(Administrator, 1).totp_secret
    assert client.get("/api/auth/me").status_code == 401
    reset_security(settings)
    login(client)
    assert not client.get("/api/admin/security").json()["totp_enabled"]


def test_totp_expiry_disable_rotation_and_csrf(server, monkeypatch):
    client, app, settings = server
    headers = login(client)
    now = [time.time()]
    secret, codes = bind_totp(client, headers, now, monkeypatch)
    path = "/api/admin/security/2fa/recovery"
    assert post(client, {"Origin": ORIGIN}, path, password=PASSWORD, otp=codes[0]).status_code == 403
    rotated = post(client, headers, path, password=PASSWORD, otp=codes[0])
    assert rotated.status_code == 200
    new_codes = rotated.json()["recovery_codes"]
    assert not set(new_codes) & set(codes)
    assert post(client, headers, "/api/admin/security/2fa/disable", password=PASSWORD,
                otp=codes[1]).status_code == 403
    assert post(client, headers, "/api/admin/security/2fa/disable", password=PASSWORD,
                otp=new_codes[0]).status_code == 200
    setup = post(client, headers, "/api/admin/security/2fa/setup", password=PASSWORD).json()
    now[0] += 601
    assert post(client, headers, "/api/admin/security/2fa/enable", password=PASSWORD,
                otp=pyotp.TOTP(setup["secret"]).at(now[0])).status_code == 409


def credential(options, private, cred_id, register, counter=1, origin=ORIGIN, uv=True):
    client_data = json.dumps({"type": "webauthn.create" if register else "webauthn.get",
                              "challenge": options["challenge"], "origin": origin,
                              "crossOrigin": False}, separators=(",", ":")).encode()
    rp_id = options["rp"]["id"] if register else options["rpId"]
    auth_data = hashlib.sha256(rp_id.encode()).digest() + bytes([1 | (4 if uv else 0) | (64 if register else 0)]) + struct.pack(">I", 0 if register else counter)
    if register:
        point = private.public_key().public_numbers()
        cose = {1: 2, 3: -7, -1: 1, -2: point.x.to_bytes(32, "big"), -3: point.y.to_bytes(32, "big")}
        auth_data += bytes(16) + struct.pack(">H", len(cred_id)) + cred_id + cbor2.dumps(cose)
        response = {"attestationObject": bytes_to_base64url(cbor2.dumps({"fmt": "none", "authData": auth_data, "attStmt": {}}))}
    else:
        signature = private.sign(auth_data + hashlib.sha256(client_data).digest(), ec.ECDSA(hashes.SHA256()))
        response = {"authenticatorData": bytes_to_base64url(auth_data), "signature": bytes_to_base64url(signature),
                    "userHandle": bytes_to_base64url(b"copylee-admin")}
    response["clientDataJSON"] = bytes_to_base64url(client_data)
    return {"id": bytes_to_base64url(cred_id), "rawId": bytes_to_base64url(cred_id),
            "type": "public-key", "response": response, "clientExtensionResults": {}}


def register_key(client, headers, private, cred_id):
    response = post(client, headers, "/api/admin/security/passkeys/options", password=PASSWORD, name="Test device")
    assert response.status_code == 200, response.text
    options = response.json()
    assert options["options"]["authenticatorSelection"]["userVerification"] == "required"
    data = credential(options["options"], private, cred_id, True)
    response = post(client, headers, "/api/admin/security/passkeys/verify",
                    challenge_id=options["challenge_id"], credential=data, name="Test device")
    assert response.status_code == 200, response.text
    return options, data


def test_passkey_cryptographic_login_replay_revoke(server, tmp_path):
    client, app, settings = server
    headers = login(client)
    private = ec.generate_private_key(ec.SECP256R1())
    cred_id = b"a-test-credential-id-with-32bytes!"
    options, data = register_key(client, headers, private, cred_id)
    restored = tmp_path / "restored-passkey"
    restore(backup(settings), restored)
    import sqlite3
    with closing(sqlite3.connect(restored / "content.db")) as connection:
        assert connection.execute("SELECT id FROM passkey").fetchone()[0] == bytes_to_base64url(cred_id)
        assert connection.execute("SELECT count(*) FROM auth_challenge").fetchone()[0] == 0
    assert post(client, headers, "/api/admin/security/passkeys/verify",
                challenge_id=options["challenge_id"], credential=data).status_code == 403
    client.post("/api/auth/logout", headers=headers)
    options = client.post("/api/auth/passkey/options", headers={"Origin": ORIGIN}).json()
    data = credential(options["options"], private, cred_id, False)
    payload = {"challenge_id": options["challenge_id"], "credential": data}
    response = post(client, {"Origin": ORIGIN}, "/api/auth/passkey/verify", **payload)
    assert response.status_code == 200, response.text
    headers["X-CSRF-Token"] = response.json()["csrf"]
    assert "HttpOnly" in response.headers["set-cookie"]
    assert post(client, {"Origin": ORIGIN}, "/api/auth/passkey/verify", **payload).status_code == 401
    with Session(app.state.engine) as session:
        assert session.get(Passkey, bytes_to_base64url(cred_id)).sign_count == 1
    assert post(client, headers, f"/api/admin/security/passkeys/{bytes_to_base64url(cred_id)}/remove",
                password=PASSWORD).status_code == 200
    assert client.get("/api/admin/security").json()["passkeys"] == []


def test_synced_passkey_zero_counter_and_malformed_response(server):
    client, app, settings = server
    headers = login(client)
    private = ec.generate_private_key(ec.SECP256R1())
    cred_id = b"synced-passkey-counter-zero"
    register_key(client, headers, private, cred_id)
    for _ in range(2):
        options = client.post("/api/auth/passkey/options", headers={"Origin": ORIGIN}).json()
        response = post(client, {"Origin": ORIGIN}, "/api/auth/passkey/verify",
                        challenge_id=options["challenge_id"],
                        credential=credential(options["options"], private, cred_id, False, counter=0))
        assert response.status_code == 200, response.text
    options = client.post("/api/auth/passkey/options", headers={"Origin": ORIGIN}).json()
    assert post(client, {"Origin": ORIGIN}, "/api/auth/passkey/verify",
                challenge_id=options["challenge_id"], credential={"id":bytes_to_base64url(cred_id)}).status_code == 401


@pytest.mark.parametrize("attack", ["origin", "uv", "signature", "cookie", "expiry", "counter"])
def test_passkey_rejects_bad_assertions(server, attack):
    client, app, settings = server
    headers = login(client)
    private = ec.generate_private_key(ec.SECP256R1())
    cred_id = b"another-test-credential-id"
    register_key(client, headers, private, cred_id)
    options = client.post("/api/auth/passkey/options", headers={"Origin": ORIGIN}).json()
    signer = ec.generate_private_key(ec.SECP256R1()) if attack == "signature" else private
    data = credential(options["options"], signer, cred_id, False,
                      counter=1, origin="https://evil.example" if attack == "origin" else ORIGIN,
                      uv=attack != "uv")
    if attack == "cookie":
        client.cookies.delete("copylee_challenge")
    if attack in {"expiry", "counter"}:
        with Session(app.state.engine) as session:
            if attack == "expiry":
                row = session.get(AuthChallenge, options["challenge_id"])
                row.expires_at = 0
            else:
                row = session.get(Passkey, bytes_to_base64url(cred_id))
                row.sign_count = 2
            session.add(row)
            session.commit()
    assert post(client, {"Origin": ORIGIN}, "/api/auth/passkey/verify",
                challenge_id=options["challenge_id"], credential=data).status_code == 401


def test_passkey_registration_access_and_domain(server):
    client, app, settings = server
    path = "/api/admin/security/passkeys/options"
    assert post(client, {"Origin": ORIGIN}, path, password=PASSWORD, name="device").status_code == 401
    headers = login(client)
    assert post(client, headers, path, password="incorrect", name="device").status_code == 403
    assert client.post("/api/auth/passkey/options", headers={"Origin": "http://localhost:5173"}).status_code == 403
    assert client.post("/api/auth/passkey/options").status_code == 403
    app.state.settings.site_url = "http://127.0.0.1:8000"
    app.state.settings.allowed_origins += ",http://127.0.0.1:8000"
    assert client.post("/api/auth/passkey/options", headers={"Origin": "http://127.0.0.1:8000"}).status_code == 403


def test_step_up_with_password_and_passkey(server, monkeypatch):
    client, app, settings = server
    headers = login(client)
    now = [time.time()]
    monkeypatch.setattr(time, "time", lambda: now[0])
    state = client.get("/api/admin/security").json()
    assert state["elevated_until"] < now[0]
    # 未验证时空密码返回 428，且不计入登录失败。
    for _ in range(6):
        assert post(client, headers, "/api/admin/security/2fa/setup").status_code == 428
    assert post(client, headers, "/api/admin/security/unlock", password="wrong-password").status_code == 403
    unlocked = post(client, headers, "/api/admin/security/unlock", password=PASSWORD)
    assert unlocked.status_code == 200, unlocked.text
    assert unlocked.json()["elevated_until"] == pytest.approx(now[0] + 600)
    # 验证有效期内无需再输入密码。
    private = ec.generate_private_key(ec.SECP256R1())
    cred_id = b"step-up-credential-id-32-bytes!!"
    options = post(client, headers, "/api/admin/security/passkeys/options", name="Phone").json()
    data = credential(options["options"], private, cred_id, True)
    assert post(client, headers, "/api/admin/security/passkeys/verify",
                challenge_id=options["challenge_id"], credential=data, name="Phone").status_code == 200
    # 过期后需要重新验证，Passkey 也可以完成验证。
    now[0] += 601
    assert post(client, headers, "/api/admin/security/2fa/setup").status_code == 428
    options = client.post("/api/admin/security/unlock/passkey/options", headers=headers).json()
    assert options["options"]["userVerification"] == "required"
    data = credential(options["options"], private, cred_id, False)
    verified = post(client, headers, "/api/admin/security/unlock/passkey/verify",
                    challenge_id=options["challenge_id"], credential=data)
    assert verified.status_code == 200, verified.text
    assert client.get("/api/admin/security").json()["elevated_until"] > now[0]
    assert post(client, headers, "/api/admin/security/2fa/setup").status_code == 200
    # 登录用的挑战不能用于提升权限。
    login_options = client.post("/api/auth/passkey/options", headers={"Origin": ORIGIN}).json()
    data = credential(login_options["options"], private, cred_id, False, counter=2)
    assert post(client, headers, "/api/admin/security/unlock/passkey/verify",
                challenge_id=login_options["challenge_id"], credential=data).status_code == 403

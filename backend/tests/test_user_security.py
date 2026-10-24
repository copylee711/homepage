import time

import pyotp
from cryptography.hazmat.primitives.asymmetric import ec
from sqlmodel import Session, select
from test_accounts import EMAIL, PASSWORD, code_for, signup, site  # noqa: F401
from test_content import ORIGIN, login
from test_security import credential, post
from webauthn.helpers import bytes_to_base64url

from app.cli import backup, restore
from app.models import User, UserPasskey
from app.security import decrypt

ANON = {"Origin": ORIGIN}


def bind(client, headers, now, monkeypatch):
    monkeypatch.setattr(time, "time", lambda: now[0])
    path = "/api/account/security/2fa/"
    assert post(client, headers, path + "setup", password="wrong-password").status_code == 403
    setup = post(client, headers, path + "setup", password=PASSWORD)
    assert setup.status_code == 200, setup.text
    secret = setup.json()["secret"]
    enabled = post(client, headers, path + "enable", password=PASSWORD,
                   otp=pyotp.TOTP(secret).at(now[0]))
    assert enabled.status_code == 200, enabled.text
    return secret, enabled.json()["recovery_codes"]


def sign_in(client, **extra):
    return post(client, ANON, "/api/account/login", email=EMAIL, password=PASSWORD, **extra)


def test_optional_totp_login_and_recovery(site, monkeypatch, tmp_path):  # noqa: F811
    client, app, settings, sent = site
    headers = signup(client, sent)
    assert client.get("/api/account/security").json() == {
        "totp_enabled": False, "recovery_remaining": 0, "passkeys": []}
    now = [time.time()]
    secret, codes = bind(client, headers, now, monkeypatch)
    assert client.get("/api/account/security").json()["recovery_remaining"] == 10
    with Session(app.state.engine) as session:
        user = session.exec(select(User).where(User.email == EMAIL)).one()
        assert decrypt(settings, user.totp_secret) == secret
    # 备份必须带上加密密钥；恢复时清除挑战与待绑定密钥。
    archive = backup(settings)
    assert (archive / "2fa.key").is_file()
    restore(archive, tmp_path / "restored")
    client.post("/api/account/logout", headers=headers)
    assert sign_in(client).json()["detail"] == "请输入两步验证码或恢复码"
    assert sign_in(client, otp=pyotp.TOTP(secret).at(now[0])).status_code == 401  # 不可重放
    now[0] += 30
    response = sign_in(client, otp=pyotp.TOTP(secret).at(now[0]))
    assert response.status_code == 200, response.text
    assert sign_in(client, otp=codes[0]).status_code == 200
    assert sign_in(client, otp=codes[0]).status_code == 401
    headers = {**ANON, "X-CSRF-Token": sign_in(client, otp=codes[1]).json()["csrf"]}
    disable = "/api/account/security/2fa/disable"
    assert post(client, headers, disable, password=PASSWORD).status_code == 403
    assert post(client, headers, disable, password=PASSWORD, otp=codes[2]).status_code == 200
    assert sign_in(client).status_code == 200


def test_email_reset_still_requires_second_factor(site, monkeypatch):  # noqa: F811
    client, _, _, sent = site
    headers = signup(client, sent)
    now = [time.time()]
    _, codes = bind(client, headers, now, monkeypatch)
    client.post("/api/account/logout", headers=headers)
    assert post(client, ANON, "/api/account/code", email=EMAIL, purpose="reset").status_code == 200
    body = {"email": EMAIL, "code": code_for(sent), "password": "brand-new-password"}
    missing = post(client, ANON, "/api/account/reset", **body)
    assert missing.status_code == 403 and "两步验证" in missing.json()["detail"]
    # 未填写两步验证码时验证码不会被消耗。
    assert post(client, ANON, "/api/account/reset", **body, otp=codes[0]).status_code == 200


def test_user_passkey_register_login_and_admin_reset(site):  # noqa: F811
    client, app, _, sent = site
    headers = signup(client, sent)
    private = ec.generate_private_key(ec.SECP256R1())
    cred_id = b"visitor-credential-id-32-bytes!!"
    path = "/api/account/security/passkeys/"
    assert post(client, headers, path + "options", password="nope", name="手机").status_code == 403
    options = post(client, headers, path + "options", password=PASSWORD, name="手机")
    assert options.status_code == 200, options.text
    options = options.json()
    assert options["options"]["authenticatorSelection"]["residentKey"] == "required"
    data = credential(options["options"], private, cred_id, True)
    response = post(client, headers, path + "verify", challenge_id=options["challenge_id"],
                    credential=data, name="手机")
    assert response.status_code == 200, response.text
    assert [k["name"] for k in response.json()["passkeys"]] == ["手机"]
    client.post("/api/account/logout", headers=headers)

    start = client.post("/api/account/passkey/options", headers=ANON).json()
    assert "allowCredentials" not in start["options"] or not start["options"]["allowCredentials"]
    assertion = credential(start["options"], private, cred_id, False)
    payload = {"challenge_id": start["challenge_id"], "credential": assertion}
    login_response = post(client, ANON, "/api/account/passkey/verify", **payload)
    assert login_response.status_code == 200, login_response.text
    assert login_response.json()["user"]["email"] == EMAIL
    assert post(client, ANON, "/api/account/passkey/verify", **payload).status_code == 400
    with Session(app.state.engine) as session:
        assert session.get(UserPasskey, bytes_to_base64url(cred_id)).sign_count == 1

    # 管理员为丢失设备的用户重置：Passkey 与登录全部清除。
    user_id = login_response.json()["user"]["id"]
    admin = login(client)
    assert client.post(f"/api/admin/accounts/users/{user_id}/reset-security",
                       headers=admin).status_code == 200
    assert client.get("/api/account/me").status_code == 401
    start = client.post("/api/account/passkey/options", headers=ANON).json()
    assertion = credential(start["options"], private, cred_id, False, counter=2)
    assert post(client, ANON, "/api/account/passkey/verify", challenge_id=start["challenge_id"],
                credential=assertion).status_code == 401


def test_passkey_requires_configured_origin(site):  # noqa: F811
    client, _, _, _ = site
    assert client.post("/api/account/passkey/options").status_code == 403
    assert client.post("/api/account/passkey/options",
                       headers={"Origin": "http://localhost:5173"}).status_code == 403

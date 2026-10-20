"""Optional TOTP and WebAuthn. All state changes run under a SQLite write lock."""
import base64
import json
import secrets
import time
from io import BytesIO
from urllib.parse import urlsplit

import pyotp
import qrcode
from argon2.exceptions import VerificationError
from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException
from sqlalchemy import delete
from sqlmodel import select
from webauthn import (
    base64url_to_bytes,
    generate_authentication_options,
    generate_registration_options,
    options_to_json,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers import bytes_to_base64url
from webauthn.helpers.exceptions import WebAuthnException
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from .auth import (
    COOKIE,
    admin_access,
    check_origin,
    current_session,
    digest,
    fail_login,
    hasher,
    issue_session,
    rate_check,
)
from .models import Administrator, AuthChallenge, LoginAttempt, LoginSession, Passkey

CHALLENGE_COOKIE = "copylee_challenge"
ELEVATION_SECONDS = 600
OTP_REQUIRED = "请输入两步验证码或恢复码"


def cipher(settings, create=False):
    path = settings.data_dir / "2fa.key"
    if create and not path.exists():
        try:
            with path.open("xb") as file:
                file.write(Fernet.generate_key())
            path.chmod(0o600)
        except FileExistsError:
            pass
    try:
        return Fernet(path.read_bytes())
    except (OSError, ValueError):
        raise HTTPException(503, "两步验证密钥不可用，请检查数据备份") from None


def decrypt(settings, value):
    try:
        return cipher(settings).decrypt(value.encode()).decode()
    except InvalidToken:
        raise HTTPException(503, "两步验证密钥不匹配，请恢复正确备份") from None


def verify_factor(settings, admin, code):
    code = code.strip()
    hashed = digest(code)
    if hashed in admin.recovery_hashes:
        admin.recovery_hashes = [value for value in admin.recovery_hashes if value != hashed]
        return True
    if not admin.totp_secret or len(code) != 6 or not code.isascii() or not code.isdigit():
        return False
    totp = pyotp.TOTP(decrypt(settings, admin.totp_secret))
    step = int(time.time()) // 30
    for counter in (step, step - 1, step + 1):
        if counter > admin.last_totp_step and secrets.compare_digest(totp.at(counter * 30), code):
            admin.last_totp_step = counter
            return True
    return False


def locked_admin(request, session):
    session.connection().exec_driver_sql("BEGIN IMMEDIATE")
    session.expire_all()
    current_session(request, session, write=True)
    rate_check(session)
    return session.get(Administrator, 1)


def elevated(request, session) -> bool:
    return current_session(request, session).elevated_until > time.time()


def reauthenticate(request, session, admin, proof, factor=True, allow_elevated=True):
    if allow_elevated and elevated(request, session):
        return
    if not proof.password:
        # 不计入失败次数：这是会话验证过期，而不是密码错误。
        raise HTTPException(428, "身份验证已过期，请重新验证")
    try:
        valid = hasher.verify(admin.password_hash, proof.password)
    except VerificationError:
        valid = False
    if valid and factor and admin.totp_secret and not proof.otp.strip():
        # 密码正确但尚未输入验证码：前端据此弹出第二步，不计入失败次数。
        raise HTTPException(403, OTP_REQUIRED)
    if not valid or (factor and admin.totp_secret and not verify_factor(
        request.app.state.settings, admin, proof.otp
    )):
        fail_login(session, "密码或两步验证码错误", 403)


def elevate(request, session, current):
    current.elevated_until = time.time() + ELEVATION_SECONDS
    session.add(current)
    session.commit()
    return {"elevated_until": current.elevated_until}


def unlock(request, session, proof):
    admin = locked_admin(request, session)
    reauthenticate(request, session, admin, proof, allow_elevated=False)
    session.add(admin)  # 恢复码使用后需要保存
    return elevate(request, session, current_session(request, session))


def revoke_others(request, session):
    current = digest(request.cookies.get(COOKIE, ""))
    session.exec(delete(LoginSession).where(LoginSession.token_hash != current))
    session.exec(delete(AuthChallenge))
    session.exec(delete(LoginAttempt))


def recovery_codes(admin):
    codes = [secrets.token_hex(16) for _ in range(10)]
    admin.recovery_hashes = [digest(code) for code in codes]
    return codes


def factor_action(request, session, proof, operation):
    admin = locked_admin(request, session)
    settings = request.app.state.settings
    reauthenticate(request, session, admin, proof, factor=operation not in {"setup", "enable"})
    if operation == "setup":
        if admin.totp_secret:
            raise HTTPException(409, "请先关闭现有两步验证")
        secret = pyotp.random_base32()
        admin.pending_secret = cipher(settings, create=True).encrypt(secret.encode()).decode()
        admin.pending_expires = time.time() + 600
        uri = pyotp.TOTP(secret).provisioning_uri(admin.username, issuer_name="Copy Lee")
        buffer = BytesIO()
        qrcode.make(uri).save(buffer, format="PNG")
        session.add(admin)
        session.commit()
        return {"secret": secret, "qr": "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()}
    if operation == "enable":
        if admin.totp_secret or not admin.pending_secret or admin.pending_expires < time.time():
            raise HTTPException(409, "绑定已失效，请重新开始")
        # 只验证待绑定密钥；失败绝不将其保存为有效因素。
        pending = Administrator(username=admin.username, password_hash="", totp_secret=admin.pending_secret)
        if not verify_factor(settings, pending, proof.otp):
            fail_login(session, "验证码错误，请检查设备时间", 403)
        admin.totp_secret, admin.last_totp_step = admin.pending_secret, pending.last_totp_step
        admin.pending_secret, admin.pending_expires = None, 0
        result = {"recovery_codes": recovery_codes(admin)}
    elif operation == "disable":
        admin.totp_secret, admin.pending_secret = None, None
        admin.pending_expires, admin.last_totp_step, admin.recovery_hashes = 0, -1, []
        result = {"ok": True}
    elif operation == "recovery":
        if not admin.totp_secret:
            raise HTTPException(409, "尚未开启两步验证")
        result = {"recovery_codes": recovery_codes(admin)}
    else:
        raise HTTPException(404)
    session.add(admin)
    revoke_others(request, session)
    session.commit()
    return result


def passkey_context(request):
    admin_access(request)
    check_origin(request)
    origin = request.app.state.settings.site_url
    parts = urlsplit(origin)
    if parts.path or parts.query or parts.fragment or parts.username:
        raise HTTPException(503, "Passkey 的站点地址必须是站点根地址")
    if request.headers.get("origin") != origin:
        raise HTTPException(403, "请在配置的正式站点地址使用 Passkey")
    if parts.scheme != "https" and parts.hostname != "localhost":
        raise HTTPException(403, "Passkey 需要 HTTPS，或本地 localhost")
    return origin, parts.hostname


def passkey_options(request, response, session, proof=None, step_up=False):
    origin, rp_id = passkey_context(request)
    session.connection().exec_driver_sql("BEGIN IMMEDIATE")
    session.expire_all()
    rate_check(session)
    keys = session.exec(select(Passkey)).all()
    if proof:
        current = current_session(request, session, write=True)
        admin = session.get(Administrator, 1)
        reauthenticate(request, session, admin, proof)
        if len(keys) >= 10:
            raise HTTPException(409, "最多绑定 10 个 Passkey")
        options = generate_registration_options(
            rp_id=rp_id, rp_name="Copy Lee", user_id=b"copylee-admin", user_name=admin.username,
            authenticator_selection=AuthenticatorSelectionCriteria(
                resident_key=ResidentKeyRequirement.REQUIRED,
                user_verification=UserVerificationRequirement.REQUIRED,
            ),
            exclude_credentials=[PublicKeyCredentialDescriptor(id=base64url_to_bytes(key.id)) for key in keys],
        )
        bound, kind = current.token_hash, "register"
    elif step_up:
        current = current_session(request, session, write=True)
        if not keys:
            raise HTTPException(409, "还没有绑定 Passkey，请使用密码验证")
        options = generate_authentication_options(
            rp_id=rp_id,
            user_verification=UserVerificationRequirement.REQUIRED,
            allow_credentials=[PublicKeyCredentialDescriptor(id=base64url_to_bytes(key.id)) for key in keys],
        )
        bound, kind = current.token_hash, "elevate"
    else:
        options = generate_authentication_options(
            rp_id=rp_id,
            user_verification=UserVerificationRequirement.REQUIRED,
            allow_credentials=[PublicKeyCredentialDescriptor(id=base64url_to_bytes(key.id)) for key in keys],
        )
        bound, kind = "", "login"
    now = time.time()
    session.exec(delete(AuthChallenge).where(AuthChallenge.expires_at <= now))
    previous = request.cookies.get(CHALLENGE_COOKIE, "")
    if previous:
        session.exec(delete(AuthChallenge).where(AuthChallenge.id == digest(previous)))
    if len(session.exec(select(AuthChallenge)).all()) >= 100:
        raise HTTPException(429, "验证请求过多，请稍后重试")
    token = secrets.token_urlsafe(32)
    row = AuthChallenge(id=digest(token), challenge=bytes_to_base64url(options.challenge),
                        kind=kind, origin=origin, rp_id=rp_id, session_hash=bound, expires_at=now + 300)
    session.add(row)
    session.commit()
    response.set_cookie(CHALLENGE_COOKIE, token, max_age=300, httponly=True,
                        secure=request.app.state.settings.secure_cookie, samesite="strict", path="/api")
    return {"options": json.loads(options_to_json(options)), "challenge_id": row.id}


def passkey_verify(request, session, body, register=False, step_up=False):
    origin, rp_id = passkey_context(request)
    session.connection().exec_driver_sql("BEGIN IMMEDIATE")
    session.expire_all()
    rate_check(session)
    row = session.get(AuthChallenge, body.challenge_id)
    token = request.cookies.get(CHALLENGE_COOKIE, "")
    status = 403 if register or step_up else 401
    if (not row or row.expires_at <= time.time() or row.kind != ("register" if register else "elevate" if step_up else "login")
            or row.origin != origin or row.rp_id != rp_id or digest(token) != row.id):
        fail_login(session, "验证请求已失效，请重试", status)
    if register or step_up:
        current = current_session(request, session, write=True)
        if current.token_hash != row.session_hash:
            raise HTTPException(403, "验证会话已改变")
    session.delete(row)
    try:
        if register:
            result = verify_registration_response(
                credential=body.credential, expected_challenge=base64url_to_bytes(row.challenge),
                expected_rp_id=rp_id, expected_origin=origin, require_user_verification=True,
            )
            if len(session.exec(select(Passkey)).all()) >= 10:
                raise HTTPException(409, "最多绑定 10 个 Passkey")
            key = Passkey(id=bytes_to_base64url(result.credential_id),
                          public_key=bytes_to_base64url(result.credential_public_key),
                          sign_count=result.sign_count, name=body.name, created_at=time.time())
        else:
            key = session.get(Passkey, body.credential.get("id", ""))
            if not key:
                fail_login(session, "未找到有效 Passkey", status)
            result = verify_authentication_response(
                credential=body.credential, expected_challenge=base64url_to_bytes(row.challenge),
                expected_rp_id=rp_id, expected_origin=origin,
                credential_public_key=base64url_to_bytes(key.public_key),
                credential_current_sign_count=key.sign_count, require_user_verification=True,
            )
            key.sign_count, key.last_used = result.new_sign_count, time.time()
    except (WebAuthnException, ValueError, TypeError, KeyError):
        fail_login(session, "Passkey 验证失败，请重试", status)
    session.add(key)
    session.exec(delete(LoginAttempt))
    if register:
        session.commit()
        return {"ok": True}
    if step_up:
        return elevate(request, session, current)
    return issue_session(request, session)


def remove_passkey(request, session, key_id, proof):
    admin = locked_admin(request, session)
    reauthenticate(request, session, admin, proof)
    key = session.get(Passkey, key_id)
    if key is None:
        raise HTTPException(404, "Passkey 不存在")
    session.delete(key)
    session.add(admin)
    revoke_others(request, session)
    session.commit()
    return {"ok": True}

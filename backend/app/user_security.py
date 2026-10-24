"""访客账户的可选两步验证（TOTP + 恢复码）与 Passkey。

与管理员共用 TOTP 校验、加密密钥与恢复码格式，但会话、挑战与限流完全分开。修改安全设置
每次都需要当前密码（开启两步验证后还需验证码），完成后其他设备上的登录随之退出。
Passkey 登录使用可发现凭据，无需先输入邮箱；Passkey 本身已含设备验证，不再要求 TOTP。
"""

import base64
import json
import secrets
import time
from io import BytesIO
from urllib.parse import urlsplit

import pyotp
import qrcode
from fastapi import HTTPException
from sqlalchemy import delete, func
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

from .accounts import (
    client_ip,
    current_user,
    issue,
    record_failure,
    throttle,
    verify_password,
)
from .auth import check_origin, digest
from .models import LoginAttempt, User, UserChallenge, UserPasskey, UserSession
from .security import OTP_REQUIRED, cipher, recovery_codes, verify_factor

CHALLENGE_COOKIE = "copylee_user_challenge"
# 前端据此通知浏览器删除这个本站已不认识的 Passkey。
UNKNOWN_PASSKEY = "这个 Passkey 已不在本站，请改用密码或其他 Passkey 登录"
PASSKEY_LIMIT = 10


def state(session, user: User) -> dict:
    keys = session.exec(
        select(UserPasskey).where(UserPasskey.user_id == user.id).order_by(UserPasskey.created_at)
    ).all()
    return {"totp_enabled": bool(user.totp_secret),
            "recovery_remaining": len(user.recovery_hashes),
            "passkeys": [{"id": key.id, "name": key.name, "created_at": key.created_at,
                          "last_used": key.last_used} for key in keys]}


def locked_user(request, session) -> tuple[User, UserSession]:
    session.connection().exec_driver_sql("BEGIN IMMEDIATE")
    session.expire_all()
    return current_user(request, session, write=True)


def reauthenticate(request, session, user: User, proof, factor: bool = True):
    """修改安全设置前确认本人：当前密码，以及已开启时的两步验证码。"""
    key = f"user:{digest(user.email)}"
    throttle(session, key, 5, "验证失败次数过多，请 15 分钟后再试")
    valid = verify_password(user.password_hash, proof.password)
    if valid and factor and user.totp_secret and not proof.otp.strip():
        raise HTTPException(403, OTP_REQUIRED)
    if not valid or (factor and user.totp_secret and not verify_factor(
        request.app.state.settings, user, proof.otp
    )):
        record_failure(session, key)
        raise HTTPException(403, "密码或两步验证码错误")


def revoke_others(session, user: User, current: UserSession):
    session.exec(delete(UserSession).where(UserSession.user_id == user.id,
                                           UserSession.token_hash != current.token_hash))
    session.exec(delete(UserChallenge).where(UserChallenge.user_id == user.id))


def factor_action(request, session, proof, operation: str) -> dict:
    user, current = locked_user(request, session)
    settings = request.app.state.settings
    reauthenticate(request, session, user, proof, factor=operation not in {"setup", "enable"})
    if operation == "setup":
        if user.totp_secret:
            raise HTTPException(409, "请先关闭现有两步验证")
        secret = pyotp.random_base32()
        user.pending_secret = cipher(settings, create=True).encrypt(secret.encode()).decode()
        user.pending_expires = time.time() + 600
        uri = pyotp.TOTP(secret).provisioning_uri(user.email, issuer_name="Copy Lee")
        buffer = BytesIO()
        qrcode.make(uri).save(buffer, format="PNG")
        session.add(user)
        session.commit()
        return {"secret": secret,
                "qr": "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()}
    if operation == "enable":
        if user.totp_secret or not user.pending_secret or user.pending_expires < time.time():
            raise HTTPException(409, "绑定已失效，请重新开始")
        # 只验证待绑定密钥；失败不会把它保存为有效因素。
        pending = User(id=user.id, email=user.email, password_hash="", name="", created_at="",
                       totp_secret=user.pending_secret)
        if not verify_factor(settings, pending, proof.otp):
            record_failure(session, f"user:{digest(user.email)}")
            raise HTTPException(403, "验证码错误，请检查设备时间")
        user.totp_secret, user.last_totp_step = user.pending_secret, pending.last_totp_step
        user.pending_secret, user.pending_expires = None, 0
        result = {"recovery_codes": recovery_codes(user)}
    elif operation == "disable":
        clear_factor(user)
        result = {"ok": True}
    elif operation == "recovery":
        if not user.totp_secret:
            raise HTTPException(409, "尚未开启两步验证")
        result = {"recovery_codes": recovery_codes(user)}
    else:
        raise HTTPException(404)
    session.add(user)
    revoke_others(session, user, current)
    session.commit()
    return result


def clear_factor(user: User):
    user.totp_secret = user.pending_secret = None
    user.pending_expires, user.last_totp_step, user.recovery_hashes = 0, -1, []


def reset(session, user: User):
    """管理员为丢失设备的用户清除两步验证与 Passkey，并退出其全部登录。"""
    clear_factor(user)
    session.add(user)
    for model in (UserPasskey, UserChallenge, UserSession):
        session.exec(delete(model).where(model.user_id == user.id))
    session.exec(delete(LoginAttempt).where(LoginAttempt.key == f"user:{digest(user.email)}"))
    session.commit()


# —— Passkey ——


def passkey_context(request) -> tuple[str, str]:
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


def save_challenge(request, response, session, options, kind: str, user_id: str = "",
                   bound: str = "") -> dict:
    now = time.time()
    ip_hash = digest(client_ip(request))
    session.exec(delete(UserChallenge).where(UserChallenge.expires_at <= now))
    previous = request.cookies.get(CHALLENGE_COOKIE, "")
    if previous:
        session.exec(delete(UserChallenge).where(UserChallenge.id == digest(previous)))
    recent = session.exec(
        select(func.count()).select_from(UserChallenge).where(UserChallenge.ip_hash == ip_hash)
    ).one()
    if recent >= 20 or session.exec(select(func.count()).select_from(UserChallenge)).one() >= 500:
        raise HTTPException(429, "验证请求过多，请稍后重试")
    token = secrets.token_urlsafe(32)
    row = UserChallenge(id=digest(token), challenge=bytes_to_base64url(options.challenge),
                        kind=kind, user_id=user_id, session_hash=bound, ip_hash=ip_hash,
                        expires_at=now + 300)
    session.add(row)
    session.commit()
    response.set_cookie(CHALLENGE_COOKIE, token, max_age=300, httponly=True,
                        secure=request.app.state.settings.secure_cookie, samesite="strict",
                        path="/api")
    return {"options": json.loads(options_to_json(options)), "challenge_id": row.id}


def take_challenge(request, session, challenge_id: str, kind: str) -> UserChallenge:
    row = session.get(UserChallenge, challenge_id)
    token = request.cookies.get(CHALLENGE_COOKIE, "")
    if (not row or row.expires_at <= time.time() or row.kind != kind
            or not secrets.compare_digest(digest(token), row.id)):
        raise HTTPException(400, "验证请求已失效，请重试")
    session.delete(row)
    return row


def register_options(request, response, session, body) -> dict:
    _, rp_id = passkey_context(request)
    user, current = locked_user(request, session)
    reauthenticate(request, session, user, body)
    keys = session.exec(select(UserPasskey).where(UserPasskey.user_id == user.id)).all()
    if len(keys) >= PASSKEY_LIMIT:
        raise HTTPException(409, f"最多绑定 {PASSKEY_LIMIT} 个 Passkey")
    options = generate_registration_options(
        rp_id=rp_id, rp_name="Copy Lee", user_id=user.id.encode(), user_name=user.email,
        user_display_name=user.name,
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.REQUIRED,
            user_verification=UserVerificationRequirement.REQUIRED,
        ),
        exclude_credentials=[PublicKeyCredentialDescriptor(id=base64url_to_bytes(key.id))
                             for key in keys],
    )
    return save_challenge(request, response, session, options, "register", user.id,
                          current.token_hash)


def register_verify(request, session, body) -> dict:
    origin, rp_id = passkey_context(request)
    user, current = locked_user(request, session)
    row = take_challenge(request, session, body.challenge_id, "register")
    if row.user_id != user.id or row.session_hash != current.token_hash:
        raise HTTPException(403, "验证会话已改变，请重试")
    try:
        result = verify_registration_response(
            credential=body.credential, expected_challenge=base64url_to_bytes(row.challenge),
            expected_rp_id=rp_id, expected_origin=origin, require_user_verification=True,
        )
    except (WebAuthnException, ValueError, TypeError, KeyError):
        session.commit()
        raise HTTPException(400, "Passkey 绑定失败，请重试") from None
    credential_id = bytes_to_base64url(result.credential_id)
    count = session.exec(
        select(func.count()).select_from(UserPasskey).where(UserPasskey.user_id == user.id)
    ).one()
    if count >= PASSKEY_LIMIT or session.get(UserPasskey, credential_id):
        session.commit()
        raise HTTPException(409, "这个 Passkey 已绑定，或已达到数量上限")
    session.add(UserPasskey(id=credential_id, user_id=user.id,
                            public_key=bytes_to_base64url(result.credential_public_key),
                            sign_count=result.sign_count, name=body.name, created_at=time.time()))
    session.commit()
    return state(session, user)


def remove_passkey(request, session, key_id: str, proof) -> dict:
    user, current = locked_user(request, session)
    reauthenticate(request, session, user, proof)
    key = session.get(UserPasskey, key_id)
    if key is None or key.user_id != user.id:
        raise HTTPException(404, "Passkey 不存在")
    session.delete(key)
    revoke_others(session, user, current)
    session.commit()
    return state(session, user)


def login_options(request, response, session) -> dict:
    _, rp_id = passkey_context(request)
    session.connection().exec_driver_sql("BEGIN IMMEDIATE")
    # 不指定凭据：浏览器列出本站已保存的 Passkey，用户选择后即可登录。
    options = generate_authentication_options(
        rp_id=rp_id, user_verification=UserVerificationRequirement.REQUIRED,
    )
    return save_challenge(request, response, session, options, "login")


def login_verify(request, response, session, body) -> dict:
    user = passkey_user(request, response, session, body)
    return issue(request, response, session, user)


def passkey_user(request, response, session, body) -> User:
    """校验 Passkey 断言并返回对应用户；前台登录与后台登录共用。"""
    origin, rp_id = passkey_context(request)
    session.connection().exec_driver_sql("BEGIN IMMEDIATE")
    key_ip = f"ip:{digest(client_ip(request))}"
    throttle(session, key_ip, 20, "登录失败次数过多，请 15 分钟后再试")
    row = take_challenge(request, session, body.challenge_id, "login")
    key = session.get(UserPasskey, str(body.credential.get("id", "")))
    user = session.get(User, key.user_id) if key else None
    if key is None or user is None:
        record_failure(session, key_ip)
        raise HTTPException(401, UNKNOWN_PASSKEY)
    try:
        result = verify_authentication_response(
            credential=body.credential, expected_challenge=base64url_to_bytes(row.challenge),
            expected_rp_id=rp_id, expected_origin=origin,
            credential_public_key=base64url_to_bytes(key.public_key),
            credential_current_sign_count=key.sign_count, require_user_verification=True,
        )
    except (WebAuthnException, ValueError, TypeError, KeyError):
        record_failure(session, key_ip)
        raise HTTPException(401, "Passkey 验证失败，可能已在本站解绑") from None
    if user.disabled:
        session.commit()
        raise HTTPException(403, "账户已被停用")
    key.sign_count, key.last_used = result.new_sign_count, time.time()
    session.add(key)
    response.delete_cookie(CHALLENGE_COOKIE, path="/api")
    return user

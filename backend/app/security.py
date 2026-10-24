"""两步验证的共用部分：TOTP 密钥加密、验证码与恢复码校验。

管理员就是带 is_admin 标记的站点用户，两步验证与 Passkey 都在账户安全页设置（user_security）。
"""
import secrets
import time

import pyotp
from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException

from .auth import digest

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


def verify_factor(settings, user, code):
    code = code.strip()
    hashed = digest(code)
    if hashed in user.recovery_hashes:
        user.recovery_hashes = [value for value in user.recovery_hashes if value != hashed]
        return True
    if not user.totp_secret or len(code) != 6 or not code.isascii() or not code.isdigit():
        return False
    totp = pyotp.TOTP(decrypt(settings, user.totp_secret))
    step = int(time.time()) // 30
    for counter in (step, step - 1, step + 1):
        if counter > user.last_totp_step and secrets.compare_digest(totp.at(counter * 30), code):
            user.last_totp_step = counter
            return True
    return False


def recovery_codes(user):
    codes = [secrets.token_hex(16) for _ in range(10)]
    user.recovery_hashes = [digest(code) for code in codes]
    return codes

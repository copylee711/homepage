from pathlib import Path
from urllib.parse import urlsplit

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="COPYLEE_", env_file=".env", extra="ignore")
    data_dir: Path = Path(".data")
    static_dir: Path = Path("../dist")
    site_url: str = "http://localhost:8000"
    allowed_origins: str = "http://localhost:8000,http://localhost:5173"
    secure_cookie: bool = False
    public_admin: bool = False
    sync_enabled: bool = True
    scut_sync_enabled: bool = True
    github_token: str = ""
    session_hours: int = 12
    # 审计日志目录；留空时写入 data_dir/logs
    log_dir: Path | None = None
    # 仅向前端提供验证码启用配置；入口认证由 Caddy 管理。
    email_captcha_enabled: bool = False
    email_captcha_prefix: str = "esa-rwe96uub0q"
    email_captcha_scene_id: str = "trwiyf09"

    @field_validator("site_url")
    @classmethod
    def valid_url(cls, value: str) -> str:
        parts = urlsplit(value)
        if parts.scheme not in {"http", "https"} or not parts.netloc:
            raise ValueError("site_url must be an absolute http(s) URL")
        return value.rstrip("/")

    @property
    def db_path(self) -> Path:
        return self.data_dir / "content.db"

    @property
    def audit_dir(self) -> Path:
        return self.log_dir or self.data_dir / "logs"

    @property
    def media_dir(self) -> Path:
        return self.data_dir / "media"

    @property
    def origins(self) -> set[str]:
        return {origin.strip().rstrip("/") for origin in self.allowed_origins.split(",")}

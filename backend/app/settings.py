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
    # OAuth login credentials are server-only and independent of repository sync.
    github_client_id: str = ""
    github_client_secret: str = ""
    # Dedicated first-party Agent SSO; never share the Homepage cookie with new apps.
    agent_url: str = ""
    agent_client_secret: str = ""
    session_hours: int = 12
    # 审计日志目录；留空时写入 data_dir/logs
    log_dir: Path | None = None
    # 仅向前端提供验证码启用配置；入口认证由 Caddy 管理。
    email_captcha_enabled: bool = False
    email_captcha_prefix: str = "esa-rwe96uub0q"
    email_captcha_scene_id: str = "trwiyf09"
    # 意见反馈使用单独的 ESA 验证场景（滑块验证）。
    feedback_captcha_scene_id: str = "12wbwicc"
    # 图床公开地址，例如 https://image.copylee.cn；留空时使用 site_url/images（由后端直接提供）。
    image_url: str = ""
    # 云盘网页地址（例如 https://cloud.copylee.cn），用于分享链接与客户端配置说明。
    drive_url: str = ""
    # 网页上展示给用户的 WebDAV 地址与 SFTP 主机，仅用于说明。
    dav_url: str = ""
    sftp_host: str = ""
    sftp_port: int = 2022
    # 协议进程监听地址；SFTP 直接对外，WebDAV 由 Caddy 反代。
    sftp_listen: str = "0.0.0.0:2022"
    dav_listen: str = "127.0.0.1:10080"
    # 站点登录 Cookie 的 Domain；设为 copylee.cn 时主站与 cloud 子域名共用登录。
    cookie_domain: str = ""
    # OSS 挂载（RAM 子账号，仅授权云盘 bucket）；未配置时 OSS 挂载点不可用。
    oss_access_key_id: str = ""
    oss_access_key_secret: str = ""
    oss_bucket: str = ""
    oss_region: str = "cn-guangzhou"
    oss_endpoint: str = ""

    @field_validator("site_url", "image_url", "drive_url", "dav_url", "agent_url")
    @classmethod
    def valid_url(cls, value: str) -> str:
        if not value:
            return value
        parts = urlsplit(value)
        if parts.scheme not in {"http", "https"} or not parts.netloc:
            raise ValueError("must be an absolute http(s) URL")
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
    def images_dir(self) -> Path:
        return self.data_dir / "images"

    @property
    def drive_dir(self) -> Path:
        return self.data_dir / "drive"

    @property
    def host_keys_dir(self) -> Path:
        return self.data_dir / "ssh"

    @property
    def drive_base(self) -> str:
        return self.drive_url or self.site_url

    @property
    def image_base(self) -> str:
        return self.image_url or f"{self.site_url}/images"

    @property
    def upload_url(self) -> str:
        return f"{self.image_url or self.site_url}/api/upload"

    @property
    def origins(self) -> set[str]:
        return {origin.strip().rstrip("/") for origin in self.allowed_origins.split(",")}

from sqlalchemy import JSON, Column
from sqlmodel import Field, SQLModel


class Content(SQLModel, table=True):
    __tablename__ = "content"
    key: str = Field(primary_key=True)
    value: dict = Field(sa_column=Column(JSON, nullable=False))
    revision: int = 1


class ScutNotice(SQLModel, table=True):
    __tablename__ = "scut_notice"
    url: str = Field(primary_key=True)
    title: str
    published_at: str | None = None
    first_seen: str


class ScutMembership(SQLModel, table=True):
    __tablename__ = "scut_membership"
    url: str = Field(primary_key=True, foreign_key="scut_notice.url")
    column_id: str = Field(primary_key=True)


class ScutColumn(SQLModel, table=True):
    __tablename__ = "scut_column"
    id: str = Field(primary_key=True)
    last_success: str | None = None
    last_attempt: str | None = None
    last_error: str = ""
    initialized: bool = False
    scan_page: int = 1
    scan_started: str | None = None
    last_full_scan: str | None = None
    pages_scanned: int = 0
    total_pages: int | None = None
    revision: int = 0


class Article(SQLModel, table=True):
    __tablename__ = "article"
    id: str = Field(primary_key=True)
    slug: str = Field(unique=True, index=True)
    draft: dict = Field(sa_column=Column(JSON, nullable=False))
    published: dict | None = Field(default=None, sa_column=Column(JSON, nullable=True))
    # 曾发布的链接永远锁定，撤下再编辑也不能改变地址。
    slug_locked: bool = False
    revision: int = 1
    created_at: str
    updated_at: str


class Administrator(SQLModel, table=True):
    __tablename__ = "administrator"
    id: int = Field(default=1, primary_key=True)
    username: str
    password_hash: str
    totp_secret: str | None = None
    pending_secret: str | None = None
    pending_expires: float = 0
    last_totp_step: int = -1
    recovery_hashes: list[str] = Field(default_factory=list, sa_column=Column(JSON, nullable=False))


class Passkey(SQLModel, table=True):
    __tablename__ = "passkey"
    id: str = Field(primary_key=True)
    public_key: str
    sign_count: int = 0
    name: str
    created_at: float
    last_used: float | None = None


class AuthChallenge(SQLModel, table=True):
    __tablename__ = "auth_challenge"
    id: str = Field(primary_key=True)
    challenge: str
    kind: str
    origin: str
    rp_id: str
    session_hash: str = ""
    expires_at: float


class LoginSession(SQLModel, table=True):
    __tablename__ = "login_session"
    token_hash: str = Field(primary_key=True)
    csrf: str
    expires_at: float
    # 进入登录安全页面时验证一次身份，有效期内修改安全设置无需重复输入密码。
    elevated_until: float = 0


class LoginAttempt(SQLModel, table=True):
    __tablename__ = "login_attempt"
    key: str = Field(primary_key=True)
    failures: int = 0
    window_start: float


class Note(SQLModel, table=True):
    __tablename__ = "note"
    id: str = Field(primary_key=True)
    slug: str = Field(unique=True, index=True)
    title: str
    summary: str = ""
    category: str = ""
    markdown: str
    html: str
    # github：从笔记仓库同步，内容以仓库为准；manual：后台直接编写。
    source: str = "manual"
    path: str | None = Field(default=None, unique=True)
    sha: str = ""
    visible: bool = True
    revision: int = 1
    created_at: str
    updated_at: str


# —— 访客账户（与管理员认证完全分离）——


class User(SQLModel, table=True):
    __tablename__ = "user"
    id: str = Field(primary_key=True)
    email: str = Field(unique=True, index=True)
    password_hash: str
    name: str
    avatar: str = ""
    disabled: bool = False
    created_at: str
    last_login: str | None = None
    # 可选的两步验证；字段含义与 Administrator 相同，密钥用 data_dir/2fa.key 加密。
    totp_secret: str | None = None
    pending_secret: str | None = None
    pending_expires: float = 0
    last_totp_step: int = -1
    recovery_hashes: list[str] = Field(default_factory=list, sa_column=Column(JSON, nullable=False))


class UserSession(SQLModel, table=True):
    __tablename__ = "user_session"
    token_hash: str = Field(primary_key=True)
    user_id: str = Field(index=True)
    csrf: str
    expires_at: float


class UserPasskey(SQLModel, table=True):
    __tablename__ = "user_passkey"
    id: str = Field(primary_key=True)
    user_id: str = Field(index=True)
    public_key: str
    sign_count: int = 0
    name: str
    created_at: float
    last_used: float | None = None


class UserChallenge(SQLModel, table=True):
    """访客 Passkey 的一次性挑战；与管理员的 AuthChallenge 分开，互不影响限流。"""

    __tablename__ = "user_challenge"
    id: str = Field(primary_key=True)
    challenge: str
    kind: str
    user_id: str = ""
    session_hash: str = ""
    ip_hash: str = Field(default="", index=True)
    expires_at: float


class EmailCode(SQLModel, table=True):
    __tablename__ = "email_code"
    id: str = Field(primary_key=True)
    email: str = Field(index=True)
    purpose: str
    code_hash: str
    ip_hash: str = ""
    attempts: int = 0
    created_at: float
    expires_at: float


class Favorite(SQLModel, table=True):
    __tablename__ = "favorite"
    user_id: str = Field(primary_key=True)
    kind: str = Field(primary_key=True)
    slug: str = Field(primary_key=True)
    title: str = ""
    created_at: str


class History(SQLModel, table=True):
    __tablename__ = "history"
    user_id: str = Field(primary_key=True)
    kind: str = Field(primary_key=True)
    slug: str = Field(primary_key=True)
    title: str = ""
    viewed_at: str = Field(index=True)


class ScutReading(SQLModel, table=True):
    """SCUT 通知的已读/未读状态，登录后跨设备同步。"""

    __tablename__ = "scut_reading"
    user_id: str = Field(primary_key=True)
    state: dict = Field(sa_column=Column(JSON, nullable=False))
    updated_at: str


class GameScore(SQLModel, table=True):
    """小游戏最高分；detail 为同分时的次要指标（羊了个羊为用时秒数，越小越好）。"""

    __tablename__ = "game_score"
    user_id: str = Field(primary_key=True)
    game: str = Field(primary_key=True)
    best: int = Field(index=True)
    detail: int = 0
    plays: int = 0
    best_at: str
    updated_at: str


# —— 图床 ——


class ImageQuota(SQLModel, table=True):
    """访客的图床开关与配额；管理员不受配额限制，没有对应行。"""

    __tablename__ = "image_quota"
    user_id: str = Field(primary_key=True)
    enabled: bool = False
    quota_bytes: int = 200 * 1024 * 1024
    max_file_bytes: int = 5 * 1024 * 1024


class ImageToken(SQLModel, table=True):
    """PicList 等客户端使用的上传令牌；只保存哈希，明文仅在创建时显示一次。"""

    __tablename__ = "image_token"
    id: str = Field(primary_key=True)
    token_hash: str = Field(unique=True, index=True)
    owner: str = Field(index=True)
    name: str
    created_at: str
    last_used: str | None = None


class HostedImage(SQLModel, table=True):
    __tablename__ = "image"
    id: str = Field(primary_key=True)
    owner: str = Field(index=True)
    path: str = Field(unique=True)
    size: int
    width: int
    height: int
    sha256: str = Field(index=True)
    created_at: str = Field(index=True)

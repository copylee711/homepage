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


class UserSession(SQLModel, table=True):
    __tablename__ = "user_session"
    token_hash: str = Field(primary_key=True)
    user_id: str = Field(index=True)
    csrf: str
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

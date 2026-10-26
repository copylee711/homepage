from sqlalchemy import JSON, Column, LargeBinary
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
    user_id: str = ""


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
    # 管理员就是带此标记的站点用户；用 python -m app.cli set-admin --email 设置。
    is_admin: bool = False
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


class StoragePlan(SQLModel, table=True):
    """访客的存储方案：云盘与图床开关，以及两者共用的总配额。

    管理员不受配额限制，没有对应行。挂载点可以单独设置配额，不计入总配额。
    """

    __tablename__ = "storage_plan"
    user_id: str = Field(primary_key=True)
    drive_enabled: bool = False
    images_enabled: bool = False
    quota_bytes: int = 200 * 1024 * 1024
    max_image_bytes: int = 5 * 1024 * 1024
    # 用户同意的《云盘与图床使用协议》版本；与当前版本不一致时需要重新同意。
    terms_version: str = ""
    terms_accepted_at: str | None = None


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


# —— 云盘 ——


class DriveAccount(SQLModel, table=True):
    """SFTP/WebDAV 登录名；也可以直接用站点邮箱登录。

    legacy_hash 保存从旧系统导入的 bcrypt 密码，旧客户端无需重新配置。
    """

    __tablename__ = "drive_account"
    user_id: str = Field(primary_key=True)
    login: str
    login_key: str = Field(unique=True, index=True)
    legacy_hash: str = ""
    created_at: float


class DriveMount(SQLModel, table=True):
    """用户云盘中的一个挂载点；quota_bytes 为 0 时计入存储方案的总配额。"""

    __tablename__ = "drive_mount"
    id: str = Field(primary_key=True)
    user_id: str = Field(index=True)
    path: str
    kind: str  # local | oss
    location: str  # local：drive_dir 下的相对目录；oss：对象前缀
    quota_bytes: int = 0
    read_only: bool = False
    used_bytes: int = 0
    used_files: int = 0
    created_at: float


class DriveCredential(SQLModel, table=True):
    """协议登录凭据：SSH 公钥，或只在创建时显示一次的应用密码（只存哈希）。"""

    __tablename__ = "drive_credential"
    id: str = Field(primary_key=True)
    user_id: str = Field(index=True)
    kind: str  # ssh_key | app_password
    name: str
    secret: str  # 公钥（OpenSSH 格式）或应用密码的 SHA-256
    fingerprint: str = Field(default="", index=True)
    created_at: float
    last_used: float | None = None


class DriveShare(SQLModel, table=True):
    __tablename__ = "drive_share"
    id: str = Field(primary_key=True)
    user_id: str = Field(index=True)
    name: str
    paths: list[str] = Field(sa_column=Column(JSON, nullable=False))
    mode: str = "read"  # read | upload
    password_hash: str = ""
    expires_at: float = 0
    max_uses: int = 0
    used: int = 0
    created_at: float
    last_used: float | None = None


class DriveUpload(SQLModel, table=True):
    """网页端可续传上传的会话；数据先写入 drive_dir/.uploads/<id>。"""

    __tablename__ = "drive_upload"
    id: str = Field(primary_key=True)
    user_id: str = Field(index=True)
    # 上传到团队空间时为团队代号，否则为空（上传到自己的云盘）。
    team_id: str = ""
    path: str
    size: int
    received: int = 0
    created_at: float
    expires_at: float


# —— 反馈 ——


class Feedback(SQLModel, table=True):
    """登录用户提交的建议；管理员在后台收件箱查看与回复。"""

    __tablename__ = "feedback"
    id: str = Field(primary_key=True)
    user_id: str = Field(index=True)
    category: str = "suggestion"
    content: str
    page: str = ""
    status: str = Field(default="new", index=True)  # new | read | done
    reply: str = ""
    ip_hash: str = Field(default="", index=True)
    created_at: float = Field(index=True)
    replied_at: float | None = None


# —— 协作文档 ——


class Doc(SQLModel, table=True):
    """协作文档。正文是 Yjs 文档的完整状态（state），由 docs 模块在内存中合并后定期写回。

    链接分享用 link_token 识别，重新生成即可让旧链接失效；link_role 为 none 时不开放链接。
    """

    __tablename__ = "doc"
    id: str = Field(primary_key=True)
    user_id: str = Field(index=True)
    title: str = ""
    state: bytes = Field(default=b"", sa_column=Column(LargeBinary, nullable=False))
    size: int = 0
    link_token: str = Field(unique=True, index=True)
    link_role: str = "none"  # none | view | edit
    link_password_hash: str = ""
    link_expires_at: float = 0
    # 只读成员与只读链接能否复制、导出正文；所有者与可编辑成员不受限制。
    allow_copy: bool = True
    # 粘贴图片的去处：空字符串表示按上传者自己的默认设置；builtin | site | custom 由所有者统一指定。
    image_target: str = ""
    image_custom: dict | None = Field(default=None, sa_column=Column(JSON, nullable=True))
    # 所属团队与团队文件树中的文件夹；不属于团队时 team_id 为空。
    team_id: str = Field(default="", index=True)
    folder: str = "/"
    # 正文的 Markdown 快照，由正在编辑的浏览器上传，供团队 WebDAV 以只读 .md 文件提供。
    markdown: str = ""
    created_at: float
    updated_at: float
    updated_by: str = ""


class DocMember(SQLModel, table=True):
    __tablename__ = "doc_member"
    doc_id: str = Field(primary_key=True)
    user_id: str = Field(primary_key=True, index=True)
    role: str = "view"  # view | edit
    # 可以把文档再分享给他人，授予的权限不超过自己的权限。
    can_share: bool = False
    added_by: str = ""
    created_at: float


class DocVersion(SQLModel, table=True):
    __tablename__ = "doc_version"
    id: str = Field(primary_key=True)
    doc_id: str = Field(index=True)
    state: bytes = Field(sa_column=Column(LargeBinary, nullable=False))
    size: int = 0
    label: str = ""
    auto: bool = True
    created_at: float = Field(index=True)
    created_by: str = ""


class DocImageSetting(SQLModel, table=True):
    """用户的默认图片去处：builtin（文档内置存储）、site（本站图床）或 custom（第三方图床）。"""

    __tablename__ = "doc_image_setting"
    user_id: str = Field(primary_key=True)
    target: str = "builtin"
    custom: dict | None = Field(default=None, sa_column=Column(JSON, nullable=True))
    updated_at: float = 0


# —— 团队 ——


class Team(SQLModel, table=True):
    """团队：成员共享的一块存储空间与一组协作文档。

    quota_bytes 在创建时从所有者的总配额里划拨，空着也计入所有者的用量；
    文件放在 drive_dir/.teams/<id>/，used_bytes 记录实际用量。
    """

    __tablename__ = "team"
    id: str = Field(primary_key=True)
    user_id: str = Field(index=True)
    name: str
    description: str = ""
    quota_bytes: int = 0
    used_bytes: int = 0
    used_files: int = 0
    created_at: float
    updated_at: float


class TeamMember(SQLModel, table=True):
    __tablename__ = "team_member"
    team_id: str = Field(primary_key=True)
    user_id: str = Field(primary_key=True, index=True)
    role: str = "view"  # view | edit
    added_by: str = ""
    created_at: float


# —— 好友与私信 ——


class Friendship(SQLModel, table=True):
    """好友关系是双向的，每对好友存两行（双方各一行），按 user_id 即可查到自己的全部好友。"""

    __tablename__ = "friendship"
    user_id: str = Field(primary_key=True)
    friend_id: str = Field(primary_key=True, index=True)
    created_at: float


class FriendRequest(SQLModel, table=True):
    __tablename__ = "friend_request"
    id: str = Field(primary_key=True)
    from_id: str = Field(index=True)
    to_id: str = Field(index=True)
    message: str = ""
    status: str = Field(default="pending", index=True)  # pending | accepted | declined | cancelled
    created_at: float
    responded_at: float | None = None


class FriendInvite(SQLModel, table=True):
    """个人邀请链接：打开链接并确认的人直接成为好友；重新生成即可让旧链接失效。"""

    __tablename__ = "friend_invite"
    user_id: str = Field(primary_key=True)
    token: str = Field(unique=True, index=True)
    created_at: float


class Message(SQLModel, table=True):
    """好友私信。kind 为 file 时 data 记录发送者云盘里的文件，为 doc_invite 时记录文档与邀请的权限。

    updated_at 在发送、撤回、邀请被处理时更新，前端按它轮询增量，卡片状态变化也能同步到对方。
    """

    __tablename__ = "message"
    id: str = Field(primary_key=True)
    sender_id: str = Field(index=True)
    recipient_id: str = Field(index=True)
    kind: str = "text"  # text | file | doc_invite
    body: str = ""
    data: dict | None = Field(default=None, sa_column=Column(JSON, nullable=True))
    created_at: float = Field(index=True)
    updated_at: float = Field(index=True)
    read_at: float | None = None
    revoked: bool = False

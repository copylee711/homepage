import re
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


def safe_link(value: str, allow_media: bool = False, allow_internal: bool = False) -> str:
    if allow_media and value.startswith("/media/") and ".." not in value:
        return value
    # 站内路径：以单个 / 开头，不允许 //host 形式的协议相对地址。
    if allow_internal and value.startswith("/") and not value.startswith("//") and ".." not in value:
        return value
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username:
        raise ValueError("仅支持完整的 HTTP/HTTPS 地址")
    return value


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Portal(StrictModel):
    title: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)
    href: str = Field(max_length=2048)
    icon: Literal["cloud", "note", "github"]
    hint: str = Field(default="", max_length=100)
    visible: bool = True

    @field_validator("href")
    @classmethod
    def valid_href(cls, value):
        return safe_link(value, allow_internal=True)


class RepoGroup(StrictModel):
    title: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=300)
    prefix: str = Field(min_length=1, max_length=100)


class Police(StrictModel):
    """公安备案：text 为完整备案号（如 粤公网安备44011302006057号），code 为其中的数字，用于查询链接。"""

    text: str = Field(default="", max_length=100)
    code: str = Field(default="", max_length=50, pattern=r"^[0-9]*$")

    @model_validator(mode="after")
    def derive_code(self):
        self.text = self.text.strip()
        digits = re.sub(r"\D", "", self.text)
        if digits:
            self.code = digits
        elif self.text and self.code:
            # 旧数据只填了省份前缀，编号单独存放：合成为完整备案号。
            self.text = f"{self.text}{self.code}号"
        return self


SocialPlatform = Literal[
    "github", "linkedin", "instagram", "x", "bilibili", "zhihu",
    "xiaohongshu", "youtube", "weibo", "email",
]


class Social(StrictModel):
    platform: SocialPlatform
    url: str = Field(default="", max_length=2048)
    visible: bool = True

    @field_validator("url")
    @classmethod
    def valid_url(cls, value, info):
        if not value:
            return value
        if info.data.get("platform") == "email":
            address = value.removeprefix("mailto:")
            if "@" not in address or any(c in address for c in " <>\"'"):
                raise ValueError("邮箱地址无效")
            return f"mailto:{address}"
        return safe_link(value)


class Site(StrictModel):
    name: str = Field(min_length=1, max_length=80)
    greeting: str = Field(max_length=100)
    roles: list[str] = Field(max_length=10)
    intro: str = Field(max_length=2000)
    github: str = Field(
        min_length=1, max_length=39, pattern=r"^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$"
    )
    cloud: str = Field(max_length=2048)
    socials: list[Social] = Field(default_factory=list, max_length=20)
    portals: list[Portal] = Field(max_length=30)
    repoGroups: list[RepoGroup] = Field(max_length=30)
    hiddenRepos: list[str] = Field(max_length=500)
    icp: str = Field(default="", max_length=100)
    police: Police

    @field_validator("cloud")
    @classmethod
    def valid_links(cls, value):
        return safe_link(value)

    @field_validator("roles", "hiddenRepos")
    @classmethod
    def short_values(cls, values):
        if any(not value.strip() or len(value) > 100 for value in values):
            raise ValueError("列表内容不能为空或超过 100 字符")
        return values


class SiteWrite(StrictModel):
    revision: int = Field(ge=1)
    site: Site


class ArticleDraft(StrictModel):
    title: str = Field(min_length=1, max_length=200)
    slug: str = Field(min_length=1, max_length=120, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
    summary: str = Field(default="", max_length=1000)
    markdown: str = Field(default="", max_length=500_000)
    cover: str = Field(default="", max_length=2048)

    @field_validator("cover")
    @classmethod
    def cover_url(cls, value):
        return safe_link(value, allow_media=True) if value else value


class ArticleWrite(StrictModel):
    revision: int = Field(ge=1)
    draft: ArticleDraft


class Revision(StrictModel):
    revision: int = Field(ge=1)


class Login(StrictModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=200)
    otp: str = Field(default="", max_length=80)


class SecurityProof(StrictModel):
    # 已在本会话验证身份时可留空。
    password: str = Field(default="", max_length=200)
    otp: str = Field(default="", max_length=80)


class AdminPasswordChange(StrictModel):
    current: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=12, max_length=200)


class PasskeySetup(SecurityProof):
    name: str = Field(min_length=1, max_length=80)


class PasskeyResponse(StrictModel):
    challenge_id: str = Field(min_length=1, max_length=100)
    credential: dict
    name: str = Field(default="Passkey", min_length=1, max_length=80)


class Preview(StrictModel):
    markdown: str = Field(max_length=500_000)


NOTE_SLUG = r"^[a-z0-9一-鿿]+(?:-[a-z0-9一-鿿]+)*$"


class NoteWrite(StrictModel):
    revision: int = Field(default=0, ge=0)
    title: str = Field(min_length=1, max_length=200)
    slug: str = Field(min_length=1, max_length=120, pattern=NOTE_SLUG)
    category: str = Field(default="", max_length=80)
    summary: str = Field(default="", max_length=1000)
    markdown: str = Field(default="", max_length=500_000)
    visible: bool = True


class NoteVisibility(StrictModel):
    revision: int = Field(ge=1)
    visible: bool


class NotesConfig(StrictModel):
    repo: str = Field(default="", max_length=140, pattern=r"^$|^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$")
    branch: str = Field(default="main", min_length=1, max_length=100, pattern=r"^[A-Za-z0-9._/-]+$")
    autoPublish: bool = True
    exclude: list[str] = Field(default_factory=list, max_length=50)

    @field_validator("exclude")
    @classmethod
    def short_patterns(cls, values):
        if any(not v.strip() or len(v) > 100 for v in values):
            raise ValueError("排除规则不能为空或超过 100 字符")
        return [v.strip() for v in values]


# —— 访客账户 ——

Kind = Literal["note", "post"]


class CodeRequest(StrictModel):
    email: str = Field(min_length=3, max_length=254)
    purpose: Literal["register", "reset"]


class Register(StrictModel):
    email: str = Field(min_length=3, max_length=254)
    code: str = Field(min_length=6, max_length=6, pattern=r"^[0-9]{6}$")
    name: str = Field(default="", max_length=40)
    password: str = Field(min_length=8, max_length=128)


class UserLogin(StrictModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=128)
    otp: str = Field(default="", max_length=80)


class PasswordReset(StrictModel):
    email: str = Field(min_length=3, max_length=254)
    code: str = Field(min_length=6, max_length=6, pattern=r"^[0-9]{6}$")
    password: str = Field(min_length=8, max_length=128)
    otp: str = Field(default="", max_length=80)


class PasswordChange(StrictModel):
    current: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=8, max_length=128)


class ProfileWrite(StrictModel):
    name: str = Field(min_length=1, max_length=40)


class AccountDelete(StrictModel):
    password: str = Field(min_length=1, max_length=128)


class Target(StrictModel):
    kind: Kind
    slug: str = Field(min_length=1, max_length=120)


class SmtpConfig(StrictModel):
    host: str = Field(default="", max_length=200, pattern=r"^$|^[A-Za-z0-9.-]+$")
    port: int = Field(default=465, ge=1, le=65535)
    security: Literal["ssl", "starttls"] = "ssl"
    username: str = Field(default="", max_length=254)
    fromName: str = Field(default="", max_length=60)
    fromAddress: str = Field(default="", max_length=254)


class AccountsConfig(StrictModel):
    registrationOpen: bool = False
    allowedDomains: list[str] = Field(default_factory=list, max_length=200)
    dailyLimit: int = Field(default=100, ge=1, le=2000)
    smtp: SmtpConfig
    # None 表示不修改；空字符串表示清除。
    smtpPassword: str | None = Field(default=None, max_length=200)

    @field_validator("allowedDomains")
    @classmethod
    def domains(cls, values):
        cleaned = sorted({v.strip().lower().lstrip("@") for v in values if v.strip()})
        if any(not re.fullmatch(r"[a-z0-9-]+(\.[a-z0-9-]+)+", v) for v in cleaned):
            raise ValueError("邮箱域名格式不正确")
        return cleaned


class TestMail(StrictModel):
    to: str = Field(min_length=3, max_length=254)


class UserState(StrictModel):
    disabled: bool


class ImageQuotaWrite(StrictModel):
    enabled: bool
    quota_mb: int = Field(ge=1, le=100_000)
    max_file_mb: int = Field(ge=1, le=20)


class TokenCreate(StrictModel):
    name: str = Field(default="", max_length=40)


class ReadingState(StrictModel):
    baseline: str = Field(min_length=1, max_length=40)
    read: list[str] = Field(default_factory=list, max_length=50_000)
    unread: list[str] = Field(default_factory=list, max_length=50_000)

    @field_validator("read", "unread")
    @classmethod
    def short_ids(cls, values):
        if any(len(v) > 100 for v in values):
            raise ValueError("通知编号过长")
        return values


class ReadingWrite(StrictModel):
    state: ReadingState


class ScoreWrite(StrictModel):
    score: int = Field(ge=0)
    duration: int = Field(ge=0, le=86400)
    floor: int = Field(default=0, ge=0, le=1000)


# —— 网盘 ——


class DrivePath(StrictModel):
    path: str = Field(min_length=1, max_length=4096)
    parents: bool = False


class DrivePaths(StrictModel):
    paths: list[str] = Field(min_length=1, max_length=500)


class DriveTransfer(StrictModel):
    paths: list[str] = Field(min_length=1, max_length=500)
    target: str = Field(min_length=1, max_length=4096)
    overwrite: bool = False


class DriveRename(StrictModel):
    path: str = Field(min_length=1, max_length=4096)
    name: str = Field(min_length=1, max_length=255)


class UploadCreate(StrictModel):
    path: str = Field(min_length=1, max_length=4096)
    size: int = Field(ge=0, le=50 * 1024**3)


class DriveLogin(StrictModel):
    login: str = Field(min_length=2, max_length=32)


class KeyCreate(StrictModel):
    name: str = Field(default="", max_length=80)
    key: str = Field(min_length=20, max_length=16_384)


class AppPasswordCreate(StrictModel):
    name: str = Field(default="", max_length=80)


class ShareCreate(StrictModel):
    paths: list[str] = Field(min_length=1, max_length=100)
    mode: Literal["read", "upload"] = "read"
    name: str = Field(default="", max_length=120)
    password: str = Field(default="", max_length=128)
    expires_at: float = Field(default=0, ge=0)
    max_uses: int = Field(default=0, ge=0, le=1_000_000)


class ShareUnlock(StrictModel):
    password: str = Field(max_length=128)


class StoragePlanWrite(StrictModel):
    drive_enabled: bool
    images_enabled: bool
    quota_mb: int = Field(ge=1, le=10_000_000)
    max_image_mb: int = Field(ge=1, le=20)


class MountCreate(StrictModel):
    path: str = Field(min_length=2, max_length=255)
    location: str = Field(min_length=1, max_length=1024)
    quota_mb: int = Field(default=0, ge=0, le=10_000_000)
    read_only: bool = False


class MountUpdate(StrictModel):
    quota_mb: int = Field(ge=0, le=10_000_000)
    read_only: bool


class FeedbackWrite(StrictModel):
    category: Literal["suggestion", "bug", "other"] = "suggestion"
    content: str = Field(min_length=5, max_length=2000)
    page: str = Field(default="", max_length=300)


class FeedbackUpdate(StrictModel):
    status: Literal["new", "read", "done"]
    reply: str | None = Field(default=None, max_length=2000)

from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator


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
    text: str = Field(default="", max_length=100)
    code: str = Field(default="", max_length=50, pattern=r"^[0-9]*$")


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
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=200)
    otp: str = Field(default="", max_length=80)


class SecurityProof(StrictModel):
    # 已在本会话验证身份时可留空。
    password: str = Field(default="", max_length=200)
    otp: str = Field(default="", max_length=80)


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

from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator


def safe_link(value: str, allow_media: bool = False) -> str:
    if allow_media and value.startswith("/media/") and ".." not in value:
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
        return safe_link(value)


class RepoGroup(StrictModel):
    title: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=300)
    prefix: str = Field(min_length=1, max_length=100)


class Police(StrictModel):
    text: str = Field(default="", max_length=100)
    code: str = Field(default="", max_length=50, pattern=r"^[0-9]*$")


class Site(StrictModel):
    name: str = Field(min_length=1, max_length=80)
    greeting: str = Field(max_length=100)
    roles: list[str] = Field(max_length=10)
    intro: str = Field(max_length=2000)
    github: str = Field(
        min_length=1, max_length=39, pattern=r"^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$"
    )
    cloud: str = Field(max_length=2048)
    notes: str = Field(max_length=2048)
    portals: list[Portal] = Field(max_length=30)
    repoGroups: list[RepoGroup] = Field(max_length=30)
    hiddenRepos: list[str] = Field(max_length=500)
    icp: str = Field(default="", max_length=100)
    police: Police

    @field_validator("cloud", "notes")
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
    password: str = Field(min_length=1, max_length=200)
    otp: str = Field(default="", max_length=80)


class PasskeySetup(SecurityProof):
    name: str = Field(min_length=1, max_length=80)


class PasskeyResponse(StrictModel):
    challenge_id: str = Field(min_length=1, max_length=100)
    credential: dict
    name: str = Field(default="Passkey", min_length=1, max_length=80)


class Preview(StrictModel):
    markdown: str = Field(max_length=500_000)

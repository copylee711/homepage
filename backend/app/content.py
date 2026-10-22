import json
import re
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import update
from sqlmodel import Session, select

from .models import Article, Content
from .schemas import Police, Site


def accounts_defaults() -> dict:
    from .accounts import ACCOUNTS_DEFAULTS

    return json.loads(json.dumps(ACCOUNTS_DEFAULTS))


NOTES_DEFAULTS = {
    "repo": "copylee711/notes",
    "branch": "master",
    "autoPublish": True,
    "exclude": [".*", "docs", "node_modules", "README.md"],
    "last_commit": "",
    "last_success": None,
    "last_error": "",
}


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def require_content(session: Session, key: str) -> Content:
    row = session.get(Content, key)
    if row is None:
        raise HTTPException(503, "内容尚未初始化，请运行 seed 工具")
    return row


def bump(session: Session, key: str):
    session.exec(update(Content).where(Content.key == key).values(revision=Content.revision + 1))


def versions(session: Session) -> dict:
    return {
        key: require_content(session, key).revision for key in ("site", "repos", "posts", "notes")
    }


def stored_site(session: Session) -> dict:
    value = dict(require_content(session, "site").value)
    # 旧数据的公安备案文字与编号分开存放，读取时补成完整备案号。
    value["police"] = Police.model_validate(value.get("police") or {}).model_dump()
    return value


def public_site(session: Session) -> dict:
    value = stored_site(session)
    value["portals"] = [p for p in value["portals"] if p.get("visible", True)]
    value["socials"] = [s for s in value.get("socials", []) if s.get("visible") and s.get("url")]
    return value


def initialize(session: Session, site: dict, repos: list) -> bool:
    if session.get(Content, "site"):
        return False
    site = Site.model_validate(site).model_dump()
    for key, value in (
        ("site", site),
        (
            "repos",
            {"items": repos, "github": site["github"], "last_success": None, "last_error": ""},
        ),
        ("posts", {}),
        ("notes", dict(NOTES_DEFAULTS)),
        ("accounts", accounts_defaults()),
    ):
        session.add(Content(key=key, value=value))
    session.commit()
    return True


def save_site(session: Session, site: dict, revision: int):
    previous = require_content(session, "site").value
    result = session.exec(
        update(Content)
        .where(Content.key == "site", Content.revision == revision)
        .values(value=site, revision=Content.revision + 1)
    )
    if result.rowcount != 1:
        raise HTTPException(409, "设置已被其他窗口修改，请重新加载")
    if previous["github"] != site["github"]:
        # 不把旧账号的仓库显示成新账号的仓库。
        session.exec(
            update(Content)
            .where(Content.key == "repos")
            .values(
                value={
                    "items": [],
                    "github": site["github"],
                    "last_success": None,
                    "last_error": "等待新账号同步",
                },
                revision=Content.revision + 1,
            )
        )
    session.commit()


def get_article(session: Session, article_id: str) -> Article:
    row = session.get(Article, article_id)
    if row is None:
        raise HTTPException(404, "文章不存在")
    return row


def public_article(session: Session, slug: str) -> dict:
    row = session.exec(select(Article).where(Article.slug == slug)).first()
    if not row or row.published is None:
        raise HTTPException(404, "文章不存在或已撤下")
    return row.published


def published_posts(session: Session) -> list[dict]:
    posts = [dict(row.published) for row in session.exec(select(Article)) if row.published]
    return sorted(posts, key=lambda p: p["published_at"], reverse=True)


def summaries(session: Session) -> list[dict]:
    return [
        {k: v for k, v in post.items() if k not in {"markdown", "html"}}
        for post in published_posts(session)
    ]


def update_article(session: Session, row: Article, revision: int, **values):
    result = session.exec(
        update(Article)
        .where(Article.id == row.id, Article.revision == revision)
        .values(**values, revision=Article.revision + 1, updated_at=timestamp())
    )
    if result.rowcount != 1:
        raise HTTPException(409, "文章已被其他窗口修改，请重新加载后再操作")


def adjacent_posts(session: Session, slug: str) -> tuple[dict | None, dict | None]:
    """返回 (较新, 较旧) 的相邻已发布文章摘要。"""
    posts = summaries(session)
    index = next((i for i, post in enumerate(posts) if post["slug"] == slug), None)
    if index is None:
        return None, None
    newer = posts[index - 1] if index > 0 else None
    older = posts[index + 1] if index + 1 < len(posts) else None
    return newer, older


def reading_stats(markdown: str) -> dict:
    """中文按字、拉丁文按词计数；约 400 字/分钟。"""
    text = re.sub(r"```.*?```|`[^`]*`|!\[[^\]]*\]\([^)]*\)|\]\([^)]*\)|[#>*_\-|]", " ", markdown, flags=re.S)
    words = len(re.findall(r"[㐀-鿿豈-﫿]", text)) + len(re.findall(r"[A-Za-z0-9]+(?:['’][A-Za-z]+)?", text))
    return {"words": words, "minutes": max(1, round(words / 400))}

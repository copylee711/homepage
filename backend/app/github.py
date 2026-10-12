import asyncio
import logging

import httpx
from sqlalchemy import update
from sqlmodel import Session

from .content import require_content, timestamp
from .models import Content

logger = logging.getLogger(__name__)


async def fetch_repos(username: str, token: str, transport=None) -> list[dict]:
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "copylee-homepage"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    items = []
    async with httpx.AsyncClient(timeout=15, headers=headers, transport=transport) as client:
        # GitHub 每页最多 100 条；只有全部页成功后才返回完整结果。
        for page in range(1, 101):
            response = await client.get(
                f"https://api.github.com/users/{username}/repos",
                params={"type": "owner", "per_page": 100, "page": page},
            )
            response.raise_for_status()
            batch = response.json()
            if not isinstance(batch, list):
                raise ValueError("GitHub 返回格式无效")
            for repo in batch:
                if repo["fork"] or repo["archived"] or repo["private"]:
                    continue
                items.append(
                    {
                        "name": repo["name"],
                        "description": repo["description"] or "",
                        "url": repo["html_url"],
                        "homepage": repo["homepage"] or "",
                        "language": repo["language"] or "",
                        "stars": repo["stargazers_count"],
                        "pushedAt": repo["pushed_at"],
                    }
                )
            if len(batch) < 100:
                return items
        raise ValueError("仓库分页超过安全上限")


async def sync_repos(app) -> dict:
    async with app.state.sync_lock:
        with Session(app.state.engine) as session:
            site_row = require_content(session, "site")
            username, site_revision = site_row.value["github"], site_row.revision
        try:
            items = await fetch_repos(username, app.state.settings.github_token)
            error = ""
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
            # 不记录包含请求头/凭据的异常全文。
            error = f"GitHub 同步失败：{type(exc).__name__}"
            if isinstance(exc, httpx.HTTPStatusError):
                error += f" (HTTP {exc.response.status_code})"
            items = None
            logger.warning(error)
        with Session(app.state.engine) as session:
            session.connection().exec_driver_sql("BEGIN IMMEDIATE")
            site_row = require_content(session, "site")
            if site_row.revision != site_revision or site_row.value["github"] != username:
                return {"ok": False, "error": "同步期间设置发生变化，请重试"}
            row = require_content(session, "repos")
            value = dict(row.value)
            value["last_error"] = error
            if items is not None:
                value.update(items=items, github=username, last_success=timestamp())
            session.exec(
                update(Content)
                .where(Content.key == "repos")
                .values(value=value, revision=Content.revision + (1 if items is not None else 0))
            )
            session.commit()
            return {"ok": items is not None, "error": error, "last_success": value["last_success"]}


async def sync_loop(app):
    while True:
        try:
            await sync_repos(app)
        except Exception:
            logger.exception("仓库同步任务失败")
        await asyncio.sleep(900)

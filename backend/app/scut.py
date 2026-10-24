"""Public list-only indexing. No article/attachment requests are permitted here."""
import asyncio
import contextlib
import hashlib
import logging
import math
import re
import ssl
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urljoin, urlsplit
from urllib.robotparser import RobotFileParser

import httpx
from bs4 import BeautifulSoup
from sqlmodel import Session, select

from .models import ScutColumn, ScutMembership, ScutNotice

logger = logging.getLogger(__name__)
AGENT = "CopyLee-SCUT/1.0"
JW = "https://jw.scut.edu.cn"
JW_API = JW + "/zhinan/cms/article/v2/findInformNotice.do"
MATH_HOME = "https://www2.scut.edu.cn/math/"
# WebPlus 只把前 10 页列表生成静态 listN.htm，之后由动态 listN.psp 提供（学院站）；
# 学校主站不提供动态分页，第 11 页起返回 404，可采集的历史到此为止。
STATIC_PAGES = 10


class HistoryEnd(Exception):
    """官网不再提供更早的列表分页。"""


@dataclass(frozen=True)
class Column:
    id: str
    source: str
    name: str
    url: str
    category: int | None = None
    tag: int | None = None
    article_category: str = ""


COLUMNS = [
    Column("school-academic", "school", "学术预告",
           "https://www.scut.edu.cn/new/9010/list.htm"),
    Column("school-teaching", "school", "教学科研通知",
           "https://www.scut.edu.cn/new/9011/list.htm"),
    *[Column(f"math-{key}", "math", name, MATH_HOME + path + "/list.htm",
             article_category=category) for key, name, path, category in [
        ("office", "院务通知", "6976", "10155"),
        ("undergrad", "本科生教务", "bksjw", "14432"),
        ("graduate", "研究生教务", "yjsjw", "14433"),
        ("research", "科研通知", "kytz", "14434"),
        ("student", "学工通知", "xgtz", "10347"),
        ("academic", "学术报告", "6981", "10160"),
        ("news", "学院新闻", "6970", "10149"),
        ("activity", "学院动态", "xydt", ""),
    ]],
    *[Column(f"jw-{category}-{tag}", "jw", f"{group} · {name}",
             JW + f"/zhinan/cms/toPosts.do?category={category}", category, tag)
      for category, group in [(0, "通知公告"), (1, "学院通知")]
      for tag, name in [(6, "信息"), (1, "选课"), (2, "考试"),
                        (4, "交流"), (3, "实践"), (5, "教师")]],
]
SOURCES = [
    {"id": "school", "name": "学校主站", "url": "https://www.scut.edu.cn/"},
    {"id": "math", "name": "数学学院", "url": MATH_HOME},
    {"id": "jw", "name": "本科生院", "url": JW + "/zhinan/cms/index.do"},
]


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_date(value: str, url: str = "") -> str | None:
    match = re.search(r"(20\d{2})[.年/-](\d{1,2})[.月/-](\d{1,2})", value)
    if not match:
        match = re.search(r"/(20\d{2})/(\d{2})(\d{2})/", url)
    if match:
        try:
            return datetime(*map(int, match.groups())).date().isoformat()
        except ValueError:
            pass
    return None


def notice_url(href: str, base: str) -> str | None:
    url = urljoin(base, href.strip())
    parts = urlsplit(url)
    if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username:
        return None
    # The same WebPlus article is often linked with both HTTP and HTTPS.
    if parts.hostname in {"www.scut.edu.cn", "www2.scut.edu.cn", "jw.scut.edu.cn"}:
        url = "https:" + url[url.index(":") + 1:]
    return url.split("#", 1)[0]


@dataclass
class Page:
    items: list[dict]
    total_pages: int


def parse_html(markup: bytes | str, base: str, *, homepage: bool = False) -> Page:
    soup = BeautifulSoup(markup, "html.parser")
    items = []
    for row in soup.select(".wp_article_list li.list_item, .column-news-item"):
        anchor = row.select_one(".Article_Title a[href], .column-news-title a[href]")
        if not anchor:
            continue
        href = notice_url(str(anchor.get("href", "")), base)
        title = str(anchor.get("title") or anchor.get_text(" ", strip=True)).strip()
        if not href or not title:
            continue
        date_node = row.select_one(".Article_PublishDate, .column-news-date, .Article_Date")
        published = normalize_date(date_node.get_text(strip=True) if date_node else "", href)
        portlet = row.find_parent(id=re.compile(r"^wp_news_"))
        items.append({"url": href, "title": title, "published_at": published,
                      "portlet": portlet.get("id", "") if portlet else ""})
    paging = soup.select_one(".wp_paging .all_pages")
    if homepage:
        return Page(items, 1)
    if not paging or not paging.get_text(strip=True).isdigit():
        raise ValueError("列表分页结构无法识别")
    total = int(paging.get_text(strip=True))
    if not items:
        raise ValueError("列表异常为空，保留原索引")
    return Page(items, max(1, total))


def parse_jw(data: dict) -> Page:
    if data.get("success") is not True or not isinstance(data.get("list"), list):
        raise ValueError("教务列表返回格式无效")
    total = data.get("total")
    if not isinstance(total, int) or total < 0:
        raise ValueError("教务列表总数无效")
    items = []
    for row in data["list"]:
        identifier = row.get("id", "")
        title = row.get("title", "")
        if not isinstance(identifier, str) or not re.fullmatch(r"[a-zA-Z0-9_-]+", identifier):
            raise ValueError("教务通知标识无效")
        if not isinstance(title, str) or not title.strip():
            raise ValueError("教务通知标题缺失")
        items.append({"url": JW + "/zhinan/cms/article/view.do?type=posts&id=" + identifier,
                      "title": title.strip(),
                      "published_at": normalize_date(str(row.get("createTime", "")))})
    if total and not items:
        raise ValueError("非空栏目返回空页，保留原索引")
    return Page(items, max(1, math.ceil(total / 20)))


def allowed_request(url: str) -> bool:
    """A hard boundary independent of robots.txt: never fetch an article."""
    p = urlsplit(url)
    if p.scheme != "https" or p.query or p.fragment or p.username:
        return False
    if p.hostname not in {"www.scut.edu.cn", "www2.scut.edu.cn", "jw.scut.edu.cn"}:
        return False
    if p.path == "/robots.txt":
        return True
    if url in {MATH_HOME, JW_API}:
        return True
    return any(p.hostname == urlsplit(c.url).hostname
               and re.fullmatch(re.escape(urlsplit(c.url).path.replace("/list.htm", "/"))
                                + r"list(?:[1-9]\d*)?\.(?:htm|psp)", p.path)
               for c in COLUMNS if c.source != "jw")


class ListClient:
    def __init__(self):
        school_tls = ssl.create_default_context()
        school_tls.set_ciphers("DEFAULT:@SECLEVEL=1")
        self.clients = {host: httpx.AsyncClient(
            timeout=20, follow_redirects=False,
            verify=school_tls if host == "www.scut.edu.cn" else True,
            headers={"User-Agent": AGENT})
            for host in ("www.scut.edu.cn", "www2.scut.edu.cn", "jw.scut.edu.cn")}
        self.locks = {host: asyncio.Lock() for host in self.clients}
        self.last_request = dict.fromkeys(self.clients, 0.0)
        self.robots: dict[str, RobotFileParser] = {}

    async def close(self):
        for client in self.clients.values():
            await client.aclose()

    async def raw(self, url: str, data: dict | None = None) -> httpx.Response:
        if not allowed_request(url):
            raise ValueError("采集请求超出列表白名单")
        host = urlsplit(url).hostname
        async with self.locks[host]:
            for attempt in range(3):
                await asyncio.sleep(max(0, 2 - (time.monotonic() - self.last_request[host])))
                self.last_request[host] = time.monotonic()
                try:
                    response = await self.clients[host].request(
                        "POST" if data is not None else "GET", url, data=data)
                    # No automatic redirect can escape the list whitelist.
                    if response.is_redirect:
                        raise ValueError("官网列表发生重定向，需核对栏目地址")
                    if response.status_code == 429 or response.status_code >= 500:
                        response.raise_for_status()
                    return response
                except httpx.HTTPError:
                    if attempt == 2:
                        raise
                    await asyncio.sleep(2 ** attempt)
        raise RuntimeError("列表请求未完成")

    async def get(self, url: str, data: dict | None = None) -> httpx.Response:
        host = urlsplit(url).hostname
        if host not in self.robots:
            response = await self.raw(f"https://{host}/robots.txt")
            policy = RobotFileParser()
            if response.status_code in {404, 410}:
                policy.parse([])
            else:
                response.raise_for_status()
                lines = response.text.splitlines()
                if not any(line.lower().startswith("user-agent:") for line in lines):
                    lines.insert(0, "User-agent: *")
                policy.parse(lines)
            self.robots[host] = policy
        if not self.robots[host].can_fetch(AGENT, url):
            raise ValueError("官网 robots.txt 限制访问该栏目")
        response = await self.raw(url, data)
        response.raise_for_status()
        return response

    async def page(self, column: Column, number: int) -> Page:
        if column.source == "jw":
            response = await self.get(JW_API, {"category": column.category, "tag": column.tag,
                                              "keyword": "", "pageNum": number, "pageSize": 20})
            return parse_jw(response.json())
        suffix = "htm" if number <= STATIC_PAGES else "psp"
        url = column.url.replace("list.htm", f"list{number}.{suffix}") if number > 1 else column.url
        try:
            response = await self.get(url)
        except httpx.HTTPStatusError as exc:
            if number > STATIC_PAGES and exc.response.status_code == 404:
                raise HistoryEnd from None
            raise
        return parse_html(response.content, url)


def save_items(session: Session, column: Column, items: list[dict], cutoff: str, seen: str):
    for item in items:
        # Unknown dates remain visible; never fabricate a current publication date.
        existing = session.get(ScutNotice, item["url"])
        if not existing and item["published_at"] and item["published_at"] < cutoff:
            continue
        if existing is None:
            existing = ScutNotice(url=item["url"], title=item["title"],
                                  published_at=item["published_at"], first_seen=seen)
        else:
            existing.title = item["title"]
            if item["published_at"]:
                existing.published_at = item["published_at"]
        session.add(existing)
        session.flush()
        if not session.get(ScutMembership, (item["url"], column.id)):
            session.add(ScutMembership(url=item["url"], column_id=column.id))


async def sync_column(engine, client, column: Column, home: list[dict],
                      home_error: str, scan_budget: int):
    stamp = now()
    cutoff = (datetime.now(timezone(timedelta(hours=8))) - timedelta(days=365)).date().isoformat()
    with Session(engine) as session:
        state = session.get(ScutColumn, column.id) or ScutColumn(id=column.id)
        state.last_attempt = stamp
        session.add(state)
        session.commit()
        known = set(session.exec(select(ScutMembership.url).where(
            ScutMembership.column_id == column.id)).all())
        full_due = not state.last_full_scan or (
            datetime.now(timezone.utc) - datetime.fromisoformat(state.last_full_scan)
        ).total_seconds() >= 86400
        try:
            save_items(session, column, home, cutoff, stamp)
            session.commit()
            visited: dict[int, Page] = {}
            # Recent checks always run, even while a long historical scan is pending.
            for number in range(1, 201):
                try:
                    page = await client.page(column, number)
                except HistoryEnd:
                    break
                if not page.items and known:
                    raise ValueError("已有记录的栏目异常为空，保留原索引")
                visited[number] = page
                all_known = bool(page.items) and all(
                    i["url"] in known or (i["published_at"] and i["published_at"] < cutoff)
                    for i in page.items)
                save_items(session, column, page.items, cutoff, stamp)
                state.total_pages = page.total_pages
                # Commit each page: durable progress and no write lock held during network I/O.
                session.add(state)
                session.commit()
                if number >= page.total_pages or (
                    number >= 2 and (all_known or not state.initialized)
                ):
                    break
            else:
                raise ValueError("本轮增量分页达到上限，需继续核对")
            if full_due:
                if not state.scan_started:
                    state.scan_started = stamp
                    state.scan_page = 1
                    state.pages_scanned = 0
                # Scan to the real last page, not a date boundary: handles old pinned/unsorted rows.
                for _ in range(scan_budget):
                    number = state.scan_page
                    try:
                        page = visited.get(number) or await client.page(column, number)
                    except HistoryEnd:
                        # 官网能翻到的历史已全部采集，视为完成一次完整扫描。
                        state.initialized = True
                        state.last_full_scan = stamp
                        state.scan_started = None
                        state.scan_page = 1
                        session.add(state)
                        session.commit()
                        break
                    if not page.items and known:
                        raise ValueError("历史分页异常为空，保留扫描位置")
                    save_items(session, column, page.items, cutoff, stamp)
                    state.pages_scanned = number
                    state.total_pages = page.total_pages
                    state.scan_page = number + 1
                    if number >= page.total_pages:
                        state.initialized = True
                        state.last_full_scan = stamp
                        state.scan_started = None
                        state.scan_page = 1
                    session.add(state)
                    session.commit()
                    if state.scan_started is None:
                        break
            if column.source == "math" and home_error:
                # List updates are still useful, but the combined homepage/list check is incomplete.
                state.last_error = home_error
            else:
                state.last_success = now()
                state.last_error = ""
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
            session.rollback()
            state = session.get(ScutColumn, column.id)
            state.last_error = str(exc) if isinstance(exc, ValueError) else type(exc).__name__
            logger.warning("SCUT %s: %s", column.id, state.last_error)
        state.revision += 1
        session.add(state)
        session.commit()


@contextlib.contextmanager
def run_lock(engine):
    """One process at a time, shared by the service and the maintenance CLI."""
    path = Path(engine.url.database).parent / ".scut-sync.lock"
    with path.open("a+b") as handle:
        handle.seek(0, 2)
        if handle.tell() == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        if sys.platform == "win32":
            import msvcrt
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as exc:
                raise RuntimeError("SCUT 采集任务已在运行") from exc
        else:
            import fcntl
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise RuntimeError("SCUT 采集任务已在运行") from exc
        try:
            yield
        finally:
            handle.seek(0)
            if sys.platform == "win32":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


async def sync_scut(engine, scan_budget: int = 5, client=None):
    with run_lock(engine):
        await _sync_scut(engine, scan_budget, client)


async def _sync_scut(engine, scan_budget: int, client=None):
    owned = client is None
    client = client or ListClient()
    try:
        home, home_error = [], ""
        try:
            home = parse_html((await client.get(MATH_HOME)).content,
                              MATH_HOME, homepage=True).items
            if not home:
                raise ValueError("数学学院首页结构无法识别")
        except (httpx.HTTPError, ValueError) as exc:
            home_error = "数学学院首页检查失败：" + type(exc).__name__
        # Map each homepage portlet by its internal links, including external links in that portlet.
        portlets = {}
        for item in home:
            match = re.search(r"/c(\d+)a\d+/page.htm", item["url"])
            if match:
                portlets[item["portlet"]] = match[1]
        async def run(column):
            subset = [i for i in home if column.article_category
                      and portlets.get(i["portlet"]) == column.article_category]
            await sync_column(engine, client, column, subset, home_error, scan_budget)
        # One worker per domain, so robots initialization and per-host pacing are serialized.
        async def source_worker(source):
            for column in COLUMNS:
                if column.source == source:
                    await run(column)
        await asyncio.gather(*(source_worker(source) for source in ("school", "math", "jw")))
    finally:
        if owned:
            await client.close()


def public_scut(session: Session) -> dict:
    memberships: dict[str, list[str]] = {}
    for relation in session.exec(select(ScutMembership)).all():
        memberships.setdefault(relation.url, []).append(relation.column_id)
    items = [{"id": hashlib.sha256(row.url.encode()).hexdigest(), "url": row.url,
              "title": row.title, "published_at": row.published_at, "first_seen": row.first_seen,
              "columns": sorted(memberships.get(row.url, []))}
             for row in session.exec(select(ScutNotice)).all()]
    items.sort(key=lambda i: (i["published_at"] or "", i["first_seen"], i["id"]), reverse=True)
    columns = []
    for column in COLUMNS:
        state = session.get(ScutColumn, column.id) or ScutColumn(id=column.id)
        columns.append({"id": column.id, "source": column.source, "name": column.name,
                        "url": column.url, **state.model_dump(exclude={"id"})})
    return {"items": items, "columns": columns, "sources": SOURCES,
            "revision": sum(c["revision"] for c in columns), "interval_seconds": 600}


async def sync_loop(app):
    while True:
        started = time.monotonic()
        try:
            async with app.state.scut_lock:
                await sync_scut(app.state.engine)
        except Exception:
            logger.exception("SCUT 同步任务失败")
        await asyncio.sleep(max(1, 600 - (time.monotonic() - started)))

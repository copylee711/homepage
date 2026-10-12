import asyncio
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from sqlmodel import Session

from app.cli import backup, migrate, restore, seed
from app.database import make_engine
from app.models import ScutColumn, ScutNotice
from app.scut import (
    COLUMNS,
    MATH_HOME,
    ListClient,
    Page,
    allowed_request,
    normalize_date,
    parse_html,
    parse_jw,
    public_scut,
    run_lock,
    sync_column,
    sync_scut,
)
from app.settings import Settings


@pytest.fixture
def index(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", scut_sync_enabled=False, sync_enabled=False)
    migrate(settings)
    seed(settings)
    engine = make_engine(settings)
    yield engine, settings
    engine.dispose()


def item(key, date=None):
    return {"url": f"https://www2.scut.edu.cn/math/2026/1012/c10155a{key}/page.htm",
            "title": f"通知 {key}", "published_at": date}


def test_html_full_titles_external_links_and_dates():
    html = """<nav><a href='/admin'>后台</a></nav><div id='wp_news_w7'>
    <ul class='wp_article_list'><li class='list_item'>
    <span class='Article_Title'><a href='/math/2026/1010/c10155a1/page.htm'
    title='完整标题而不是省略…'>省略…</a></span><span class='Article_PublishDate'>2026-10-11</span></li>
    <li class='list_item'><span class='Article_Title'><a href='https://mp.weixin.qq.com/s/example'
    title='外部竞赛'>外部…</a></span><span class='Article_PublishDate'>10-09</span></li></ul></div>
    <ul class='wp_paging'><em class='all_pages'>3</em></ul>"""
    result = parse_html(html, MATH_HOME)
    assert result.total_pages == 3
    assert len(result.items) == 2
    assert result.items[0]["title"] == "完整标题而不是省略…"
    assert result.items[0]["published_at"] == "2026-10-11"
    assert result.items[1]["published_at"] is None
    assert result.items[1]["portlet"] == "wp_news_w7"
    assert normalize_date("", result.items[0]["url"]) == "2026-10-10"
    with pytest.raises(ValueError):
        parse_html("<title>登录</title>", MATH_HOME)


def test_jw_empty_and_pagination():
    result = parse_jw({"success": True, "total": 21,
                       "list": [{"id": "abc123", "title": "选课", "createTime": "2026.10.09"}]})
    assert result.total_pages == 2
    assert result.items[0]["published_at"] == "2026-10-09"
    assert "type=posts&id=abc123" in result.items[0]["url"]
    assert parse_jw({"success": True, "total": 0, "list": []}).items == []
    with pytest.raises(ValueError):
        parse_jw({"success": True, "total": 2, "list": []})


def test_hard_request_boundary():
    assert allowed_request(MATH_HOME)
    assert allowed_request(COLUMNS[0].url.replace("list.htm", "list4.htm"))
    assert allowed_request("https://jw.scut.edu.cn/robots.txt")
    for url in [item(1)["url"], "https://mp.weixin.qq.com/s/test",
                "https://www2.scut.edu.cn/_upload/a.pdf", "http://www.scut.edu.cn/new/9010/list.htm",
                COLUMNS[0].url + "?redirect=bad"]:
        assert not allowed_request(url)


class FakeClient:
    def __init__(self, pages):
        self.pages = pages
        self.calls = []

    async def page(self, column, number):
        self.calls.append((column.id, number))
        result = self.pages[number]
        if isinstance(result, Exception):
            raise result
        return result


def test_resumable_unsorted_history_dedupe_failure_and_restart(index):
    engine, _ = index
    column = COLUMNS[2]
    today = datetime.now(timezone.utc).date().isoformat()
    client = FakeClient({1: Page([item(1, "2020-01-01")], 3),
                         2: Page([item(2, "2020-01-02")], 3),
                         3: Page([item(3, today)], 3)})
    asyncio.run(sync_column(engine, client, column, [item(4, today)], "", 2))
    with Session(engine) as session:
        assert not session.get(ScutColumn, column.id).initialized
        assert session.get(ScutColumn, column.id).scan_page == 3
    asyncio.run(sync_column(engine, client, column, [], "", 2))
    with Session(engine) as session:
        result = public_scut(session)
        assert len(result["items"]) == 2
        assert session.get(ScutColumn, column.id).initialized
        success = session.get(ScutColumn, column.id).last_success
        seen = session.get(ScutNotice, item(3)["url"]).first_seen
    # Same URL in a second column gains membership, not a duplicate notice.
    asyncio.run(sync_column(engine, FakeClient({1: Page([item(3, today)], 1)}),
                            COLUMNS[3], [], "", 5))
    # Existing timestamps stay stable and edited titles are updated.
    edited = {**item(3, today), "title": "修订后的标题"}
    asyncio.run(sync_column(engine, FakeClient({1: Page([edited], 1)}), column, [], "", 5))
    with Session(engine) as session:
        assert session.get(ScutNotice, edited["url"]).first_seen == seen
        assert session.get(ScutNotice, edited["url"]).title == "修订后的标题"
        assert len(next(i for i in public_scut(session)["items"] if i["url"] == edited["url"])["columns"]) == 2
        success = session.get(ScutColumn, column.id).last_success
    asyncio.run(sync_column(engine, FakeClient({1: ValueError("结构改变")}), column, [], "", 5))
    with Session(engine) as session:
        state = session.get(ScutColumn, column.id)
        assert state.last_success == success
        assert state.last_error == "结构改变"
        assert len(public_scut(session)["items"]) == 2


def test_empty_existing_column_is_failure(index):
    engine, _ = index
    column = COLUMNS[-1]
    asyncio.run(sync_column(engine, FakeClient({1: Page([item(7)], 1)}), column, [], "", 5))
    asyncio.run(sync_column(engine, FakeClient({1: Page([], 1)}), column, [], "", 5))
    with Session(engine) as session:
        assert session.get(ScutColumn, column.id).last_error
        assert session.get(ScutNotice, item(7)["url"])


def test_homepage_failure_still_indexes_math_lists(index):
    engine, _ = index
    column = COLUMNS[2]
    asyncio.run(sync_column(engine, FakeClient({1: Page([item(7)], 1)}),
                            column, [], "首页受限", 5))
    with Session(engine) as session:
        assert session.get(ScutNotice, item(7)["url"])
        assert session.get(ScutColumn, column.id).last_error == "首页受限"
        assert session.get(ScutColumn, column.id).last_success is None


def test_lock_and_backup_restore(index, tmp_path):
    engine, settings = index
    with run_lock(engine):
        with pytest.raises(RuntimeError, match="已在运行"):
            with run_lock(engine):
                pass
    asyncio.run(sync_column(engine, FakeClient({1: Page([item(8)], 1)}), COLUMNS[0], [], "", 5))
    snapshot = backup(settings)
    destination = tmp_path / "restored"
    restore(snapshot, destination)
    other = make_engine(Settings(data_dir=destination))
    with Session(other) as session:
        assert len(public_scut(session)["items"]) == 1
    other.dispose()


def test_public_endpoint_and_direct_page(server):
    client, _, settings = server
    response = client.get("/api/scut")
    assert response.status_code == 200
    assert len(response.json()["columns"]) == 22
    assert response.json()["items"] == []
    assert response.json()["sync_enabled"] is False
    settings.static_dir.mkdir(exist_ok=True)
    (settings.static_dir / "index.html").write_text("<h1>app</h1>", encoding="utf-8")
    assert client.get("/scut").status_code == 200
    assert client.get("/scut/").status_code == 200


def test_daily_rescan_updates_back_pages(index):
    engine, _ = index
    col = COLUMNS[0]
    client = FakeClient({i: Page([item(i)], 3) for i in range(1, 4)})
    asyncio.run(sync_column(engine, client, col, [], "", 5))
    with Session(engine) as session:
        state = session.get(ScutColumn, col.id)
        state.last_full_scan = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
        session.add(state)
        session.commit()
    client.pages[3] = Page([item(90)], 3)
    asyncio.run(sync_column(engine, client, col, [], "", 5))
    with Session(engine) as session:
        assert session.get(ScutNotice, item(90)["url"])


def test_homepage_external_link_membership_and_partial_success(index, monkeypatch):
    engine, _ = index
    monkeypatch.setattr("app.scut.COLUMNS", COLUMNS[:4])
    class HomeClient(FakeClient):
        async def get(self, url):
            assert url == MATH_HOME
            return httpx.Response(200, text="""<div id='wp_news_w7'><ul class='wp_article_list'>
            <li class='list_item'><span class='Article_Title'><a href='/math/2026/1012/c10155a5/page.htm'>内链</a></span></li>
            <li class='list_item'><span class='Article_Title'><a href='https://mp.weixin.qq.com/s/test'>外链</a></span></li>
            </ul></div>""")
        async def page(self, column, number):
            if column.id == "school-academic":
                raise ValueError("受限")
            return Page([item(6)], 1)
    asyncio.run(sync_scut(engine, client=HomeClient({})))
    with Session(engine) as session:
        assert session.get(ScutColumn, "school-academic").last_error
        assert session.get(ScutColumn, "school-teaching").last_success
        external = next(i for i in public_scut(session)["items"] if "weixin" in i["url"])
        assert external["columns"] == ["math-office"]


def test_retry_and_robots_no_detail_requests(monkeypatch):
    async def scenario():
        client = ListClient()
        requests = []
        async def handler(request):
            requests.append(str(request.url))
            if request.url.path == "/robots.txt":
                return httpx.Response(404)
            count = requests.count(str(request.url))
            return httpx.Response(503 if count < 3 else 200, text="ok")
        async def no_sleep(_):
            pass
        monkeypatch.setattr("app.scut.asyncio.sleep", no_sleep)
        for old in client.clients.values():
            await old.aclose()
        client.clients = {host: httpx.AsyncClient(transport=httpx.MockTransport(handler))
                          for host in client.clients}
        try:
            assert (await client.get(COLUMNS[0].url)).status_code == 200
            assert len(requests) == 4
            assert all(allowed_request(url) for url in requests)
            with pytest.raises(ValueError):
                await client.get(item(1)["url"])
        finally:
            await client.close()
    asyncio.run(scenario())

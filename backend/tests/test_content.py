import asyncio
import sqlite3
from contextlib import closing
from io import BytesIO
from xml.etree.ElementTree import fromstring

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlmodel import Session

from app.auth import set_admin
from app.cli import backup, migrate, restore, seed
from app.github import fetch_repos, sync_repos
from app.main import create_app
from app.models import Content
from app.settings import Settings

PASSWORD = "local-test-password-only"
ORIGIN = "http://localhost:8000"


@pytest.fixture
def server(tmp_path):
    settings = Settings(
        data_dir=tmp_path / "data", static_dir=tmp_path / "dist", sync_enabled=False,
        scut_sync_enabled=False,
    )
    migrate(settings)
    seed(settings)
    app = create_app(settings)
    with Session(app.state.engine) as session:
        set_admin(session, "admin", PASSWORD)
    with TestClient(app, base_url=ORIGIN) as client:
        yield client, app, settings


def login(client):
    response = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": PASSWORD},
        headers={"Origin": ORIGIN},
    )
    assert response.status_code == 200, response.text
    assert "HttpOnly" in response.headers["set-cookie"]
    assert "SameSite=lax" in response.headers["set-cookie"]
    return {"Origin": ORIGIN, "X-CSRF-Token": response.json()["csrf"]}


def create_post(client, headers, **changes):
    draft = {
        "title": "A test article",
        "slug": "first-post",
        "summary": "A short summary",
        "markdown": "# First\n\nPublic **body**.",
        "cover": "",
        **changes,
    }
    response = client.post("/api/admin/posts", json=draft, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


def test_sitemap_public_routes_and_robots(server):
    client, _, _ = server
    response = client.get("/sitemap.xml")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/xml")
    namespace = "{http://www.sitemaps.org/schemas/sitemap/0.9}"
    root = fromstring(response.content)
    assert root.tag == namespace + "urlset"
    urls = [entry.findtext(namespace + "loc") for entry in root]
    assert len(urls) == len(set(urls))
    expected = {
        "/", "/scut", "/posts", "/notes", "/privacy", "/games",
        "/games/watermelon", "/games/sheep", "/games/dungeon",
    }
    assert {ORIGIN + path for path in expected}.issubset(urls)
    assert all(url.startswith(ORIGIN + "/") for url in urls)
    assert not any("/admin" in url or "/api/" in url or "/account" in url for url in urls)
    assert f"Sitemap: {ORIGIN}/sitemap.xml" in client.get("/robots.txt").text


def test_seed_is_idempotent_and_public_configuration(server):
    client, app, settings = server
    headers = login(client)
    value = client.get("/api/admin/site").json()
    value["site"]["intro"] = "changed without rebuild"
    value["site"]["portals"][0]["visible"] = False
    assert client.put("/api/admin/site", json=value, headers=headers).status_code == 200
    assert seed(settings) is False
    assert client.get("/api/site").json()["site"]["intro"] == "changed without rebuild"
    assert len(client.get("/api/site").json()["site"]["portals"]) == 2
    assert client.get("/api/version").json()["site"] == 2
    assert client.put("/api/admin/site", json=value, headers=headers).status_code == 409
    assert client.get("/api/site").headers["cache-control"] == "no-store"


def test_draft_publish_edit_and_unpublish(server):
    client, _, _ = server
    headers = login(client)
    post = create_post(client, headers)
    identifier = post["id"]
    assert client.get("/api/posts/first-post").status_code == 404
    assert "first-post" not in client.get("/sitemap.xml").text
    assert client.get("/posts/first-post").status_code == 404
    assert (
        client.post(
            f"/api/admin/posts/{identifier}/publish", json={"revision": 1}, headers=headers
        ).status_code
        == 200
    )
    public = client.get("/api/posts/first-post").json()
    assert "Public" in public["html"]
    assert "Public" in client.get("/posts/first-post").text
    assert "first-post" in client.get("/sitemap.xml").text
    post = client.get(f"/api/admin/posts/{identifier}").json()
    post["draft"]["markdown"] = "UNPUBLISHED SECRET"
    assert (
        client.put(
            f"/api/admin/posts/{identifier}",
            json={"revision": 2, "draft": post["draft"]},
            headers=headers,
        ).status_code
        == 200
    )
    assert "UNPUBLISHED SECRET" not in client.get("/api/posts/first-post").text
    assert "UNPUBLISHED SECRET" not in client.get("/posts/first-post").text
    # 发布时也必须携带当前版本；旧窗口不能发布较新的草稿。
    assert (
        client.post(
            f"/api/admin/posts/{identifier}/publish", json={"revision": 2}, headers=headers
        ).status_code
        == 409
    )
    assert (
        client.post(
            f"/api/admin/posts/{identifier}/publish", json={"revision": 3}, headers=headers
        ).status_code
        == 200
    )
    assert "UNPUBLISHED SECRET" in client.get("/posts/first-post").text
    assert (
        client.post(
            f"/api/admin/posts/{identifier}/unpublish", json={"revision": 4}, headers=headers
        ).status_code
        == 200
    )
    assert client.get("/api/posts/first-post").status_code == 404
    assert client.get("/posts/first-post").status_code == 404
    assert client.get("/api/posts").json()["items"] == []
    assert "first-post" not in client.get("/sitemap.xml").text
    post["draft"]["slug"] = "new-slug"
    assert (
        client.put(
            f"/api/admin/posts/{identifier}",
            json={"revision": 5, "draft": post["draft"]},
            headers=headers,
        ).status_code
        == 422
    )


def test_same_slug_and_edit_conflicts(server):
    client, _, _ = server
    headers = login(client)
    post = create_post(client, headers)
    assert client.post("/api/admin/posts", json=post["draft"], headers=headers).status_code == 409
    change = {"revision": 1, "draft": {**post["draft"], "title": "Window A"}}
    url = f"/api/admin/posts/{post['id']}"
    assert client.put(url, json=change, headers=headers).status_code == 200
    change["draft"]["title"] = "Window B"
    assert client.put(url, json=change, headers=headers).status_code == 409
    assert client.get(url).json()["draft"]["title"] == "Window A"


def test_security_origin_csrf_expiry_reset_logout(server):
    client, app, _ = server
    assert client.get("/api/admin/site").status_code == 401
    assert (
        client.post("/api/auth/login", json={"username": "admin", "password": PASSWORD}).status_code
        == 403
    )
    headers = login(client)
    assert client.cookies.get("copylee_session")
    site = client.get("/api/admin/site").json()
    assert client.put("/api/admin/site", json=site, headers={"Origin": ORIGIN}).status_code == 403
    assert (
        client.put(
            "/api/admin/site", json=site, headers={**headers, "Origin": "https://evil.invalid"}
        ).status_code
        == 403
    )
    assert client.get("/api/auth/me").headers["cache-control"] == "no-store"
    assert client.post("/api/auth/logout", headers=headers).status_code == 200
    assert client.get("/api/auth/me").status_code == 401
    headers = login(client)
    with Session(app.state.engine) as session:
        set_admin(session, "admin", PASSWORD)
    assert client.get("/api/auth/me").status_code == 401
    login(client)
    with closing(sqlite3.connect(app.state.settings.db_path)) as connection:
        connection.execute("UPDATE login_session SET expires_at=0")
        connection.commit()
    assert client.get("/api/auth/me").status_code == 401


def test_login_rate_limit_and_public_http_gate(server):
    client, _, _ = server
    for _ in range(5):
        assert (
            client.post(
                "/api/auth/login",
                json={"username": "admin", "password": "wrong"},
                headers={"Origin": ORIGIN},
            ).status_code
            == 401
        )
    assert (
        client.post(
            "/api/auth/login",
            json={"username": "admin", "password": PASSWORD},
            headers={"Origin": ORIGIN},
        ).status_code
        == 429
    )
    assert client.get("/api/auth/me", headers={"Host": "copylee.cn"}).status_code == 403


def test_safe_links_and_markdown_seo(server):
    client, _, _ = server
    headers = login(client)
    site = client.get("/api/admin/site").json()
    site["site"]["notes"] = "javascript:alert(1)"
    assert client.put("/api/admin/site", json=site, headers=headers).status_code == 422
    markdown = "<script>alert(1)</script>\n\n[evil](javascript:alert(1))\n\n![x](data:text/html,x)\n\n**safe**"
    preview = client.post(
        "/api/admin/preview", json={"markdown": markdown}, headers=headers
    ).json()["html"]
    assert (
        "<script>" not in preview
        and 'href="javascript:' not in preview
        and 'src="data:' not in preview
    )
    assert "<strong>safe</strong>" in preview
    post = create_post(client, headers, markdown=markdown, title='Quoted " title </script>')
    assert (
        client.post(
            f"/api/admin/posts/{post['id']}/publish", json={"revision": 1}, headers=headers
        ).status_code
        == 200
    )
    html = client.get("/posts/first-post").text
    assert preview in html
    assert '<link rel="canonical" href="http://localhost:8000/posts/first-post">' in html
    assert "application/ld+json" in html and "og:title" in html
    assert "Quoted &#34; title &lt;/script&gt;" in html
    assert "Disallow: /admin" in client.get("/robots.txt").text


def png():
    buffer = BytesIO()
    Image.new("RGB", (4, 4)).save(buffer, "PNG")
    return buffer.getvalue()


def test_upload_stream_validation_and_media_404(server):
    client, _, settings = server
    headers = login(client)
    response = client.post("/api/admin/media", content=png(), headers=headers)
    assert response.status_code == 201
    url = response.json()["url"]
    assert client.get(url).content == png()
    assert (settings.images_dir / url.split("/images/", 1)[1]).is_file()
    assert (
        client.post("/api/admin/media", content=b"<svg></svg>", headers=headers).status_code == 415
    )
    assert (
        client.post(
            "/api/admin/media", content=b"x" * (20 * 1024 * 1024 + 1), headers=headers
        ).status_code
        == 413
    )
    assert client.get("/media/missing.png").status_code == 404
    assert client.get("/api/missing").status_code == 404
    assert client.get("/assets/missing.js").status_code == 404


def test_backup_restore_with_image_and_session_revocation(server, tmp_path):
    client, app, settings = server
    headers = login(client)
    url = client.post("/api/admin/media", content=png(), headers=headers).json()["url"]
    post = create_post(client, headers, markdown=f"![test]({url})", cover=url)
    client.post(f"/api/admin/posts/{post['id']}/publish", json={"revision": 1}, headers=headers)
    snapshot = backup(settings)
    target = tmp_path / "restored"
    restore(snapshot, target)
    restored_settings = Settings(
        data_dir=target, static_dir=settings.static_dir, sync_enabled=False
    )
    restored_app = create_app(restored_settings)
    with TestClient(restored_app, base_url=ORIGIN) as restored:
        assert restored.get("/api/posts/first-post").json()["cover"] == url
        assert restored.get(url).content == png()
        restored.cookies.update(client.cookies)
        assert restored.get("/api/auth/me").status_code == 401
        assert seed(restored_settings) is False
        migrate(restored_settings)
        assert restored.get("/api/posts/first-post").status_code == 200
    with pytest.raises(ValueError):
        restore(snapshot, target)
    (snapshot / "content.db").write_bytes(b"broken")
    with pytest.raises(ValueError):
        restore(snapshot, tmp_path / "corrupt")


def test_backup_retention_and_missing_references(server):
    _, app, settings = server
    for _ in range(15):
        backup(settings)
    assert len(list((settings.data_dir / "backups").glob("*/manifest.json"))) == 14
    with Session(app.state.engine) as session:
        row = session.get(Content, "site")
        row.value = {**row.value, "intro": "/media/" + "a" * 48 + ".png"}
        session.add(row)
        session.commit()
    with pytest.raises(ValueError, match="图片不存在"):
        backup(settings)


def github_repo(index):
    return {
        "name": f"repo-{index}",
        "fork": False,
        "archived": False,
        "private": False,
        "description": None,
        "html_url": f"https://github.com/example/repo-{index}",
        "homepage": None,
        "language": None,
        "stargazers_count": index,
        "pushed_at": "2026-10-12T00:00:00Z",
    }


def test_github_pagination_and_partial_failure():
    def handler(request):
        page = int(request.url.params["page"])
        return httpx.Response(
            200, json=[github_repo(i) for i in range(100)] if page == 1 else [github_repo(100)]
        )

    items = asyncio.run(fetch_repos("example", "", httpx.MockTransport(handler)))
    assert len(items) == 101

    def failed(request):
        return handler(request) if request.url.params["page"] == "1" else httpx.Response(403)

    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(fetch_repos("example", "", httpx.MockTransport(failed)))


def test_sync_failure_preserves_cache_and_user_change_discards_old(server, monkeypatch):
    client, app, _ = server
    before = client.get("/api/repos").json()

    async def failed(*args):
        raise httpx.ConnectTimeout("simulated")

    monkeypatch.setattr("app.github.fetch_repos", failed)
    assert asyncio.run(sync_repos(app))["ok"] is False
    assert client.get("/api/repos").json() == before

    async def changed(*args):
        with Session(app.state.engine) as session:
            row = session.get(Content, "site")
            row.value = {**row.value, "github": "different-account"}
            row.revision += 1
            session.add(row)
            session.commit()
        return [github_repo(1)]

    monkeypatch.setattr("app.github.fetch_repos", changed)
    assert asyncio.run(sync_repos(app))["ok"] is False
    assert client.get("/api/repos").json() == before


def test_successful_sync_and_restart_persistence(server, monkeypatch):
    client, app, settings = server

    async def success(*args):
        return [github_repo(1)]

    monkeypatch.setattr("app.github.fetch_repos", success)
    assert asyncio.run(sync_repos(app))["ok"] is True
    result = client.get("/api/repos").json()
    assert result["revision"] == 2
    new_app = create_app(settings)
    with TestClient(new_app, base_url=ORIGIN) as restarted:
        assert restarted.get("/api/repos").json() == result


def test_https_admin_and_secure_cookie(server):
    _, app, settings = server
    settings.public_admin = True
    settings.secure_cookie = True
    settings.site_url = "https://copylee.cn"
    settings.allowed_origins = "https://copylee.cn"
    with TestClient(app, base_url="https://copylee.cn") as client:
        response = client.post(
            "/api/auth/login",
            json={"username": "admin", "password": PASSWORD},
            headers={"Origin": "https://copylee.cn"},
        )
        assert response.status_code == 200
        assert "Secure" in response.headers["set-cookie"]
        assert client.get("/api/auth/me").status_code == 200
        assert "https://copylee.cn/posts" in client.get("/sitemap.xml").text
    with TestClient(app, base_url="http://copylee.cn") as client:
        assert client.get("/api/auth/me").status_code == 403


def test_json_size_limit_and_unicode_login(server):
    client, _, _ = server
    response = client.post(
        "/api/auth/login",
        content=b"x" * (2 * 1024 * 1024 + 1),
        headers={"Content-Type": "application/json", "Origin": ORIGIN},
    )
    assert response.status_code == 413
    response = client.post(
        "/api/auth/login",
        json={"username": "管理员", "password": PASSWORD},
        headers={"Origin": ORIGIN},
    )
    assert response.status_code == 401


def publish(client, headers, **changes):
    post = create_post(client, headers, **changes)
    response = client.post(
        f"/api/admin/posts/{post['id']}/publish", json={"revision": 1}, headers=headers
    )
    assert response.status_code == 200, response.text


def test_reading_pages_feed_and_not_found(server):
    client, _, _ = server
    headers = login(client)
    publish(client, headers, slug="older", title="Older post", markdown="## 第一节\n\n中文正文。")
    publish(client, headers, slug="newer", title="Newer post", markdown="Plain words here.")
    older = client.get("/posts/older").text
    assert 'href="/posts/newer"' in older and "约 1 分钟" in older
    assert 'href="/posts/older"' in client.get("/posts/newer").text
    assert "粤ICP备2026159168号-1" in older and "https://beian.miit.gov.cn/" in older
    feed = client.get("/feed.xml")
    assert feed.headers["content-type"].startswith("application/atom+xml")
    assert feed.text.index("Newer post") < feed.text.index("Older post")
    assert "/scut" in client.get("/sitemap.xml").text
    missing = client.get("/no-such-page")
    assert missing.status_code == 404 and "这个页面走丢了" in missing.text
    assert client.get("/api/no-such-route").json() == {"detail": "Not Found"}
    assert "这篇文章暂时不在这里" in client.get("/posts/missing").text


def test_reading_stats_counts_cjk_and_words():
    from app.content import reading_stats

    stats = reading_stats("# 标题\n\n你好世界 hello world\n\n```py\nignored code\n```")
    assert stats == {"words": 8, "minutes": 1}


def test_delete_only_after_unpublish_and_frees_slug(server):
    client, _, _ = server
    headers = login(client)
    identifier = create_post(client, headers)["id"]
    url = f"/api/admin/posts/{identifier}"
    assert client.post(url + "/publish", json={"revision": 1}, headers=headers).status_code == 200
    # 公开中的文章不能直接删除
    assert client.post(url + "/delete", json={"revision": 2}, headers=headers).status_code == 409
    assert client.post(url + "/unpublish", json={"revision": 2}, headers=headers).status_code == 200
    # 旧版本号不能删除
    assert client.post(url + "/delete", json={"revision": 2}, headers=headers).status_code == 409
    assert client.post(url + "/delete", json={"revision": 3}, headers=headers).status_code == 200
    assert client.get(url, headers=headers).status_code == 404
    assert all(p["id"] != identifier for p in client.get("/api/admin/posts", headers=headers).json())
    # 固定链接已释放，可再次使用
    assert create_post(client, headers)["slug"] == "first-post"

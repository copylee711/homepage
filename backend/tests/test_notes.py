import asyncio
import io
import tarfile

import httpx
from test_content import login, server  # noqa: F401

from app.notes import (
    html_images,
    read_archive,
    rewrite_links,
    slugify,
    summary_of,
    sync_notes,
    title_of,
)

COMMIT_A = "a" * 40
COMMIT_B = "b" * 40
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64


def archive(files: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for name, data in files.items():
            info = tarfile.TarInfo(f"copylee711-notes-abc/{name}")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def github(state: dict):
    def handler(request: httpx.Request):
        state["requests"].append(request.url.host)
        if request.url.host == "api.github.com":
            return httpx.Response(200, text=state["commit"])
        return httpx.Response(200, content=archive(state["files"]))

    return httpx.MockTransport(handler)


REPO_FILES = {
    "Python.md": "# Python 笔记\n\n第一段介绍 Python 的基础用法。\n\n## 列表\n\n![图](figure/a.png)"
    "\n\n见 [NumPy](PythonPackages/numpy.md#数组)。\n\n$$\nE=mc^2\n$$\n".encode(),
    "PythonPackages/numpy.md": "# NumPy\n\n数组运算与广播机制的整理笔记。\n".encode(),
    "Draft.md": "# 草稿\n\n还没写完的内容在这里。\n".encode(),
    "README.md": b"# readme",
    "docs/index.md": b"# built site",
    ".webservice/x.md": b"# hidden",
    "figure/a.png": PNG,
    "figure/unused.png": PNG + b"1",
}


def test_parsing_helpers():
    assert slugify("PythonPackages/numpy.md") == "pythonpackages-numpy"
    assert slugify("numpy&pandas.md") == "numpy-pandas"
    assert slugify("交叉熵损失理解.md") == "交叉熵损失理解"
    assert title_of("intro\n# 标题 #\n", "x") == "标题"
    assert summary_of("# T\n\n```py\ncode\n```\n\n这是一段足够长的正文摘要。") == "这是一段足够长的正文摘要。"
    rewritten = rewrite_links(
        "![a](./img/x.png) [b](other.md#s) [c](https://e.com/a.md) ![d](/abs.png)",
        "dir/note.md", {"dir/img/x.png": "/media/notes/x.png"}, {"dir/other.md": "other"},
    )
    assert rewritten == "![a](/media/notes/x.png) [b](/notes/other#s) [c](https://e.com/a.md) ![d](/abs.png)"
    assert html_images('<img src="./fig/a b.png" alt="x"></img>') == "![x](./fig/a%20b.png)"
    notes, images = read_archive(archive(REPO_FILES), [".*", "docs", "README.md"])
    assert set(notes) == {"Python.md", "PythonPackages/numpy.md", "Draft.md"}
    assert set(images) == {"figure/a.png", "figure/unused.png"}


def test_sync_notes_from_github(server):  # noqa: F811
    client, app, settings = server
    state = {"commit": COMMIT_A, "files": dict(REPO_FILES), "requests": []}
    result = asyncio.run(sync_notes(app, transport=github(state)))
    assert result == {"ok": True, "error": "", "changed": 3}
    items = {n["slug"]: n for n in client.get("/api/notes").json()["items"]}
    # Draft 开头的文件默认隐藏；排除目录与 README 不导入。
    assert set(items) == {"python", "pythonpackages-numpy"}
    assert items["pythonpackages-numpy"]["category"] == "PythonPackages"
    page = client.get("/notes/python").text
    assert "/media/notes/" in page and 'href="/notes/pythonpackages-numpy#%E6%95%B0%E7%BB%84"' in page
    assert 'class="math block"' in page
    assert page.count("<h1") == 1  # 正文开头重复的一级标题已去掉
    stored = list((settings.media_dir / "notes").iterdir())
    assert len(stored) == 1  # 未被引用的图片不保存
    assert client.get("/notes").status_code == 200 and "NumPy" in client.get("/notes").text
    assert "/notes/python" in client.get("/sitemap.xml").text

    # 提交未变化时只请求一次 API，不下载归档。
    state["requests"].clear()
    assert asyncio.run(sync_notes(app, transport=github(state)))["changed"] == 0
    assert state["requests"] == ["api.github.com"]

    # 仓库更新：修改、删除，并保留已有地址。
    state["commit"] = COMMIT_B
    state["files"]["Python.md"] = "# Python 笔记\n\n更新后的介绍内容在这里。\n".encode()
    del state["files"]["PythonPackages/numpy.md"]
    assert asyncio.run(sync_notes(app, transport=github(state)))["changed"] == 2
    assert "更新后的介绍" in client.get("/notes/python").text
    assert client.get("/notes/pythonpackages-numpy").status_code == 404


def test_sync_failure_is_recorded(server):  # noqa: F811
    client, app, _ = server
    transport = httpx.MockTransport(lambda request: httpx.Response(403))
    result = asyncio.run(sync_notes(app, transport=transport))
    assert result["ok"] is False and "HTTP 403" in result["error"]
    headers = login(client)
    assert "HTTP 403" in client.get("/api/admin/notes", headers=headers).json()["config"]["last_error"]


def test_manual_notes_and_visibility(server):  # noqa: F811
    client, app, _ = server
    headers = login(client)
    note = {"title": "手写笔记", "slug": "hand-written", "category": "Ideas",
            "markdown": "# 手写笔记\n\n直接在后台记录的一条内容。", "visible": True}
    created = client.post("/api/admin/notes", json=note, headers=headers)
    assert created.status_code == 201, created.text
    data = created.json()
    assert data["summary"] == "直接在后台记录的一条内容。"
    assert client.get("/notes/hand-written").status_code == 200
    assert client.post("/api/admin/notes", json=note, headers=headers).status_code == 409
    hidden = client.post(f"/api/admin/notes/{data['id']}/visibility",
                         json={"revision": data["revision"], "visible": False}, headers=headers)
    assert hidden.status_code == 200
    assert client.get("/notes/hand-written").status_code == 404
    assert client.get("/api/notes").json()["items"] == []
    stale = client.put(f"/api/admin/notes/{data['id']}", json={**note, "revision": 1}, headers=headers)
    assert stale.status_code == 409
    removed = client.post(f"/api/admin/notes/{data['id']}/remove", json={"revision": 2},
                          headers=headers)
    assert removed.status_code == 200
    assert client.get("/api/admin/notes", headers=headers).json()["items"] == []
    assert client.post("/api/admin/notes", json=note).status_code in {401, 403}


def test_notes_config_and_socials(server):  # noqa: F811
    client, _, _ = server
    headers = login(client)
    config = client.put("/api/admin/notes/config", headers=headers, json={
        "repo": "copylee711/notes", "branch": "master", "autoPublish": False, "exclude": ["docs"],
    })
    assert config.status_code == 200 and config.json()["last_commit"] == ""
    assert client.put("/api/admin/notes/config", headers=headers,
                      json={"repo": "bad repo", "branch": "x"}).status_code == 422
    value = client.get("/api/admin/site", headers=headers).json()
    assert "notes" not in value["site"]
    value["site"]["socials"] = [
        {"platform": "email", "url": "me@example.com", "visible": True},
        {"platform": "instagram", "url": "", "visible": True},
    ]
    assert client.put("/api/admin/site", json=value, headers=headers).status_code == 200
    public = client.get("/api/site").json()["site"]["socials"]
    assert public == [{"platform": "email", "url": "mailto:me@example.com", "visible": True}]
    assert 'href="mailto:me@example.com"' in client.get("/posts").text
    value["site"]["socials"] = [{"platform": "x", "url": "javascript:alert(1)", "visible": True}]
    value["revision"] = 2
    assert client.put("/api/admin/site", json=value, headers=headers).status_code == 422
    value["site"]["socials"] = []
    value["site"]["portals"][0]["href"] = "//evil.example"
    assert client.put("/api/admin/site", json=value, headers=headers).status_code == 422


def test_migration_converts_existing_site(tmp_path):
    import json

    from alembic import command
    from alembic.config import Config
    from sqlalchemy import text

    from app.cli import ROOT
    from app.database import make_engine
    from app.settings import Settings

    settings = Settings(data_dir=tmp_path, static_dir=tmp_path, sync_enabled=False)
    engine = make_engine(settings)
    config = Config(str(ROOT / "alembic.ini"))
    config.attributes["engine"] = engine
    command.upgrade(config, "0003")
    old = json.loads((ROOT / "seed/site.json").read_text("utf-8"))
    old.pop("socials")
    old["notes"] = "https://example.notion.site/notes"
    old["portals"][1].update(href="https://example.notion.site/notes", hint="Notion")
    with engine.begin() as connection:
        for key, value in (("site", old), ("repos", {"items": []}), ("posts", {})):
            connection.execute(text("INSERT INTO content (key, value, revision) VALUES (:k, :v, 1)"),
                               {"k": key, "v": json.dumps(value)})
    command.upgrade(config, "head")
    with engine.connect() as connection:
        rows = dict(connection.execute(text("SELECT key, value FROM content")).all())
    site = json.loads(rows["site"])
    assert "notes" not in site and site["portals"][1]["href"] == "/notes"
    assert [s["platform"] for s in site["socials"]] == ["github", "linkedin", "instagram"]
    assert json.loads(rows["notes"])["repo"] == "copylee711/notes"
    engine.dispose()

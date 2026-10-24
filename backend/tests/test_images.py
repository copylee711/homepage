import json
import os
import zipfile
from io import BytesIO

from fastapi.testclient import TestClient
from PIL import Image
from sqlmodel import Session
from test_accounts import PASSWORD, signup, site  # noqa: F401
from test_content import ADMIN_EMAIL, ORIGIN, create_post, login

from app.cli import backup, restore
from app.images import migrate_media
from app.main import create_app
from app.settings import Settings


def picture(size=4, noise=False, color=(0, 0, 0)) -> bytes:
    image = Image.new("RGB", (size, size), color)
    if noise:
        image = Image.frombytes("RGB", (size, size), os.urandom(size * size * 3))
    buffer = BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


def user_id(client, headers):
    return client.get("/api/account/me", headers=headers).json()["user"]["id"]


def enable(client, uid, enabled=True, quota_mb=200, max_file_mb=5):
    admin = login(client)
    response = client.put(f"/api/admin/accounts/users/{uid}/images", headers=admin,
                          json={"enabled": enabled, "quota_mb": quota_mb,
                                "max_file_mb": max_file_mb})
    assert response.status_code == 200, response.text
    return admin


def token_for(client, headers, name="Typora"):
    response = client.post("/api/account/images/tokens", json={"name": name}, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


def upload(client, token, payload, name="a.png"):
    return client.post("/api/upload", headers=bearer(token),
                       files={"file": (name, payload, "image/png")})


def test_disabled_by_default_until_admin_enables(site):  # noqa: F811
    client, _, _, sent = site
    headers = signup(client, sent)
    assert client.get("/api/account/images").json()["limits"]["enabled"] is False
    assert client.post("/api/account/images", content=picture(), headers=headers).status_code == 403
    assert client.post("/api/account/images/tokens", json={"name": "x"},
                       headers=headers).status_code == 403
    assert client.get("/api/account/images/export").status_code == 403
    enable(client, user_id(client, headers))
    state = client.get("/api/account/images").json()
    assert state["limits"]["enabled"] is True and state["items"] == [] and state["tokens"] == []
    assert client.get("/api/admin/accounts").json()["users"][0]["images"]["enabled"] is True


def test_token_upload_and_revocation(site):  # noqa: F811
    client, _, settings, sent = site
    headers = signup(client, sent)
    uid = user_id(client, headers)
    enable(client, uid)
    token = token_for(client, headers)
    assert token["token"].startswith("cpl_")
    assert "token" not in client.get("/api/account/images").json()["tokens"][0]
    response = upload(client, token["token"], picture())
    assert response.status_code == 200, response.text
    url = response.json()["url"]
    assert url.startswith(f"{settings.site_url}/images/") and url.endswith(".png")
    assert client.get(url).content == picture()
    raw = client.post("/api/upload", headers=bearer(token["token"]),
                      content=picture(color=(9, 9, 9)))
    assert raw.status_code == 200 and raw.json()["url"] != url
    assert client.get("/api/account/images").json()["tokens"][0]["last_used"]
    assert upload(client, "cpl_wrong", picture()).status_code == 401
    assert client.post("/api/upload", files={"file": ("a.png", picture())}).status_code == 401
    assert client.post(f"/api/account/images/tokens/{token['id']}/remove",
                       headers=headers).status_code == 200
    assert upload(client, token["token"], picture()).status_code == 401
    # 停用账户或关闭图床后，旧令牌立即失效。
    again = token_for(client, headers)
    enable(client, uid, enabled=False)
    assert upload(client, again["token"], picture()).status_code == 401
    admin = enable(client, uid)
    third = token_for(client, headers)
    assert client.post(f"/api/admin/accounts/users/{uid}/state", json={"disabled": True},
                       headers=admin).status_code == 200
    assert upload(client, third["token"], picture()).status_code == 401


def test_validation_quota_and_dedup(site):  # noqa: F811
    client, _, _, sent = site
    headers = signup(client, sent)
    enable(client, user_id(client, headers), quota_mb=1, max_file_mb=1)
    token = token_for(client, headers)["token"]
    assert upload(client, token, b"<svg></svg>").status_code == 415
    assert upload(client, token, picture(700, noise=True)).status_code == 413
    first = upload(client, token, picture(450, noise=True))
    assert first.status_code == 200, first.text
    duplicate = client.post("/api/account/images", headers=headers, content=b"")
    assert duplicate.status_code == 415
    payload = picture(color=(1, 2, 3))
    one = client.post("/api/account/images", headers=headers, content=payload).json()
    two = client.post("/api/account/images", headers=headers, content=payload).json()
    assert one["created"] is True and two["created"] is False and one["url"] == two["url"]
    full = upload(client, token, picture(450, noise=True))
    assert full.status_code == 413 and "空间不足" in full.json()["detail"]
    client.post(f"/api/account/images/{first.json()['id']}/remove", headers=headers)
    assert upload(client, token, picture(450, noise=True)).status_code == 200


def test_owners_are_isolated_and_cleaned_up(site):  # noqa: F811
    client, _, settings, sent = site
    first = signup(client, sent)
    enable(client, user_id(client, first))
    mine = client.post("/api/account/images", headers=first, content=picture()).json()
    client.post("/api/account/logout", headers=first)
    second = signup(client, sent, "other@163.com")
    assert client.post(f"/api/account/images/{mine['id']}/remove",
                       headers=second).status_code == 404
    assert client.get("/api/account/images").json()["limits"]["enabled"] is False
    client.post("/api/account/logout", headers=second)
    first = {**first, "X-CSRF-Token": client.post(
        "/api/account/login", headers={"Origin": ORIGIN},
        json={"email": "reader@qq.com", "password": PASSWORD}).json()["csrf"]}
    stored = settings.images_dir / mine["url"].split("/images/", 1)[1]
    assert stored.is_file()
    assert client.post("/api/account/delete", json={"password": PASSWORD},
                       headers=first).status_code == 200
    assert not stored.exists()
    admin = login(client)
    assert client.get("/api/admin/images", headers=admin).json()["total"] == 0


def test_export_zip_matches_urls(site):  # noqa: F811
    client, _, settings, sent = site
    headers = signup(client, sent)
    enable(client, user_id(client, headers))
    urls = [client.post("/api/account/images", headers=headers,
                        content=picture(color=(i, 0, 0))).json()["url"] for i in range(3)]
    response = client.get("/api/account/images/export")
    assert response.status_code == 200 and response.headers["content-type"] == "application/zip"
    with zipfile.ZipFile(BytesIO(response.content)) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        assert sorted(i["url"] for i in manifest["images"]) == sorted(urls)
        for item in manifest["images"]:
            assert archive.read(item["path"]) == (settings.images_dir / item["path"]).read_bytes()
    assert client.get("/api/account/images/export").status_code == 429


def test_admin_uploads_and_tokens_unlimited(site):  # noqa: F811
    client, _, settings, _ = site
    admin = login(client)
    url = client.post("/api/admin/media", content=picture(), headers=admin).json()["url"]
    assert url.startswith(settings.image_base) and client.get(url).content == picture()
    token = client.post("/api/admin/images/tokens", json={"name": "PicList"}, headers=admin).json()
    assert upload(client, token["token"], picture(900, noise=True)).status_code == 200
    data = client.get("/api/admin/images", headers=admin).json()
    # 编辑器上传进系统图床，PicList 上传记在管理员自己的账户下。
    assert data["total"] == 2
    assert {row["owner"]: row["label"] for row in data["usage"]} == {
        "system": "系统（文章与笔记）", "admin-user": ADMIN_EMAIL}
    own = next(item for item in data["items"] if item["owner"] == "admin-user")
    assert client.post(f"/api/admin/images/{own['id']}/remove", headers=admin).status_code == 200
    assert client.get("/api/admin/images?owner=admin-user", headers=admin).json()["total"] == 0
    assert client.get("/api/admin/images?owner=system", headers=admin).json()["total"] == 1


def test_migrate_media_and_backup(site, tmp_path):  # noqa: F811
    client, app, settings, _ = site
    admin = login(client)
    name = "a" * 48 + ".png"
    (settings.media_dir / name).write_bytes(picture(color=(5, 5, 5)))
    post = create_post(client, admin, markdown=f"![x](/media/{name})", cover=f"/media/{name}")
    client.post(f"/api/admin/posts/{post['id']}/publish", json={"revision": 1}, headers=admin)
    note = {"title": "带图笔记", "slug": "img-note",
            "markdown": f"![z]({settings.site_url}/media/{name}) ![y](/media/{'b' * 48}.png)"}
    assert client.post("/api/admin/notes", json=note, headers=admin).status_code == 201
    with Session(app.state.engine) as session:
        dry = migrate_media(session, settings)
        assert (dry["images"], dry["articles"], dry["notes"], dry["imported"]) == (1, 1, 1, 0)
        assert dry["missing"] == ["b" * 48 + ".png"]
        assert list(settings.images_dir.rglob("*.png")) == []
        result = migrate_media(session, settings, apply=True)
        assert (result["imported"], result["articles"], result["notes"]) == (1, 1, 1)
        again = migrate_media(session, settings, apply=True)
        assert (again["images"], again["articles"], again["notes"]) == (0, 0, 0)
    article = client.get("/api/posts/first-post").json()
    assert article["cover"].startswith(settings.image_base)
    assert "/media/" not in article["markdown"]
    note_page = client.get("/notes/img-note").text
    assert settings.image_base in note_page and "b" * 48 in note_page
    assert client.get(article["cover"]).content == picture(color=(5, 5, 5))
    # 备份包含图床文件，恢复后地址照常可用。
    target = tmp_path / "restored"
    restore(backup(settings), target)
    restored = Settings(data_dir=target, static_dir=settings.static_dir, sync_enabled=False,
                        scut_sync_enabled=False)
    with TestClient(create_app(restored), base_url=ORIGIN) as other:
        assert other.get(article["cover"]).content == picture(color=(5, 5, 5))


def test_editor_images_follow_articles(server):
    from sqlmodel import Session

    from app.images import prune_system
    from app.models import HostedImage

    client, app, settings = server
    admin = login(client)
    uploaded = client.post("/api/admin/media", content=picture(noise=True), headers=admin)
    assert uploaded.status_code == 201, uploaded.text
    url = uploaded.json()["url"]
    image_id = url.rsplit("/", 1)[1].split(".")[0]
    listing = client.get("/api/admin/images", headers=admin).json()
    assert listing["items"][0]["owner"] == "system"
    assert client.post(f"/api/admin/images/{image_id}/remove", headers=admin).status_code == 409
    post = create_post(client, admin, markdown=f"![图]({url})")
    with Session(app.state.engine) as session:
        # 被文章引用时即使过了宽限期也保留
        assert prune_system(session, settings, grace=0) == 0
    draft = {**post["draft"], "markdown": "不再引用图片"}
    assert client.put(f"/api/admin/posts/{post['id']}", headers=admin,
                      json={"revision": post["revision"], "draft": draft}).status_code == 200
    with Session(app.state.engine) as session:
        # 刚上传不足 24 小时：保存时不会删除
        assert session.get(HostedImage, image_id) is not None
        assert prune_system(session, settings, grace=0) == 1
        assert session.get(HostedImage, image_id) is None

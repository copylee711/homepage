import io
import os
import time
import zipfile

import pytest
from test_accounts import PASSWORD, signup, site  # noqa: F401
from test_content import ORIGIN, login
from test_images import agree, picture, user_id

from app.drive import objects
from app.drive.objects import ObjectInfo


class MemoryStore:
    """内存里的对象存储，行为与 OssStore 的接口一致。"""

    def __init__(self):
        self.data: dict[str, tuple[bytes, float]] = {}

    def list(self, prefix, delimiter="/", limit=None):
        objects_, prefixes = [], set()
        for key in sorted(self.data):
            if not key.startswith(prefix):
                continue
            rest = key[len(prefix):]
            if delimiter and delimiter in rest:
                prefixes.add(prefix + rest[:rest.index(delimiter) + 1])
                continue
            body, mtime = self.data[key]
            objects_.append(ObjectInfo(key, len(body), mtime, str(hash(body))))
        result = objects_, sorted(prefixes)
        if limit:
            return result[0][:limit], result[1][:limit]
        return result

    def head(self, key):
        if key.endswith("/") or key not in self.data:
            return None
        body, mtime = self.data[key]
        return ObjectInfo(key, len(body), mtime, str(hash(body)))

    def get(self, key, offset=0):
        return io.BytesIO(self.data[key][0][offset:])

    def put_file(self, key, path):
        self.data[key] = (path.read_bytes(), time.time())

    def put_bytes(self, key, data):
        self.data[key] = (data, time.time())

    def delete(self, keys):
        for key in keys:
            self.data.pop(key, None)

    def copy(self, source, target, size, spool):
        self.data[target] = self.data[source]


@pytest.fixture
def store():
    memory = MemoryStore()
    objects.use_store(memory)
    yield memory
    objects.use_store(None)


def enable(client, uid, drive=True, images=False, quota_mb=10, max_image_mb=5):
    admin = login(client)
    response = client.put(f"/api/admin/storage/users/{uid}", headers=admin, json={
        "drive_enabled": drive, "images_enabled": images, "quota_mb": quota_mb,
        "max_image_mb": max_image_mb,
    })
    assert response.status_code == 200, response.text
    agree(client, uid)
    return admin


@pytest.fixture
def drive(site):  # noqa: F811
    client, app, settings, sent = site
    headers = signup(client, sent)
    uid = user_id(client, headers)
    enable(client, uid)
    return client, headers, uid, settings


def put_file(client, headers, path, payload: bytes, part=4):
    created = client.post("/api/drive/uploads", headers=headers,
                          json={"path": path, "size": len(payload)})
    if created.status_code != 200:
        return created
    upload = created.json()["id"]
    for offset in range(0, len(payload), part):
        response = client.put(f"/api/drive/uploads/{upload}?offset={offset}", headers=headers,
                              content=payload[offset:offset + part])
        assert response.status_code == 200, response.text
    return client.post(f"/api/drive/uploads/{upload}/finish", headers=headers)


def names(client, path="/"):
    response = client.get("/api/drive/list", params={"path": path})
    assert response.status_code == 200, response.text
    return [item["name"] for item in response.json()["items"]]


def test_drive_disabled_until_admin_enables(site):  # noqa: F811
    client, _, _, sent = site
    headers = signup(client, sent)
    assert client.get("/api/drive").json()["enabled"] is False
    assert client.get("/api/drive/list").status_code == 403
    assert client.post("/api/drive/mkdir", json={"path": "/a"}, headers=headers).status_code == 403
    enable(client, user_id(client, headers))
    overview = client.get("/api/drive").json()
    assert overview["enabled"] is True and overview["mounts"][0]["path"] == "/"


def test_file_operations_and_usage(drive):
    client, headers, uid, settings = drive
    assert client.post("/api/drive/mkdir", json={"path": "/docs"}, headers=headers).status_code == 200
    assert client.post("/api/drive/mkdir", json={"path": "/docs"},
                       headers=headers).status_code == 409
    payload = b"hello drive, this is a resumable upload"
    response = put_file(client, headers, "/docs/a.txt", payload)
    assert response.status_code == 200, response.text
    assert names(client) == ["docs"] and names(client, "/docs") == ["a.txt"]
    assert client.get("/api/drive").json()["storage"]["drive_used"] == len(payload)

    whole = client.get("/api/drive/download", params={"path": "/docs/a.txt"})
    assert whole.content == payload and "attachment" in whole.headers["content-disposition"]
    part = client.get("/api/drive/download", params={"path": "/docs/a.txt"},
                      headers={"Range": "bytes=6-10"})
    assert part.status_code == 206 and part.content == payload[6:11]
    assert part.headers["content-range"] == f"bytes 6-10/{len(payload)}"

    assert client.post("/api/drive/rename", json={"path": "/docs/a.txt", "name": "b.txt"},
                       headers=headers).status_code == 200
    assert client.post("/api/drive/copy", json={"paths": ["/docs/b.txt"], "target": "/"},
                       headers=headers).status_code == 200
    assert client.get("/api/drive").json()["storage"]["drive_used"] == 2 * len(payload)
    assert client.post("/api/drive/copy", json={"paths": ["/docs/b.txt"], "target": "/"},
                       headers=headers).status_code == 409
    assert client.post("/api/drive/move", json={"paths": ["/b.txt"], "target": "/docs",
                                                "overwrite": True},
                       headers=headers).status_code == 200
    assert names(client) == ["docs"]
    assert client.post("/api/drive/move", json={"paths": ["/docs"], "target": "/docs"},
                       headers=headers).status_code == 400

    archive = client.get("/api/drive/zip", params={"path": ["/docs"]})
    with zipfile.ZipFile(io.BytesIO(archive.content)) as opened:
        assert opened.read("docs/b.txt") == payload

    assert client.post("/api/drive/delete", json={"paths": ["/docs"]},
                       headers=headers).status_code == 200
    assert names(client) == []
    assert client.get("/api/drive").json()["storage"]["drive_used"] == 0
    assert not any((settings.drive_dir / uid).iterdir())


def test_paths_cannot_escape(drive):
    client, headers, uid, settings = drive
    for bad in ("/../x", "/a/../../x", "/a\x00b"):
        assert client.get("/api/drive/list", params={"path": bad}).status_code == 400
    outside = settings.data_dir / "secret.txt"
    outside.write_text("top secret")
    try:
        os.symlink(outside, settings.drive_dir / uid / "link")
    except (OSError, NotImplementedError):
        pytest.skip("当前系统不允许创建符号链接")
    assert "link" not in names(client)
    assert client.get("/api/drive/download", params={"path": "/link"}).status_code in {403, 404}


def test_quota_shared_with_images(drive):
    client, headers, uid, _ = drive
    enable(client, uid, images=True, quota_mb=1)
    big = os.urandom(900 * 1024)
    assert put_file(client, headers, "/big.bin", big, part=len(big)).status_code == 200
    image = picture(400, noise=True)
    assert len(image) > 124 * 1024
    response = client.post("/api/account/images", content=image, headers=headers)
    assert response.status_code == 413 and "存储空间不足" in response.json()["detail"]
    too_big = client.post("/api/drive/uploads", headers=headers,
                          json={"path": "/more.bin", "size": 200 * 1024})
    assert too_big.status_code == 413
    client.post("/api/drive/delete", json={"paths": ["/big.bin"]}, headers=headers)
    assert client.post("/api/account/images", content=image, headers=headers).status_code == 200

    assert "图床" in names(client)
    year = names(client, "/图床")[0]
    month = names(client, f"/图床/{year}")[0]
    files = names(client, f"/图床/{year}/{month}")
    assert len(files) == 1
    path = f"/图床/{year}/{month}/{files[0]}"
    assert client.get("/api/drive/download", params={"path": path}).content == image
    assert client.post("/api/drive/delete", json={"paths": [path]},
                       headers=headers).status_code == 403
    assert client.post("/api/drive/mkdir", json={"path": "/图床/x"},
                       headers=headers).status_code == 403
    usage = client.get("/api/drive").json()["storage"]
    assert usage["images_used"] == len(image) and usage["used"] == len(image)


def test_shares(drive):
    client, headers, uid, _ = drive
    client.post("/api/drive/mkdir", json={"path": "/pub"}, headers=headers)
    put_file(client, headers, "/pub/one.txt", b"first file")
    client.post("/api/drive/mkdir", json={"path": "/inbox"}, headers=headers)
    created = client.post("/api/drive/shares", headers=headers, json={
        "paths": ["/pub"], "password": "letmein", "max_uses": 2,
    })
    assert created.status_code == 200, created.text
    share = created.json()
    assert share["url"].endswith(f"/s/{share['id']}") and share["has_password"]

    info = client.get(f"/api/s/{share['id']}").json()
    assert info["needs_password"] and not info["unlocked"]
    assert client.get(f"/api/s/{share['id']}/list").status_code == 401
    assert client.post(f"/api/s/{share['id']}/unlock", json={"password": "nope"},
                       headers={"Origin": ORIGIN}).status_code == 403
    assert client.post(f"/api/s/{share['id']}/unlock", json={"password": "letmein"},
                       headers={"Origin": ORIGIN}).status_code == 200
    listing = client.get(f"/api/s/{share['id']}/list").json()
    assert [item["name"] for item in listing["items"]] == ["one.txt"]
    for _ in range(2):
        got = client.get(f"/api/s/{share['id']}/download", params={"path": "/one.txt"})
        assert got.content == b"first file"
    assert client.get(f"/api/s/{share['id']}").status_code == 404  # 次数用完

    inbox = client.post("/api/drive/shares", headers=headers,
                        json={"paths": ["/inbox"], "mode": "upload"}).json()
    sent = client.put(f"/api/s/{inbox['id']}/upload", params={"name": "hi.txt"},
                      content=b"from a visitor", headers={"Origin": ORIGIN})
    assert sent.status_code == 200, sent.text
    assert names(client, "/inbox") == ["hi.txt"]
    assert client.get(f"/api/s/{inbox['id']}/list").status_code == 403
    again = client.put(f"/api/s/{inbox['id']}/upload", params={"name": "hi.txt"},
                       content=b"x", headers={"Origin": ORIGIN})
    assert again.status_code == 409
    assert client.post("/api/drive/shares", headers=headers,
                       json={"paths": ["/pub/one.txt"], "mode": "upload"}).status_code == 400

    items = client.get("/api/drive/shares").json()["items"]
    assert len(items) == 2
    assert client.post(f"/api/drive/shares/{inbox['id']}/remove",
                       headers=headers).status_code == 200
    assert client.get(f"/api/s/{inbox['id']}").status_code == 404


def test_credentials_and_login_name(drive):
    import asyncssh

    client, headers, uid, _ = drive
    assert client.put("/api/drive/login", json={"login": "reader"},
                      headers=headers).json()["login"] == "reader"
    assert client.put("/api/drive/login", json={"login": "../x"},
                      headers=headers).status_code == 400
    key = asyncssh.generate_private_key("ssh-ed25519", comment="laptop")
    public = key.export_public_key().decode()
    added = client.post("/api/drive/keys", json={"key": public}, headers=headers)
    assert added.status_code == 200 and added.json()["name"] == "laptop"
    assert client.post("/api/drive/keys", json={"key": public},
                       headers=headers).status_code == 409
    assert client.post("/api/drive/keys", json={"key": "ssh-rsa not-a-key-at-all"},
                       headers=headers).status_code == 400
    password = client.post("/api/drive/app-passwords", json={"name": "Zotero"},
                           headers=headers).json()
    assert len(password["password"]) == 24
    account = client.get("/api/drive").json()["account"]
    assert {item["kind"] for item in account["credentials"]} == {"ssh_key", "app_password"}
    assert password["password"] not in str(account)
    assert client.post(f"/api/drive/credentials/{password['id']}/remove",
                       headers=headers).status_code == 200


def test_oss_mount_and_cross_mount_move(drive, store):
    client, headers, uid, _ = drive
    admin = login(client)
    response = client.post(f"/api/admin/storage/users/{uid}/mounts", headers=admin,
                           json={"path": "/archive", "location": "users/reader", "quota_mb": 1})
    assert response.status_code == 200, response.text
    assert names(client) == ["archive"]
    assert put_file(client, headers, "/archive/x.txt", b"in the cloud").status_code == 200
    assert "users/reader/x.txt" in store.data
    assert client.post("/api/drive/mkdir", json={"path": "/archive/sub"},
                       headers=headers).status_code == 200
    put_file(client, headers, "/local.txt", b"local data")
    assert client.post("/api/drive/move", json={"paths": ["/local.txt"], "target": "/archive/sub"},
                       headers=headers).status_code == 200
    assert names(client, "/archive/sub") == ["local.txt"]
    assert store.data["users/reader/sub/local.txt"][0] == b"local data"
    overview = client.get("/api/drive").json()
    archive = next(m for m in overview["mounts"] if m["path"] == "/archive")
    assert archive["used"] == len(b"in the cloud") + len(b"local data")
    assert overview["storage"]["drive_used"] == 0  # 独立配额的挂载点不计入总配额
    huge = client.post("/api/drive/uploads", headers=headers,
                       json={"path": "/archive/huge.bin", "size": 2 * 1024 * 1024})
    assert huge.status_code == 413
    assert client.post("/api/drive/delete", json={"paths": ["/archive"]},
                       headers=headers).status_code == 403


def test_account_delete_removes_drive(drive):
    client, headers, uid, settings = drive
    put_file(client, headers, "/a.txt", b"bye")
    assert (settings.drive_dir / uid / "a.txt").exists()
    response = client.post("/api/account/delete", json={"password": PASSWORD}, headers=headers)
    assert response.status_code == 200, response.text
    assert not (settings.drive_dir / uid).exists()


def test_terms_gate_drive_and_images(site):  # noqa: F811
    client, _, _, sent = site
    headers = signup(client, sent)
    uid = user_id(client, headers)
    # 未开通时协议不可见
    assert client.get("/api/storage/terms").status_code == 404
    admin = login(client)
    response = client.put(f"/api/admin/storage/users/{uid}", headers=admin, json={
        "drive_enabled": True, "images_enabled": True, "quota_mb": 10, "max_image_mb": 5})
    assert response.status_code == 200
    assert response.json()["storage"]["agreed"] is False
    assert client.get("/api/account/me").json()["features"]["terms"] is False
    # 同意前云盘与图床都不可用
    assert "mounts" not in client.get("/api/drive").json()
    assert client.get("/api/drive/list").status_code == 403
    assert client.post("/api/account/images", content=picture(), headers=headers).status_code == 403
    assert client.put("/api/drive/login", headers=headers, json={"login": "reader"}).status_code == 403
    terms = client.get("/api/storage/terms").json()
    assert terms["agreed"] is False and terms["sections"]
    assert client.post("/api/storage/terms", headers=headers,
                       json={"version": "old"}).status_code == 409
    response = client.post("/api/storage/terms", headers=headers, json={"version": terms["version"]})
    assert response.status_code == 200
    assert client.get("/api/account/me").json()["features"]["terms"] is True
    assert client.get("/api/drive/list").status_code == 200
    assert client.post("/api/account/images", content=picture(), headers=headers).status_code == 200
    row = client.get("/api/admin/storage", headers=admin).json()["users"]
    assert next(u for u in row if u["id"] == uid)["storage"]["terms_accepted_at"]

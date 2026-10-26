import time

import pytest
from fastapi.testclient import TestClient
from pycrdt import (
    Doc,
    Text,
    YMessageType,
    YSyncMessageType,
    create_sync_message,
    create_update_message,
    handle_sync_message,
)
from starlette.websockets import WebSocketDisconnect
from test_accounts import signup, site  # noqa: F401
from test_content import ORIGIN
from test_drive import enable
from test_images import user_id

from app import docs

OWNER = "owner@qq.com"
OTHER = "other@qq.com"


def user_client(app, base):
    """每个用户一个 Cookie 罐，但共用 base 的事件循环：协作房间与真实服务一样在同一个循环里运行。
    不共用时每个 WebSocket 各开一个循环，断线后循环立即关闭，房间的写回来不及完成。"""
    client = TestClient(app, base_url=ORIGIN)
    client.portal = base.portal
    return client


def as_user(app, base, sent, email):
    client = user_client(app, base)
    headers = signup(client, sent, email)
    return client, headers


@pytest.fixture
def people(site):  # noqa: F811
    client, app, settings, sent = site
    owner, owner_headers = as_user(app, client, sent, OWNER)
    enable(client, user_id(owner, owner_headers))
    other, other_headers = as_user(app, client, sent, OTHER)
    stranger = user_client(app, client)
    return app, (owner, owner_headers), (other, other_headers), stranger


def create(owner, headers, title="周会记录"):
    response = owner.post("/api/docs", headers=headers, json={"title": title})
    assert response.status_code == 200, response.text
    return response.json()


def test_creation_requires_drive_access(people):
    _, (owner, owner_headers), (other, other_headers), stranger = people
    doc = create(owner, owner_headers)
    assert doc["role"] == "owner" and doc["link"]["role"] == "none"
    assert other.post("/api/docs", headers=other_headers, json={}).status_code == 403
    assert stranger.post("/api/docs", headers={"Origin": ORIGIN}, json={}).status_code == 401
    listing = owner.get("/api/docs").json()
    assert listing["can_create"] is True and [d["id"] for d in listing["owned"]] == [doc["id"]]


def test_members_and_permission_ceiling(people):
    _, (owner, owner_headers), (other, other_headers), stranger = people
    doc = create(owner, owner_headers)
    url = f"/api/docs/{doc['id']}"
    assert other.get(url).status_code == 404
    assert stranger.get(url).status_code == 401

    response = owner.post(f"{url}/members", headers=owner_headers,
                          json={"email": OTHER.upper(), "role": "view", "can_share": True})
    assert response.status_code == 200, response.text
    seen = other.get(url).json()
    assert seen["role"] == "view" and seen["can_share"] and "link" not in seen
    assert [d["id"] for d in other.get("/api/docs").json()["shared"]] == [doc["id"]]
    # 只读成员不能改标题，也不能把别人提升到超过自己的权限。
    assert other.patch(url, headers=other_headers, json={"title": "x"}).status_code == 403
    assert other.post(f"{url}/members", headers=other_headers,
                      json={"email": OWNER, "role": "edit"}).status_code in {400, 403}
    assert other.put(f"{url}/link", headers=other_headers, json={"role": "view"}).status_code == 403

    owner.patch(url, headers=owner_headers, json={"allow_copy": False})
    assert other.get(url).json()["can_copy"] is False
    assert other.post(f"{url}/members/{seen['owner']['id']}/remove",
                      headers=other_headers).status_code == 404
    me = user_id(other, other_headers)
    assert other.post(f"{url}/members/{me}/remove", headers=other_headers).status_code == 200
    assert other.get(url).status_code == 404


def test_links_require_login_and_password(people):
    _, (owner, owner_headers), (other, other_headers), stranger = people
    doc = create(owner, owner_headers)
    url = f"/api/docs/{doc['id']}"
    token = doc["link"]["token"]
    assert other.get(f"/api/docs/link/{token}").status_code == 404  # 尚未开启

    link = owner.put(f"{url}/link", headers=owner_headers,
                     json={"role": "edit", "password": "secret"}).json()
    assert link["has_password"]
    info = stranger.get(f"/api/docs/link/{token}").json()
    assert not info["signed_in"] and info["needs_password"] and info["title"] == ""
    assert stranger.get(f"{url}?link={token}").status_code == 401
    assert stranger.post(f"/api/docs/link/{token}/unlock", headers={"Origin": ORIGIN},
                         json={"password": "secret"}).status_code == 200
    # 可编辑链接对未登录访客也只能查看，写接口一律要求登录。
    seen = stranger.get(f"{url}?link={token}").json()
    assert seen["role"] == "view"
    assert stranger.patch(f"{url}?link={token}", headers={"Origin": ORIGIN},
                          json={"title": "x"}).status_code == 401

    assert other.get(f"{url}?link={token}").status_code == 401
    assert other.post(f"/api/docs/link/{token}/unlock", headers=other_headers,
                      json={"password": "wrong"}).status_code == 403
    assert other.post(f"/api/docs/link/{token}/unlock", headers=other_headers,
                      json={"password": "secret"}).status_code == 200
    assert other.get(f"{url}?link={token}").json()["role"] == "edit"

    # 重新生成后旧链接失效。
    owner.put(f"{url}/link", headers=owner_headers, json={"role": "edit", "regenerate": True})
    assert other.get(f"{url}?link={token}").status_code == 404


def released(app, doc_id):
    """等服务器处理完断线、写回并释放房间；断线在后台异步处理，紧接着的新连接可能还会进入旧房间。"""
    for _ in range(100):
        if doc_id not in getattr(app.state, "doc_rooms", docs.Rooms(None, None)).rooms:
            return
        time.sleep(0.02)
    raise AssertionError("房间没有释放")


def connect(client, path, origin=ORIGIN):
    """TestClient 的 WebSocket 不带 Cookie 罐里的登录 Cookie，这里手动附上。"""
    cookie = "; ".join(f"{name}={value}" for name, value in client.cookies.items())
    return client.websocket_connect(path, headers={"origin": origin, "cookie": cookie})


def sync(socket, ydoc):
    """完成 y-websocket 的初始同步：回应服务器的 SYNC_STEP1，并取回服务器上的内容。"""
    socket.send_bytes(create_sync_message(ydoc))
    for _ in range(2):
        message = socket.receive_bytes()
        reply = handle_sync_message(message[1:], ydoc)
        if reply:
            socket.send_bytes(reply)


def edit(socket, ydoc, text):
    updates = []
    ydoc.observe(lambda event: updates.append(event.update))
    ydoc["body"] += text
    socket.send_bytes(create_update_message(updates[-1]))


def test_realtime_sync_and_read_only_enforcement(people, monkeypatch):
    app, (owner, owner_headers), (other, other_headers), stranger = people
    doc = create(owner, owner_headers)
    path = f"/api/docs/ws/{doc['id']}"
    owner.post(f"/api/docs/{doc['id']}/members", headers=owner_headers,
               json={"email": OTHER, "role": "view"})

    with pytest.raises(WebSocketDisconnect) as closed:
        with connect(stranger, path) as socket:
            socket.receive_bytes()
    assert closed.value.code == docs.CLOSE_LOGIN
    with pytest.raises(WebSocketDisconnect) as closed:
        with connect(owner, path, "https://evil.example") as socket:
            socket.receive_bytes()
    assert closed.value.code == docs.CLOSE_FORBIDDEN

    writer_doc, reader_doc = Doc(), Doc()
    writer_doc["body"], reader_doc["body"] = Text(), Text()
    with connect(owner, path) as writer, \
            connect(other, path) as reader:
        sync(writer, writer_doc)
        sync(reader, reader_doc)
        edit(writer, writer_doc, "大家好")
        message = reader.receive_bytes()
        assert message[:2] == bytes([YMessageType.SYNC, YSyncMessageType.SYNC_UPDATE])
        handle_sync_message(message[1:], reader_doc)
        assert str(reader_doc["body"]) == "大家好"
        # 只读成员发来的修改被服务器丢弃，不会转发也不会保存。
        edit(reader, reader_doc, "！篡改")
        edit(writer, writer_doc, "，开会")
        message = reader.receive_bytes()
        handle_sync_message(message[1:], reader_doc)
    released(app, doc["id"])

    fresh = Doc()
    fresh["body"] = Text()
    with connect(owner, path) as socket:
        sync(socket, fresh)
    released(app, doc["id"])
    assert str(fresh["body"]) == "大家好，开会"
    # 第一轮编辑之前是空文档，不产生版本；停顿后再次编辑时，把上一轮的结果存为版本。
    assert owner.get(f"/api/docs/{doc['id']}/versions").json()["versions"] == []
    monkeypatch.setattr(docs, "IDLE_SECONDS", 0)
    with connect(owner, path) as socket:
        sync(socket, fresh)
        edit(socket, fresh, "！")
    released(app, doc["id"])
    versions = owner.get(f"/api/docs/{doc['id']}/versions").json()["versions"]
    assert len(versions) == 1 and versions[0]["auto"] and versions[0]["created_by"]["name"]
    assert other.get(f"/api/docs/{doc['id']}/versions").status_code == 403


def test_visitor_with_edit_link_is_read_only(people):
    _, (owner, owner_headers), _, stranger = people
    doc = create(owner, owner_headers)
    token = owner.put(f"/api/docs/{doc['id']}/link", headers=owner_headers,
                      json={"role": "edit"}).json()["token"]
    path = f"/api/docs/ws/{doc['id']}"
    writer_doc, visitor_doc = Doc(), Doc()
    writer_doc["body"], visitor_doc["body"] = Text(), Text()
    with connect(owner, path) as writer,             connect(stranger, f"{path}?link={token}") as visitor:
        sync(writer, writer_doc)
        sync(visitor, visitor_doc)
        edit(visitor, visitor_doc, "访客写入")
        edit(writer, writer_doc, "正文")
        message = visitor.receive_bytes()
        handle_sync_message(message[1:], visitor_doc)
    fresh = Doc()
    fresh["body"] = Text()
    with connect(owner, path) as socket:
        sync(socket, fresh)
    assert str(fresh["body"]) == "正文"


def test_revoking_access_closes_live_connection(people):
    _, (owner, owner_headers), (other, other_headers), _ = people
    doc = create(owner, owner_headers)
    url = f"/api/docs/{doc['id']}"
    owner.post(f"{url}/members", headers=owner_headers, json={"email": OTHER, "role": "edit"})
    reader_doc = Doc()
    reader_doc["body"] = Text()
    me = user_id(other, other_headers)
    with pytest.raises(WebSocketDisconnect) as closed:
        with connect(other, f"/api/docs/ws/{doc['id']}") as s:
            sync(s, reader_doc)
            owner.post(f"{url}/members/{me}/remove", headers=owner_headers)
            s.receive_bytes()
    assert closed.value.code == docs.CLOSE_FORBIDDEN


def test_manual_version_and_delete(people):
    _, (owner, owner_headers), (other, _), _ = people
    doc = create(owner, owner_headers)
    url = f"/api/docs/{doc['id']}"
    saved = owner.post(f"{url}/versions", headers=owner_headers, json={"label": "初稿"}).json()
    assert saved["label"] == "初稿" and not saved["auto"]
    state = owner.get(f"{url}/versions/{saved['id']}")
    assert state.status_code == 200 and state.headers["content-type"] == "application/octet-stream"
    assert owner.delete(url, headers=owner_headers).status_code == 200
    assert owner.get(url).status_code == 404
    assert owner.get("/api/docs").json()["owned"] == []

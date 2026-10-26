from test_accounts import PASSWORD, site  # noqa: F401
from test_docs import OTHER, OWNER, as_user, create, people  # noqa: F401
from test_drive import put_file
from test_images import agree


def befriend(owner, owner_headers, other, other_headers):
    email = other.get("/api/account/me").json()["user"]["email"]
    sent = owner.post("/api/friends/requests", headers=owner_headers, json={"email": email})
    assert sent.status_code == 200, sent.text
    request_id = other.get("/api/friends").json()["incoming"][0]["id"]
    accepted = other.post(f"/api/friends/requests/{request_id}/accept", headers=other_headers)
    assert accepted.status_code == 200, accepted.text
    return accepted.json()["friends"][0]["id"]


def uid(client):
    return client.get("/api/account/me").json()["user"]["id"]


def test_requests_accept_decline_and_remove(people):  # noqa: F811
    _, (owner, owner_headers), (other, other_headers), stranger = people
    assert stranger.get("/api/friends").status_code == 401
    missing = owner.post("/api/friends/requests", headers=owner_headers, json={"email": "nobody@qq.com"})
    assert missing.status_code == 404
    assert owner.post("/api/friends/requests", headers=owner_headers,
                      json={"email": OWNER}).status_code == 400

    # 发出后对方看到申请；拒绝后双方都不再有待处理的申请。
    sent = owner.post("/api/friends/requests", headers=owner_headers,
                      json={"email": OTHER.upper(), "message": "我是同事"})
    assert sent.status_code == 200 and sent.json()["friend"] is False
    assert sent.json()["outgoing"][0]["user"]["email"] == OTHER
    incoming = other.get("/api/friends").json()["incoming"]
    assert incoming[0]["message"] == "我是同事"
    assert other.get("/api/messages/summary").json()["requests"] == 1
    # 只有收件人能同意，发件人只能撤回。
    assert owner.post(f"/api/friends/requests/{incoming[0]['id']}/accept",
                      headers=owner_headers).status_code == 404
    declined = other.post(f"/api/friends/requests/{incoming[0]['id']}/decline", headers=other_headers)
    assert declined.status_code == 200 and declined.json()["incoming"] == []
    assert owner.get("/api/friends").json()["outgoing"] == []

    # 互相发申请时，后发的一方直接成为好友。
    owner.post("/api/friends/requests", headers=owner_headers, json={"email": OTHER})
    mutual = other.post("/api/friends/requests", headers=other_headers, json={"email": OWNER})
    assert mutual.json()["friend"] is True and mutual.json()["outgoing"] == []
    assert [f["email"] for f in owner.get("/api/friends").json()["friends"]] == [OTHER]
    again = owner.post("/api/friends/requests", headers=owner_headers, json={"email": OTHER})
    assert again.status_code == 409

    removed = other.post(f"/api/friends/{uid(owner)}/remove", headers=other_headers)
    assert removed.status_code == 200 and removed.json()["friends"] == []
    assert owner.get("/api/friends").json()["friends"] == []
    assert owner.post(f"/api/friends/{uid(other)}/remove", headers=owner_headers).status_code == 404


def test_cancel_request(people):  # noqa: F811
    _, (owner, owner_headers), (other, other_headers), _ = people
    owner.post("/api/friends/requests", headers=owner_headers, json={"email": OTHER})
    request_id = owner.get("/api/friends").json()["outgoing"][0]["id"]
    assert other.post(f"/api/friends/requests/{request_id}/cancel",
                      headers=other_headers).status_code == 404
    cancelled = owner.post(f"/api/friends/requests/{request_id}/cancel", headers=owner_headers)
    assert cancelled.status_code == 200 and cancelled.json()["outgoing"] == []
    assert other.get("/api/friends").json()["incoming"] == []


def test_invite_link(people):  # noqa: F811
    _, (owner, owner_headers), (other, other_headers), stranger = people
    invite = owner.get("/api/friends/invite").json()
    assert invite["url"].endswith(f"/messages?invite={invite['token']}")
    assert owner.get("/api/friends/invite").json()["token"] == invite["token"]
    assert stranger.get(f"/api/friends/invite/{invite['token']}").status_code == 401
    info = other.get(f"/api/friends/invite/{invite['token']}").json()
    assert info["user"]["id"] == uid(owner) and not info["self"] and not info["friend"]
    assert owner.post(f"/api/friends/invite/{invite['token']}/accept",
                      headers=owner_headers).status_code == 400

    # 重置后旧链接失效。
    reset = owner.post("/api/friends/invite/reset", headers=owner_headers).json()
    assert reset["token"] != invite["token"]
    assert other.post(f"/api/friends/invite/{invite['token']}/accept",
                      headers=other_headers).status_code == 404
    accepted = other.post(f"/api/friends/invite/{reset['token']}/accept", headers=other_headers)
    assert accepted.status_code == 200, accepted.text
    assert [f["id"] for f in accepted.json()["friends"]] == [uid(owner)]
    assert other.get(f"/api/friends/invite/{reset['token']}").json()["friend"] is True


def test_text_messages_unread_and_polling(people):  # noqa: F811
    _, (owner, owner_headers), (other, other_headers), _ = people
    other_id = uid(other)
    # 不是好友不能发私信。
    assert owner.post(f"/api/messages/with/{other_id}", headers=owner_headers,
                      json={"body": "你好"}).status_code == 404
    owner_id = befriend(other, other_headers, owner, owner_headers)
    assert owner_id == uid(other)

    sent = owner.post(f"/api/messages/with/{other_id}", headers=owner_headers, json={"body": "  你好  "})
    assert sent.status_code == 200 and sent.json()["body"] == "你好" and sent.json()["mine"]
    assert owner.post(f"/api/messages/with/{other_id}", headers=owner_headers,
                      json={"body": "   "}).status_code == 400
    assert other.get("/api/messages/summary").json()["unread"] == 1
    conversation = other.get("/api/messages/conversations").json()["items"][0]
    assert conversation["unread"] == 1 and conversation["last"]["body"] == "你好"

    # 打开会话即已读；之后按 updated_at 轮询只拿到新消息与状态变化。
    page = other.get(f"/api/messages/with/{uid(owner)}").json()
    assert [m["body"] for m in page["items"]] == ["你好"] and not page["items"][0]["mine"]
    assert other.get("/api/messages/summary").json()["unread"] == 0
    cursor = page["items"][-1]["updated_at"]
    assert other.get(f"/api/messages/with/{uid(owner)}", params={"after": cursor}).json()["items"] == []
    second = owner.post(f"/api/messages/with/{other_id}", headers=owner_headers, json={"body": "在吗"}).json()
    revoked = owner.post(f"/api/messages/{sent.json()['id']}/revoke", headers=owner_headers)
    assert revoked.status_code == 200
    polled = other.get(f"/api/messages/with/{uid(owner)}", params={"after": cursor}).json()["items"]
    assert {m["id"] for m in polled} == {second["id"], sent.json()["id"]}
    assert next(m for m in polled if m["revoked"])["body"] == ""
    # 只有发送者能撤回。
    assert other.post(f"/api/messages/{second['id']}/revoke", headers=other_headers).status_code == 404

    # 删除好友后不能再发，也看不到会话。
    other.post(f"/api/friends/{uid(owner)}/remove", headers=other_headers)
    assert owner.post(f"/api/messages/with/{other_id}", headers=owner_headers,
                      json={"body": "x"}).status_code == 404
    assert other.get("/api/messages/conversations").json()["items"] == []


def test_history_pages(people, monkeypatch):  # noqa: F811
    _, (owner, owner_headers), (other, other_headers), _ = people
    befriend(owner, owner_headers, other, other_headers)
    from app import messages

    monkeypatch.setattr(messages, "MINUTE_LIMIT", 1000)
    other_id = uid(other)
    for index in range(messages.PAGE + 5):
        assert owner.post(f"/api/messages/with/{other_id}", headers=owner_headers,
                          json={"body": str(index)}).status_code == 200
    first = owner.get(f"/api/messages/with/{other_id}").json()
    assert [m["body"] for m in first["items"]] == [str(i) for i in range(5, messages.PAGE + 5)]
    assert first["more"] is True
    older = owner.get(f"/api/messages/with/{other_id}",
                      params={"before": first["items"][0]["created_at"]}).json()
    assert [m["body"] for m in older["items"]] == [str(i) for i in range(5)] and older["more"] is False


def test_message_rate_limit(people, monkeypatch):  # noqa: F811
    _, (owner, owner_headers), (other, other_headers), _ = people
    befriend(owner, owner_headers, other, other_headers)
    from app import messages

    monkeypatch.setattr(messages, "MINUTE_LIMIT", 2)
    other_id = uid(other)
    for _ in range(2):
        assert owner.post(f"/api/messages/with/{other_id}", headers=owner_headers,
                          json={"body": "x"}).status_code == 200
    assert owner.post(f"/api/messages/with/{other_id}", headers=owner_headers,
                      json={"body": "x"}).status_code == 429


def test_file_card_only_for_the_conversation(people, site):  # noqa: F811
    app, (owner, owner_headers), (other, other_headers), stranger = people
    client, _, _, sent = site
    befriend(owner, owner_headers, other, other_headers)
    agree(owner, uid(owner))
    assert put_file(owner, owner_headers, "/报告.txt", b"hello world").status_code == 200
    owner.post("/api/drive/mkdir", headers=owner_headers, json={"path": "/资料"})
    other_id = uid(other)

    # 对方没有开通云盘，不能发文件卡片；文件夹与不存在的文件也不行。
    assert other.post(f"/api/messages/with/{uid(owner)}", headers=other_headers,
                      json={"kind": "file", "path": "/报告.txt"}).status_code == 403
    assert owner.post(f"/api/messages/with/{other_id}", headers=owner_headers,
                      json={"kind": "file", "path": "/资料"}).status_code == 400
    assert owner.post(f"/api/messages/with/{other_id}", headers=owner_headers,
                      json={"kind": "file", "path": "/没有.txt"}).status_code == 404
    card = owner.post(f"/api/messages/with/{other_id}", headers=owner_headers,
                      json={"kind": "file", "path": "/报告.txt"})
    assert card.status_code == 200, card.text
    assert card.json()["data"] == {"path": "/报告.txt", "name": "报告.txt", "size": 11}
    seen = other.get(f"/api/messages/with/{uid(owner)}").json()["items"][0]
    assert seen["data"] == {"name": "报告.txt", "size": 11}

    url = f"/api/messages/{seen['id']}/file"
    assert other.get(url).content == b"hello world"
    assert owner.get(url).status_code == 200
    assert other.get(url, params={"inline": 1}).headers["content-disposition"].startswith("inline")
    assert stranger.get(url).status_code == 401
    third, third_headers = as_user(app, client, sent, "third@qq.com")
    assert third.get(url).status_code == 404

    # 文件改名后卡片失效；撤回后也失效。
    owner.post("/api/drive/rename", headers=owner_headers, json={"path": "/报告.txt", "name": "新.txt"})
    assert other.get(url).status_code == 404
    owner.post("/api/drive/rename", headers=owner_headers, json={"path": "/新.txt", "name": "报告.txt"})
    assert other.get(url).status_code == 200
    owner.post(f"/api/messages/{seen['id']}/revoke", headers=owner_headers)
    assert other.get(url).status_code == 404


def test_file_card_ends_with_friendship(people):  # noqa: F811
    _, (owner, owner_headers), (other, other_headers), _ = people
    befriend(owner, owner_headers, other, other_headers)
    agree(owner, uid(owner))
    assert put_file(owner, owner_headers, "/a.txt", b"data").status_code == 200
    card = owner.post(f"/api/messages/with/{uid(other)}", headers=owner_headers,
                      json={"kind": "file", "path": "/a.txt"}).json()
    owner.post(f"/api/friends/{uid(other)}/remove", headers=owner_headers)
    assert other.get(f"/api/messages/{card['id']}/file").status_code == 404
    assert owner.get(f"/api/messages/{card['id']}/file").status_code == 200


def test_doc_invite(people):  # noqa: F811
    _, (owner, owner_headers), (other, other_headers), _ = people
    befriend(owner, owner_headers, other, other_headers)
    doc = create(owner, owner_headers)
    other_id = uid(other)
    invite = owner.post(f"/api/messages/with/{other_id}", headers=owner_headers,
                        json={"kind": "doc_invite", "doc_id": doc["id"], "role": "edit"})
    assert invite.status_code == 200, invite.text
    assert invite.json()["data"]["status"] == "pending" and invite.json()["data"]["title"] == "周会记录"
    assert other.get(f"/api/docs/{doc['id']}").status_code == 404
    # 只有收件人能接受。
    assert owner.post(f"/api/messages/{invite.json()['id']}/accept",
                      headers=owner_headers).status_code == 404
    accepted = other.post(f"/api/messages/{invite.json()['id']}/accept", headers=other_headers)
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["data"]["status"] == "accepted"
    assert other.get(f"/api/docs/{doc['id']}").json()["role"] == "edit"
    assert other.post(f"/api/messages/{invite.json()['id']}/accept",
                      headers=other_headers).status_code == 409
    # 发送者轮询时能看到状态变化。
    polled = owner.get(f"/api/messages/with/{other_id}", params={"after": invite.json()["updated_at"]})
    assert polled.json()["items"][0]["data"]["status"] == "accepted"

    # 再收到一个只读邀请时不会降级。
    lower = owner.post(f"/api/messages/with/{other_id}", headers=owner_headers,
                       json={"kind": "doc_invite", "doc_id": doc["id"], "role": "view"}).json()
    other.post(f"/api/messages/{lower['id']}/accept", headers=other_headers)
    assert other.get(f"/api/docs/{doc['id']}").json()["role"] == "edit"


def test_doc_invite_rules(people):  # noqa: F811
    _, (owner, owner_headers), (other, other_headers), _ = people
    befriend(owner, owner_headers, other, other_headers)
    doc = create(owner, owner_headers)
    owner_id, other_id = uid(owner), uid(other)
    # 没有分享权限不能邀请；不能邀请所有者本人。
    assert other.post(f"/api/messages/with/{owner_id}", headers=other_headers,
                      json={"kind": "doc_invite", "doc_id": doc["id"]}).status_code == 404
    owner.post(f"/api/docs/{doc['id']}/members", headers=owner_headers,
               json={"email": OTHER, "role": "view", "can_share": True})
    assert other.post(f"/api/messages/with/{owner_id}", headers=other_headers,
                      json={"kind": "doc_invite", "doc_id": doc["id"]}).status_code == 400
    # 只读成员不能邀请别人编辑。
    assert other.post(f"/api/messages/with/{owner_id}", headers=other_headers,
                      json={"kind": "doc_invite", "doc_id": doc["id"], "role": "edit"}).status_code == 403

    # 拒绝、撤回后都不能再接受。
    owner.post(f"/api/docs/{doc['id']}/members/{other_id}/remove", headers=owner_headers)
    first = owner.post(f"/api/messages/with/{other_id}", headers=owner_headers,
                       json={"kind": "doc_invite", "doc_id": doc["id"]}).json()
    declined = other.post(f"/api/messages/{first['id']}/decline", headers=other_headers)
    assert declined.json()["data"]["status"] == "declined"
    assert other.post(f"/api/messages/{first['id']}/accept", headers=other_headers).status_code == 409
    second = owner.post(f"/api/messages/with/{other_id}", headers=owner_headers,
                        json={"kind": "doc_invite", "doc_id": doc["id"]}).json()
    owner.post(f"/api/messages/{second['id']}/revoke", headers=owner_headers)
    assert other.post(f"/api/messages/{second['id']}/accept", headers=other_headers).status_code == 409

    # 文档删除后邀请失效。
    third = owner.post(f"/api/messages/with/{other_id}", headers=owner_headers,
                       json={"kind": "doc_invite", "doc_id": doc["id"]}).json()
    owner.delete(f"/api/docs/{doc['id']}", headers=owner_headers)
    assert other.post(f"/api/messages/{third['id']}/accept", headers=other_headers).status_code == 409
    assert other.get(f"/api/messages/with/{owner_id}").json()["items"][-1]["data"]["status"] == "expired"


def test_delete_account_removes_friends_and_messages(people):  # noqa: F811
    app, (owner, owner_headers), (other, other_headers), _ = people
    befriend(owner, owner_headers, other, other_headers)
    owner.post(f"/api/messages/with/{uid(other)}", headers=owner_headers, json={"body": "再见"})
    response = other.post("/api/account/delete", headers=other_headers, json={"password": PASSWORD})
    assert response.status_code == 200, response.text
    assert owner.get("/api/friends").json()["friends"] == []
    from sqlmodel import Session, select

    from app.models import Friendship, Message

    with Session(app.state.engine) as session:
        assert session.exec(select(Message)).all() == []
        assert session.exec(select(Friendship)).all() == []

import socket
import time

import httpx
import pytest
from test_accounts import signup, site  # noqa: F401
from test_docs import as_user
from test_drive import enable, put_file
from test_drive_protocols import free_port
from test_images import agree, user_id

from app.drive.serve import Context, start_dav

OWNER = "owner@qq.com"
MEMBER = "member@qq.com"
READER = "reader@qq.com"
MIB = 1024 * 1024


@pytest.fixture
def people(site):  # noqa: F811
    client, app, settings, sent = site
    owner, owner_headers = as_user(app, client, sent, OWNER)
    uid = user_id(owner, owner_headers)
    enable(client, uid, quota_mb=100)
    agree(owner, uid)
    member, member_headers = as_user(app, client, sent, MEMBER)
    reader, reader_headers = as_user(app, client, sent, READER)
    return app, settings, (owner, owner_headers), (member, member_headers), (reader, reader_headers)


def create_team(owner, headers, quota_mb=20, name="数模比赛"):
    response = owner.post("/api/teams", headers=headers, json={"name": name, "quota_mb": quota_mb})
    assert response.status_code == 200, response.text
    return response.json()


def invite(owner, headers, team, email, role="edit"):
    response = owner.post(f"/api/teams/{team['id']}/members", headers=headers,
                          json={"email": email, "role": role})
    assert response.status_code == 200, response.text


def put_team(client, headers, team_id, path, payload: bytes):
    created = client.post(f"/api/drive/uploads?team={team_id}", headers=headers,
                          json={"path": path, "size": len(payload)})
    if created.status_code != 200:
        return created
    upload = created.json()["id"]
    response = client.put(f"/api/drive/uploads/{upload}?offset=0", headers=headers, content=payload)
    assert response.status_code == 200, response.text
    return client.post(f"/api/drive/uploads/{upload}/finish", headers=headers)


def tree_names(client, team):
    response = client.get(f"/api/teams/{team['id']}/tree")
    assert response.status_code == 200, response.text
    return {item["path"]: item for item in response.json()["items"]}


def test_quota_is_reserved_from_owner(people):
    _, _, (owner, owner_headers), (member, member_headers), _ = people
    # 没有开通云盘的人不能创建团队。
    assert member.post("/api/teams", headers=member_headers,
                       json={"name": "x", "quota_mb": 10}).status_code == 403
    listing = owner.get("/api/teams").json()
    assert listing["can_create"] and listing["default_quota"] == 50 * MIB  # 剩余不足 1 GB：一半
    assert owner.post("/api/teams", headers=owner_headers,
                      json={"name": "x", "quota_mb": 101}).status_code == 400
    team = create_team(owner, owner_headers, 30)
    assert len(team["id"]) == 10 and team["dav_url"].endswith(f"/t/{team['id']}/")
    storage = owner.get("/api/drive").json()["storage"]
    assert storage["used"] == 30 * MIB and storage["teams_reserved"] == 30 * MIB
    # 调大不能超过剩余配额，调小不能小于已用量。
    url = f"/api/teams/{team['id']}"
    assert owner.patch(url, headers=owner_headers, json={"quota_mb": 101}).status_code == 400
    assert owner.patch(url, headers=owner_headers, json={"quota_mb": 100}).json()["quota"] == 100 * MIB
    assert put_team(owner, owner_headers, team['id'], "/a.bin", b"x" * 20).status_code == 200
    # 个人云盘已没有剩余：团队空间仍可写，个人云盘不行。
    assert put_file(owner, owner_headers, "/mine.bin", b"x").status_code == 413
    assert owner.delete(url, headers=owner_headers).status_code == 200
    assert owner.get("/api/drive").json()["storage"]["used"] == 0


def test_members_files_and_roles(people):
    _, _, (owner, owner_headers), (member, member_headers), (reader, reader_headers) = people
    team = create_team(owner, owner_headers, 10)
    tid = team["id"]
    assert member.get(f"/api/teams/{tid}").status_code == 404
    invite(owner, owner_headers, team, MEMBER)
    invite(owner, owner_headers, team, READER, "view")
    assert [t["id"] for t in member.get("/api/teams").json()["teams"]] == [tid]
    # 只有所有者能管理成员。
    assert member.post(f"/api/teams/{tid}/members", headers=member_headers,
                       json={"email": READER, "role": "edit"}).status_code == 403

    # 成员（未开通云盘）通过云盘接口读写团队空间。
    assert member.post(f"/api/drive/mkdir?team={tid}", headers=member_headers,
                       json={"path": "/资料"}).status_code == 200
    assert put_team(member, member_headers, tid, "/资料/题目.txt", b"hello").status_code == 200
    listing = reader.get("/api/drive/list", params={"path": "/资料", "team": tid}).json()
    assert listing["read_only"] and [i["name"] for i in listing["items"]] == ["题目.txt"]
    assert reader.get("/api/drive/download", params={"path": "/资料/题目.txt", "team": tid}).content == b"hello"
    assert reader.post(f"/api/drive/delete?team={tid}", headers=reader_headers,
                       json={"paths": ["/资料/题目.txt"]}).status_code == 403
    assert put_team(reader, reader_headers, tid, "/r.txt", b"x").status_code == 403
    # 非成员看不到；也不能借上传会话写进别人的团队。
    owner.post(f"/api/teams/{tid}/members/{user_id(reader, reader_headers)}/remove", headers=owner_headers)
    assert reader.get("/api/drive/list", params={"path": "/", "team": tid}).status_code == 404
    # 配额：团队空间满了拒绝上传。
    assert put_team(member, member_headers, tid, "/big.bin", b"x" * (10 * MIB)).status_code == 413
    assert owner.get(f"/api/teams/{tid}").json()["used"] == 5


def test_team_docs_access_snapshots_and_folders(people):
    _, _, (owner, owner_headers), (member, member_headers), (reader, reader_headers) = people
    team = create_team(owner, owner_headers)
    tid = team["id"]
    invite(owner, owner_headers, team, MEMBER)
    invite(owner, owner_headers, team, READER, "view")
    member.post(f"/api/drive/mkdir?team={tid}", headers=member_headers, json={"path": "/报告"})
    doc = member.post(f"/api/teams/{tid}/docs", headers=member_headers,
                      json={"title": "论文 初稿", "folder": "/报告"}).json()
    assert doc["team"] == {"id": tid, "name": "数模比赛"} and doc["folder"] == "/报告"
    assert reader.post(f"/api/teams/{tid}/docs", headers=reader_headers, json={}).status_code == 403
    # 团队角色决定文档权限：所有者等同文档所有者，只读成员只读。
    assert owner.get(f"/api/docs/{doc['id']}").json()["role"] == "owner"
    assert reader.get(f"/api/docs/{doc['id']}").json()["role"] == "view"
    assert doc["id"] in [d["id"] for d in reader.get("/api/docs").json()["shared"]]

    # Markdown 快照以只读 .md 出现在所在文件夹。
    assert reader.put(f"/api/docs/{doc['id']}/markdown", headers=reader_headers,
                      json={"markdown": "x"}).status_code == 403
    assert member.put(f"/api/docs/{doc['id']}/markdown", headers=member_headers,
                      json={"markdown": "# 摘要\n"}).status_code == 200
    items = tree_names(reader, team)
    assert items["/报告/论文 初稿.md"]["doc"] == doc["id"]
    assert reader.get("/api/drive/download", params={"path": "/报告/论文 初稿.md", "team": tid}).text == "# 摘要\n"
    assert member.post(f"/api/drive/delete?team={tid}", headers=member_headers,
                       json={"paths": ["/报告/论文 初稿.md"]}).status_code == 403
    # 改名、移动文件夹时文档跟着走；删除文件夹后文档回到根目录。
    assert member.post(f"/api/drive/rename?team={tid}", headers=member_headers,
                       json={"path": "/报告/论文 初稿.md", "name": "终稿.md"}).status_code == 200
    assert member.get(f"/api/docs/{doc['id']}").json()["title"] == "终稿"
    member.post(f"/api/drive/rename?team={tid}", headers=member_headers, json={"path": "/报告", "name": "提交"})
    assert "/提交/终稿.md" in tree_names(member, team)
    member.post(f"/api/drive/delete?team={tid}", headers=member_headers, json={"paths": ["/提交"]})
    assert "/终稿.md" in tree_names(member, team)

    # 成员退出时，他建的文档转给团队所有者。
    member_id = user_id(member, member_headers)
    assert member.post(f"/api/teams/{tid}/members/{member_id}/remove", headers=member_headers).status_code == 200
    assert member.get(f"/api/docs/{doc['id']}").status_code == 404
    assert doc["id"] in [d["id"] for d in owner.get("/api/docs").json()["owned"]]
    # 删除团队连同文档一起删除。
    owner.delete(f"/api/teams/{tid}", headers=owner_headers)
    assert owner.get(f"/api/docs/{doc['id']}").status_code == 404


def test_text_editing_detects_conflicts(people):
    _, _, (owner, owner_headers), (member, member_headers), _ = people
    team = create_team(owner, owner_headers)
    tid = team["id"]
    invite(owner, owner_headers, team, MEMBER)
    url = f"/api/teams/{tid}/text"
    created = member.put(url, headers=member_headers, json={"path": "/.gitignore", "content": "node_modules\n"})
    assert created.status_code == 200, created.text
    opened = owner.get(url, params={"path": "/.gitignore"}).json()
    assert opened["content"] == "node_modules\n" and opened["version"] == created.json()["version"]
    time.sleep(0.01)
    saved = member.put(url, headers=member_headers, json={
        "path": "/.gitignore", "content": "dist\n", "version": created.json()["version"]})
    assert saved.status_code == 200
    stale = owner.put(url, headers=owner_headers, json={
        "path": "/.gitignore", "content": "x\n", "version": opened["version"]})
    assert stale.status_code == 409
    forced = owner.put(url, headers=owner_headers, json={
        "path": "/.gitignore", "content": "x\n", "version": opened["version"], "force": True})
    assert forced.status_code == 200
    put_team(owner, owner_headers, tid, "/bin.dat", b"\xff\xfe\x00")
    assert owner.get(url, params={"path": "/bin.dat"}).status_code == 400


@pytest.fixture
def dav(people):
    app, settings, *_ = people
    port = free_port()
    server = start_dav(Context(app.state.engine, settings), f"127.0.0.1:{port}")
    deadline = time.time() + 5
    while time.time() < deadline:
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
            break
        except OSError:
            time.sleep(0.05)
    yield f"http://127.0.0.1:{port}"
    server.stop()


def test_team_webdav_root(people, dav):
    _, _, (owner, owner_headers), (member, member_headers), (reader, reader_headers) = people
    team = create_team(owner, owner_headers)
    tid = team["id"]
    invite(owner, owner_headers, team, MEMBER)
    invite(owner, owner_headers, team, READER, "view")
    doc = owner.post(f"/api/teams/{tid}/docs", headers=owner_headers, json={"title": "笔记"}).json()
    owner.put(f"/api/docs/{doc['id']}/markdown", headers=owner_headers, json={"markdown": "正文"})
    member_password = member.post("/api/teams-access/app-passwords", headers=member_headers,
                                  json={"name": "笔记本"}).json()["password"]
    reader_password = reader.post("/api/teams-access/app-passwords", headers=reader_headers,
                                  json={}).json()["password"]

    with httpx.Client(base_url=dav, auth=(MEMBER, member_password), timeout=10) as client:
        # 未开通云盘：个人云盘拒绝，团队空间可以访问。
        assert client.request("PROPFIND", "/", headers={"Depth": "0"}).status_code == 401
        listing = client.request("PROPFIND", "/t/", headers={"Depth": "1"})
        assert listing.status_code == 207 and tid in listing.text
        assert client.request("MKCOL", f"/t/{tid}/src/").status_code == 201
        assert client.put(f"/t/{tid}/src/main.py", content=b"print(1)\n").status_code == 201
        moved = client.request("MOVE", f"/t/{tid}/src/main.py",
                               headers={"Destination": f"{dav}/t/{tid}/main.py"})
        assert moved.status_code in {201, 204}
        assert client.request("MOVE", f"/t/{tid}/main.py",
                              headers={"Destination": f"{dav}/t/other/main.py"}).status_code in {403, 409}
        assert client.get(f"/t/{tid}/笔记.md").text == "正文"
        assert client.put(f"/t/{tid}/笔记.md", content=b"x").status_code == 403
        assert client.request("PROPFIND", "/t/nobody/", headers={"Depth": "0"}).status_code == 404
    assert "/main.py" in tree_names(owner, team)

    with httpx.Client(base_url=dav, auth=(READER, reader_password), timeout=10) as client:
        assert client.get(f"/t/{tid}/main.py").content == b"print(1)\n"
        assert client.put(f"/t/{tid}/x.txt", content=b"x").status_code == 403
        assert client.delete(f"/t/{tid}/main.py").status_code == 403

    # 移除成员后立即无法访问（请求内重新计算角色，不受登录缓存影响）。
    owner.post(f"/api/teams/{tid}/members/{user_id(reader, reader_headers)}/remove", headers=owner_headers)
    with httpx.Client(base_url=dav, auth=(READER, reader_password), timeout=10) as client:
        assert client.get(f"/t/{tid}/main.py").status_code == 404


def test_account_deletion_removes_owned_teams(people):
    _, settings, (owner, owner_headers), (member, member_headers), _ = people
    team = create_team(owner, owner_headers)
    invite(owner, owner_headers, team, MEMBER)
    from test_accounts import PASSWORD

    assert owner.post("/api/account/delete", headers=owner_headers,
                      json={"password": PASSWORD}).status_code == 200
    assert member.get("/api/teams").json()["teams"] == []
    assert not (settings.drive_dir / ".teams" / team["id"]).exists()


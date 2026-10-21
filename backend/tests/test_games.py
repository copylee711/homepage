from sqlmodel import Session, select
from test_accounts import EMAIL, PASSWORD, signup, site  # noqa: F401
from test_content import ORIGIN, login

from app.models import GameScore


def submit(client, headers, game, score, duration=0):
    return client.post(f"/api/account/games/{game}", json={"score": score, "duration": duration},
                       headers=headers)


def board(client, game):
    response = client.get(f"/api/games/{game}/leaderboard")
    assert response.status_code == 200, response.text
    return response.json()


def test_submit_requires_login_and_csrf(site):  # noqa: F811
    client, _, _, sent = site
    assert submit(client, {"Origin": ORIGIN}, "watermelon", 10).status_code == 401
    assert client.get("/api/account/games").status_code == 401
    assert board(client, "watermelon") == {"items": [], "me": None}
    signup(client, sent)
    assert submit(client, {"Origin": ORIGIN}, "watermelon", 10).status_code == 403


def test_best_only_increases(site):  # noqa: F811
    client, _, _, sent = site
    headers = signup(client, sent)
    assert client.get("/api/account/games").json() == {"watermelon": None, "sheep": None}
    assert submit(client, headers, "watermelon", 500).json() == {
        "best": 500, "plays": 1, "improved": True}
    assert submit(client, headers, "watermelon", 300).json() == {
        "best": 500, "plays": 2, "improved": False}
    assert submit(client, headers, "watermelon", 800).json() == {
        "best": 800, "plays": 3, "improved": True}
    assert client.get("/api/account/games").json() == {
        "watermelon": {"best": 800, "detail": 0, "plays": 3}, "sheep": None}
    result = board(client, "watermelon")
    assert result["items"] == [{"rank": 1, "name": "读者", "avatar": "", "best": 800, "detail": 0}]
    assert result["me"] == {"best": 800, "detail": 0, "plays": 3, "rank": 1}


def test_sheep_tie_prefers_shorter_duration(site):  # noqa: F811
    client, _, _, sent = site
    first = signup(client, sent)
    assert submit(client, first, "sheep", 3, 200).json()["improved"] is True
    assert submit(client, first, "sheep", 3, 250).json()["improved"] is False
    assert submit(client, first, "sheep", 3, 120).json()["improved"] is True
    second = signup(client, sent, "other@163.com")
    assert submit(client, second, "sheep", 3, 150).status_code == 200
    rows = board(client, "sheep")
    assert [(r["rank"], r["detail"]) for r in rows["items"]] == [(1, 120), (2, 150)]
    assert rows["me"]["rank"] == 2
    assert submit(client, second, "sheep", 3, 100).json()["improved"] is True
    rows = board(client, "sheep")
    assert [r["detail"] for r in rows["items"]] == [100, 120]
    assert rows["me"] == {"best": 3, "detail": 100, "plays": 2, "rank": 1}


def test_validation_and_rate_limit(site):  # noqa: F811
    client, _, _, sent = site
    headers = signup(client, sent)
    assert submit(client, headers, "tetris", 1).status_code == 404
    assert client.get("/api/games/tetris/leaderboard").status_code == 404
    assert submit(client, headers, "watermelon", 100_001).status_code == 422
    assert submit(client, headers, "sheep", 501, 10_000).status_code == 422
    assert submit(client, headers, "sheep", 10, 49).status_code == 422
    assert submit(client, headers, "watermelon", -1).status_code == 422
    assert submit(client, headers, "watermelon", 1, 86_401).status_code == 422
    for _ in range(30):
        assert submit(client, headers, "watermelon", 1).status_code == 200
    assert submit(client, headers, "watermelon", 1).status_code == 429


def test_disabled_and_removed_users(site):  # noqa: F811
    client, app, _, sent = site
    headers = signup(client, sent)
    assert submit(client, headers, "watermelon", 900).status_code == 200
    other = signup(client, sent, "other@163.com")
    assert submit(client, other, "watermelon", 100).status_code == 200
    # 得分为 0 的成绩不上榜，但仍计入游玩次数
    third = signup(client, sent, "third@126.com")
    assert submit(client, third, "watermelon", 0).status_code == 200
    assert [r["best"] for r in board(client, "watermelon")["items"]] == [900, 100]
    admin = login(client)
    users = {u["email"]: u["id"] for u in client.get("/api/admin/accounts", headers=admin).json()["users"]}
    assert client.post(f"/api/admin/accounts/users/{users[EMAIL]}/state", json={"disabled": True},
                       headers=admin).status_code == 200
    rows = board(client, "watermelon")["items"]
    assert [(r["rank"], r["best"]) for r in rows] == [(1, 100)]
    assert client.post(f"/api/admin/accounts/users/{users['other@163.com']}/remove",
                       headers=admin).status_code == 200
    assert board(client, "watermelon")["items"] == []
    with Session(app.state.engine) as session:
        owners = {row.user_id for row in session.exec(select(GameScore)).all()}
    assert owners == {users[EMAIL], users["third@126.com"]}


def test_account_delete_removes_scores(site):  # noqa: F811
    client, app, _, sent = site
    headers = signup(client, sent)
    assert submit(client, headers, "sheep", 2, 60).status_code == 200
    assert client.post("/api/account/delete", json={"password": PASSWORD},
                       headers=headers).status_code == 200
    assert board(client, "sheep") == {"items": [], "me": None}
    with Session(app.state.engine) as session:
        assert session.exec(select(GameScore)).all() == []

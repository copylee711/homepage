"""小游戏成绩：登录访客的最高分跨设备同步，并生成公开排行榜。

成绩由浏览器上报，只做上限与限流校验；羊了个羊按通关数计分，同分时用时短者优先。
"""

from fastapi import HTTPException
from sqlalchemy import and_, func, or_
from sqlmodel import Session, select

from .accounts import record_failure, throttle
from .content import timestamp
from .models import GameScore, User

GAMES = {"watermelon": 100_000, "sheep": 500}
LEADERBOARD_SIZE = 50
SUBMIT_LIMIT = 30
SECONDS_PER_LEVEL = 5


def require_game(game: str) -> int:
    if game not in GAMES:
        raise HTTPException(404, "游戏不存在")
    return GAMES[game]


def detail_of(game: str, duration: int) -> int:
    return duration if game == "sheep" else 0


def submit(session: Session, user: User, game: str, body) -> dict:
    cap = require_game(game)
    if body.score > cap:
        raise HTTPException(422, "成绩超出上限")
    if game == "sheep" and body.duration < body.score * SECONDS_PER_LEVEL:
        raise HTTPException(422, "用时不合理")
    key = f"game:{user.id}"
    throttle(session, key, SUBMIT_LIMIT, "提交过于频繁，请稍后再试")
    record_failure(session, key)
    now = timestamp()
    row = session.get(GameScore, (user.id, game))
    detail = detail_of(game, body.duration)
    improved = row is None or body.score > row.best or (
        game == "sheep" and body.score == row.best and detail < row.detail
    )
    if row is None:
        row = GameScore(user_id=user.id, game=game, best=0, best_at=now, updated_at=now)
    if improved:
        row.best, row.detail, row.best_at = body.score, detail, now
    row.plays += 1
    row.updated_at = now
    session.add(row)
    session.commit()
    return {"best": row.best, "plays": row.plays, "improved": improved}


def order(game: str):
    keys = [GameScore.best.desc()]
    if game == "sheep":
        keys.append(GameScore.detail.asc())
    return [*keys, GameScore.best_at.asc()]


def leaderboard(session: Session, game: str, user: User | None) -> dict:
    require_game(game)
    rows = session.exec(
        select(GameScore, User).join(User, User.id == GameScore.user_id)
        .where(GameScore.game == game, GameScore.best > 0, User.disabled == False)  # noqa: E712
        .order_by(*order(game)).limit(LEADERBOARD_SIZE)
    ).all()
    board = [
        {"rank": index, "name": owner.name, "avatar": owner.avatar, "best": score.best,
         "detail": score.detail}
        for index, (score, owner) in enumerate(rows, start=1)
    ]
    me = None
    mine = session.get(GameScore, (user.id, game)) if user else None
    if mine:
        better = GameScore.best > mine.best
        if game == "sheep":
            better = or_(better, and_(GameScore.best == mine.best, GameScore.detail < mine.detail))
        count = select(func.count()).select_from(GameScore).join(
            User, User.id == GameScore.user_id
        ).where(GameScore.game == game, User.disabled == False, better)  # noqa: E712
        me = {"best": mine.best, "detail": mine.detail, "plays": mine.plays,
              "rank": session.exec(count).one() + 1}
    return {"items": board, "me": me}


def mine(session: Session, user: User) -> dict:
    rows = {row.game: row for row in session.exec(
        select(GameScore).where(GameScore.user_id == user.id)
    ).all()}
    return {
        game: {"best": rows[game].best, "detail": rows[game].detail, "plays": rows[game].plays}
        if game in rows else None
        for game in GAMES
    }

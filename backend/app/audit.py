"""安全审计日志：注册、登录、退出、密码与账户变更。

按天滚动，保留 RETENTION_DAYS 天（不少于六个月，满足网络日志留存要求），过期文件自动删除。
"""
import json
import logging
from contextlib import contextmanager
from datetime import datetime, timezone
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path

from fastapi import HTTPException, Request

RETENTION_DAYS = 190
logger = logging.getLogger("copylee.audit")
logger.setLevel(logging.INFO)
logger.propagate = False


def setup(directory: Path) -> None:
    for handler in logger.handlers[:]:
        logger.removeHandler(handler)
        handler.close()
    directory.mkdir(parents=True, exist_ok=True)
    handler = TimedRotatingFileHandler(
        directory / "audit.log", when="midnight", backupCount=RETENTION_DAYS, encoding="utf-8", utc=True
    )
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(handler)


def record(event: str, request: Request, **fields) -> None:
    entry = {
        "time": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "event": event,
        "ip": request.client.host if request.client else "",
        "ua": request.headers.get("user-agent", "")[:300],
        **fields,
    }
    logger.info(json.dumps(entry, ensure_ascii=False))


@contextmanager
def outcome(event: str, request: Request, **fields):
    """记录一次操作及其结果；失败（HTTPException）时记下状态码与原因后继续抛出。"""
    try:
        yield
    except HTTPException as exc:
        record(event, request, ok=False, status=exc.status_code, reason=str(exc.detail), **fields)
        raise
    record(event, request, ok=True, **fields)

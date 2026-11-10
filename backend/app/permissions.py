"""Site administrator access to Iris execution grants and sandbox quotas."""

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, StrictFloat, StrictInt
from sqlalchemy.dialects.sqlite import insert
from sqlmodel import Session

from . import agent_sso, audit, storage
from .auth import current_session
from .models import Content, User
from .schemas import StorageQuotaWrite

router = APIRouter(prefix="/api/admin/permissions", tags=["permissions"])


class QuotaInput(BaseModel):
    quota: dict[str, StrictInt | StrictFloat]


class QuotaChange(QuotaInput):
    user_id: str = Field(min_length=1, max_length=128)


@router.get("/storage/defaults")
def storage_defaults(request: Request, session: Session = Depends(agent_sso.database)):
    current_session(request, session)
    return storage.default_quota(session)


@router.put("/storage/defaults")
def save_storage_defaults(body: StorageQuotaWrite, request: Request,
                          session: Session = Depends(agent_sso.database)):
    admin = current_session(request, session, write=True)
    value = body.model_dump()
    session.execute(insert(Content).values(key=storage.DEFAULTS_KEY, value=value)
                    .on_conflict_do_update(index_elements=["key"], set_={"value": value}))
    session.commit()
    audit.record("admin.storage_defaults", request, user=admin.user_id, ok=True, **value)
    return value


def iris(request: Request, action: str, payload: dict, *, timeout: float):
    settings = agent_sso.settings_for(request)
    try:
        response = httpx.post(
            settings.agent_url.rstrip("/") + "/auth/permissions/" + action,
            headers={"X-Agent-Client-Secret": settings.agent_client_secret},
            json=payload, timeout=timeout, follow_redirects=False,
        )
        result = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(503, "暂时无法连接 Iris，请稍后重试") from exc
    if response.status_code in {409, 422} and isinstance(result, dict):
        raise HTTPException(response.status_code, result.get("error") or "Iris 拒绝了此操作")
    if response.status_code != 200 or not isinstance(result, dict):
        raise HTTPException(503, "Iris 权限服务暂不可用")
    return result


@router.get("/iris/defaults")
def iris_defaults(request: Request, session: Session = Depends(agent_sso.database)):
    admin = current_session(request, session)
    return iris(request, "defaults", {"actor": admin.user_id}, timeout=15)


@router.put("/iris/defaults")
def save_iris_defaults(body: QuotaInput, request: Request,
                       session: Session = Depends(agent_sso.database)):
    admin = current_session(request, session, write=True)
    result = iris(request, "defaults/save", {"actor": admin.user_id, "quota": body.quota}, timeout=15)
    audit.record("admin.iris_defaults", request, user=admin.user_id, ok=True, quota=result["quota"])
    return result


@router.get("/iris/grants")
def list_grants(request: Request, session: Session = Depends(agent_sso.database)):
    current_session(request, session)
    return agent_sso.grants_view(request, session)


@router.post("/iris/grants")
def save_grant(body: agent_sso.GrantInput, request: Request,
               session: Session = Depends(agent_sso.database)):
    admin = current_session(request, session, write=True)
    result = agent_sso.change_grant(body, request, session, admin.user_id)
    if body.days == 0:
        # The persisted revocation is authoritative, including during a gateway outage.
        try:
            iris(request, "abort", {"actor": admin.user_id, "target": body.user_id}, timeout=5)
        except HTTPException:
            audit.record("admin.iris_abort", request, user=admin.user_id,
                         target=body.user_id, ok=False)
            return {**result, "abort_pending": True}
    return result


def quota_target(session: Session, user_id: str):
    if session.get(User, user_id) is None:
        raise HTTPException(404, "账户不存在")


@router.get("/iris/quota")
def read_quota(request: Request, user_id: str = Query(min_length=1, max_length=128),
               session: Session = Depends(agent_sso.database)):
    admin = current_session(request, session)
    quota_target(session, user_id)
    return iris(request, "quota", {"actor": admin.user_id, "target": user_id}, timeout=15)


@router.post("/iris/quota")
def save_quota(body: QuotaChange, request: Request,
               session: Session = Depends(agent_sso.database)):
    admin = current_session(request, session, write=True)
    quota_target(session, body.user_id)
    result = iris(request, "quota/save", {
        "actor": admin.user_id, "target": body.user_id, "quota": body.quota,
    }, timeout=140)
    audit.record("admin.iris_quota", request, user=admin.user_id, target=body.user_id,
                 ok=True, quota=result.get("quota"))
    return result

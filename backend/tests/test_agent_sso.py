import base64
import hashlib
import time
from urllib.parse import parse_qs, urlsplit

import pytest
from sqlmodel import Session, select
from test_content import ADMIN_EMAIL, ORIGIN, PASSWORD
from test_content import login as admin_login

from app.accounts import hash_password
from app.auth import digest
from app.models import AgentGrant, AgentSession, User, UserChallenge, UserSession

SECRET = "test-agent-client-secret-at-least-32-characters"
PRIVATE = {"X-Agent-Client-Secret": SECRET}
VERIFIER = "test-verifier-" + "a" * 40
CHALLENGE = base64.urlsafe_b64encode(hashlib.sha256(VERIFIER.encode()).digest()).rstrip(b"=").decode()
QUERY = {"state": "browser-state-at-least-20-characters", "code_challenge": CHALLENGE}


@pytest.fixture
def agent(server):
    client, app, settings = server
    settings.agent_url = "https://ai.copylee.test"
    settings.agent_client_secret = SECRET
    return client, app, settings


def login(client):
    result = client.post('/api/account/login', headers={"Origin": ORIGIN},
                         json={"email": ADMIN_EMAIL, "password": PASSWORD})
    assert result.status_code == 200
    return {"Origin": ORIGIN, "X-CSRF-Token": result.json()["csrf"]}


def authorize(client):
    response = client.get('/api/agent/authorize', params=QUERY, follow_redirects=False)
    assert response.status_code == 302
    assert response.headers['referrer-policy'] == 'no-referrer'
    target = urlsplit(response.headers['location'])
    assert target.netloc == 'ai.copylee.test'
    query = parse_qs(target.query)
    assert query['state'][0] == QUERY['state']
    return query['code'][0]


def exchange(client, code, verifier=VERIFIER, headers=PRIVATE):
    return client.post('/api/agent/exchange', headers=headers,
                       json={"code": code, "verifier": verifier})


def introspect(client, token):
    return client.post('/api/agent/introspect', headers=PRIVATE, json={"token": token})


def test_workspace_shortcut_uses_current_execution_grant(agent):
    client, app, settings = agent
    assert client.get("/api/account/me").status_code == 401
    login(client)
    assert client.get("/api/account/me").json()["features"]["iris"] == settings.agent_url
    with Session(app.state.engine) as session:
        session.add(User(id="nav-user", email="nav@example.test", name="Reader",
                         password_hash=hash_password(PASSWORD), created_at="2026-01-02"))
        session.flush()
        session.add(AgentGrant(user_id="nav-user", granted_by="admin-user",
                               expires_at=time.time() + 3600, updated_at=time.time()))
        session.commit()
    result = client.post("/api/account/login", headers={"Origin": ORIGIN},
                         json={"email": "nav@example.test", "password": PASSWORD})
    assert result.status_code == 200
    settings.agent_user_execution_enabled = False
    assert "iris" not in client.get("/api/account/me").json()["features"]
    settings.agent_user_execution_enabled = True
    assert client.get("/api/account/me").json()["features"]["iris"] == settings.agent_url
    with Session(app.state.engine) as session:
        grant = session.get(AgentGrant, "nav-user")
        grant.expires_at = time.time() - 1
        session.add(grant)
        session.commit()
    assert "iris" not in client.get("/api/account/me").json()["features"]


def test_permissions_page_redirects_before_serving_html(agent):
    client, app, _ = agent
    path = "/permissions?section=defaults"
    access = "/api/permissions/access?section=defaults"

    def location():
        result = client.get(access)
        assert result.status_code == 200
        assert result.headers["cache-control"] == "no-store"
        return urlsplit(result.json()["redirect"])

    anonymous = location()
    assert anonymous.path == "/account" and parse_qs(anonymous.query) == {"next": [path]}
    with Session(app.state.engine) as session:
        session.add(User(id="regular", email="regular@example.test", name="Regular",
                         password_hash=hash_password(PASSWORD), created_at="2026-01-02"))
        session.commit()
    result = client.post("/api/account/login", headers={"Origin": ORIGIN},
                         json={"email": "regular@example.test", "password": PASSWORD})
    assert result.status_code == 200
    assert location().path == "/"
    login(client)
    step_up = location()
    assert step_up.path == "/admin" and parse_qs(step_up.query) == {"next": [path]}
    headers = admin_login(client)
    assert client.get(access).json() == {"csrf": headers["X-CSRF-Token"]}
    client.post("/api/account/login", headers={"Origin": ORIGIN},
                json={"email": "regular@example.test", "password": PASSWORD})
    assert location().path == "/"


def test_storage_defaults_apply_only_to_users_without_plans(agent):
    from app import storage

    client, app, _ = agent
    path = "/api/admin/permissions/storage/defaults"
    assert client.get(path).status_code == 401
    headers = admin_login(client)
    assert client.get(path).json() == {"quota_mb": 200, "max_image_mb": 5}
    new = {"quota_mb": 750, "max_image_mb": 8}
    assert client.put(path, json=new).status_code == 403
    assert client.put(path, headers=headers, json=new).json() == new
    with Session(app.state.engine) as session:
        assert storage.plan(session, "admin-user").quota_bytes == 20 * 1024 * storage.MIB
        assert storage.plan(session, "new-user").quota_bytes == 750 * storage.MIB
        storage.save(session, "new-user", images_enabled=True)
        session.commit()
    assert client.put(path, headers=headers, json={"quota_mb": 900, "max_image_mb": 9}).status_code == 200
    with Session(app.state.engine) as session:
        assert storage.plan(session, "new-user").max_image_bytes == 8 * storage.MIB
        assert storage.plan(session, "later-user").max_image_bytes == 9 * storage.MIB


def test_permissions_console_requires_separate_admin_session_and_csrf(agent, monkeypatch):
    client, app, settings = agent
    path = '/api/admin/permissions/iris'
    headers = login(client)
    assert client.get(path + '/grants').status_code == 401
    assert client.post(path + '/quota', headers=headers,
                       json={"user_id": "admin-user", "quota": {}}).status_code == 401
    headers = admin_login(client)
    assert client.get(path + '/grants').json()["users"][0]["admin"] is True
    assert client.post(path + '/quota', headers={"Origin": ORIGIN},
                       json={"user_id": "admin-user", "quota": {}}).status_code == 403
    assert client.get(path + '/quota', params={"user_id": "missing"}).status_code == 404

    calls = []

    def relay(request, action, payload, *, timeout):
        calls.append((action, payload))
        return {"quota": payload.get("quota")}

    monkeypatch.setattr('app.permissions.iris', relay)
    with Session(app.state.engine) as session:
        session.add(User(id="visitor", email="visitor@example.com", name="访客",
                         password_hash="", created_at="2026-01-02T00:00:00+00:00"))
        session.commit()
    grant = {"user_id": "visitor", "days": 7}
    assert client.post(path + '/grants', headers=headers, json=grant).status_code == 409
    settings.agent_user_execution_enabled = True
    assert client.post(path + '/grants', headers=headers, json=grant).json()["expires_at"] > time.time()
    assert client.post(path + '/grants', headers=headers,
                       json={**grant, "days": 0}).json()["expires_at"] is None
    assert client.post(path + '/quota', headers=headers,
                       json={"user_id": "visitor", "quota": {"disk_mib": 1024}}).status_code == 200
    assert calls == [
        ("abort", {"actor": "admin-user", "target": "visitor"}),
        ("quota/save", {"actor": "admin-user", "target": "visitor", "quota": {"disk_mib": 1024}}),
    ]


def test_disabled_and_login_redirect(server, agent):
    client, _, settings = agent
    settings.agent_client_secret = ''
    assert client.get('/api/agent/authorize', params=QUERY).status_code == 503
    settings.agent_client_secret = SECRET
    result = client.get('/api/agent/authorize', params=QUERY, follow_redirects=False)
    assert result.status_code == 302
    assert result.headers['location'].startswith('/account?next=')
    assert client.get('/api/agent/authorize', params={**QUERY, 'state': 'wrong'}).status_code == 422


def test_pkce_private_client_replay_and_independent_session(agent):
    client, app, _ = agent
    login(client)
    code = authorize(client)
    assert exchange(client, code, headers={}).status_code == 401
    assert exchange(client, code, verifier='b' * 43).status_code == 400
    result = exchange(client, code)
    assert result.status_code == 200 and 'set-cookie' not in result.headers
    token = result.json()['token']
    assert exchange(client, code).status_code == 400
    assert introspect(client, token).json()['can_execute'] is True
    with Session(app.state.engine) as session:
        row = session.get(AgentSession, digest(token))
        assert row and row.token_hash != token and row.expires_at <= time.time() + 8 * 3600


def test_execution_can_outlive_agent_login_but_not_explicit_revocation(agent):
    client, app, _ = agent
    login(client)
    token = exchange(client, authorize(client)).json()["token"]
    with Session(app.state.engine) as session:
        row = session.get(AgentSession, digest(token))
        row.expires_at = time.time() - 1
        session.add(row)
        session.commit()
    assert introspect(client, token).status_code == 401
    # A new browser session must not garbage-collect the credential for an active turn.
    assert exchange(client, authorize(client)).status_code == 200
    path = '/api/agent/execution/introspect'
    assert client.post(path, json={"token": token}).status_code == 401
    assert client.post(path, headers=PRIVATE, json={"token": token}).json()["can_execute"]
    assert client.post('/api/agent/revoke', headers=PRIVATE, json={"token": token}).status_code == 200
    assert client.post(path, headers=PRIVATE, json={"token": token}).status_code == 401


def test_parent_logout_revokes_app_session(agent):
    client, app, _ = agent
    headers = login(client)
    token = exchange(client, authorize(client)).json()['token']
    assert client.post('/api/account/logout', headers=headers).status_code == 200
    assert introspect(client, token).status_code == 401
    with Session(app.state.engine) as session:
        assert session.get(AgentSession, digest(token)) is None


def test_live_role_and_disabled_account(agent):
    client, app, _ = agent
    login(client)
    token = exchange(client, authorize(client)).json()['token']
    with Session(app.state.engine) as session:
        user = session.exec(select(User).where(User.email == ADMIN_EMAIL)).one()
        user.is_admin = False
        session.add(user)
        session.commit()
    assert introspect(client, token).json()['can_execute'] is False
    with Session(app.state.engine) as session:
        user = session.exec(select(User).where(User.email == ADMIN_EMAIL)).one()
        user.disabled = True
        session.add(user)
        session.commit()
    assert introspect(client, token).status_code == 401


def test_expiry_and_parent_revocation_before_exchange(agent):
    client, app, _ = agent
    headers = login(client)
    code = authorize(client)
    with Session(app.state.engine) as session:
        row = session.get(UserChallenge, digest(code))
        row.expires_at = time.time() - 1
        session.add(row)
        session.commit()
    assert exchange(client, code).status_code == 400
    code = authorize(client)
    client.post('/api/account/logout', headers=headers)
    assert exchange(client, code).status_code == 401


def test_revoke_requires_app_key(agent):
    client, _, _ = agent
    login(client)
    token = exchange(client, authorize(client)).json()['token']
    assert client.post('/api/agent/revoke', json={'token': token}).status_code == 401
    assert client.post('/api/agent/revoke', headers=PRIVATE, json={'token': token}).status_code == 200
    assert introspect(client, token).status_code == 401


def test_explicit_grants_gate_expiry_revoke_and_admin_only(agent):
    client, app, settings = agent
    login(client)
    token = exchange(client, authorize(client)).json()['token']
    with Session(app.state.engine) as session:
        session.add(User(id='ordinary', email='ordinary@example.test', name='普通用户',
                         password_hash='unused', created_at='2026-01-01'))
        session.commit()
    data = {'token': token, 'user_id': 'ordinary', 'days': 7}
    assert client.post('/api/agent/grants/save', headers=PRIVATE, json=data).status_code == 409
    settings.agent_user_execution_enabled = True
    assert client.post('/api/agent/grants/save', headers=PRIVATE, json=data).status_code == 200
    result = client.post('/api/agent/grants/list', headers=PRIVATE, json={'token': token})
    assert result.status_code == 200 and result.json()['enabled']
    with Session(app.state.engine) as session:
        # A distinct ordinary-user session retains its own parent binding.
        row = session.get(AgentSession, digest(token))
        session.add(UserSession(token_hash='ordinary-parent', user_id='ordinary',
                                csrf='test', expires_at=time.time() + 3600))
        session.flush()
        row.user_id = 'ordinary'
        row.parent_hash = 'ordinary-parent'
        session.add(row)
        session.commit()
    assert introspect(client, token).json()['can_execute'] is True
    assert introspect(client, token).json()['admin'] is False
    assert client.post('/api/agent/grants/list', headers=PRIVATE, json={'token': token}).status_code == 403
    assert client.post('/api/agent/grants/save', headers=PRIVATE, json=data).status_code == 403
    settings.agent_user_execution_enabled = False
    assert introspect(client, token).json()['can_execute'] is False
    settings.agent_user_execution_enabled = True
    with Session(app.state.engine) as session:
        grant = session.get(AgentGrant, 'ordinary')
        grant.expires_at = time.time() - 1
        session.add(grant)
        session.commit()
    assert introspect(client, token).json()['can_execute'] is False


def test_grants_validation_and_revocation(agent):
    client, app, settings = agent
    login(client)
    token = exchange(client, authorize(client)).json()['token']
    settings.agent_user_execution_enabled = True
    data = {'token': token, 'user_id': 'ordinary', 'days': 7}
    assert client.post('/api/agent/grants/save', headers=PRIVATE, json=data).status_code == 404
    with Session(app.state.engine) as session:
        session.add(User(id='ordinary', email='ordinary@example.test', name='普通用户',
                         password_hash='unused', created_at='2026-01-01'))
        session.commit()
    assert client.post('/api/agent/grants/save', headers=PRIVATE, json={**data, 'days': 31}).status_code == 422
    assert client.post('/api/agent/grants/save', json=data).status_code == 401
    assert client.post('/api/agent/grants/save', headers=PRIVATE, json=data).status_code == 200
    assert client.post('/api/agent/grants/save', headers=PRIVATE, json={**data, 'days': 0}).status_code == 200
    with Session(app.state.engine) as session:
        assert session.get(AgentGrant, 'ordinary') is None

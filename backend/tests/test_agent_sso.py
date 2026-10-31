import base64
import hashlib
import time
from urllib.parse import parse_qs, urlsplit

import pytest
from sqlmodel import Session, select
from test_content import ADMIN_EMAIL, ORIGIN, PASSWORD

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

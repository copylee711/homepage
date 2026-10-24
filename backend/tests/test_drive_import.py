import json
import sqlite3
from contextlib import closing

import asyncssh
import bcrypt
import pytest
from sqlmodel import Session, select
from test_accounts import signup, site  # noqa: F401
from test_drive import names

from app.drive import accounts
from app.drive.importer import run
from app.models import DriveMount, DriveShare, User

EMAIL = "reader@qq.com"


def legacy_db(path, home, key):
    """按旧系统数据库的表结构，只建导入需要的列。"""
    with closing(sqlite3.connect(path)) as db:
        db.executescript("""
            CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password TEXT,
                public_keys BLOB, home_dir TEXT, quota_size INTEGER, status INTEGER);
            CREATE TABLE folders (id INTEGER PRIMARY KEY, name TEXT, path TEXT, filesystem BLOB);
            CREATE TABLE users_folders_mapping (id INTEGER PRIMARY KEY, user_id INTEGER,
                folder_id INTEGER, virtual_path TEXT, quota_size INTEGER, quota_files INTEGER);
            CREATE TABLE shares (id INTEGER PRIMARY KEY, share_id TEXT, name TEXT, scope INTEGER,
                paths BLOB, created_at INTEGER, updated_at INTEGER, last_use_at INTEGER,
                expires_at INTEGER, password TEXT, max_tokens INTEGER, used_tokens INTEGER,
                user_id INTEGER);
        """)
        hashed = bcrypt.hashpw(b"old-password", bcrypt.gensalt(4)).decode()
        db.execute("INSERT INTO users VALUES (1, 'copy', ?, ?, ?, 20000000000, 1)",
                   (hashed, json.dumps([key]).encode(), str(home)))
        db.execute("INSERT INTO users VALUES (2, 'HK', ?, NULL, '/nowhere', 5000000000, 1)",
                   (hashed,))
        filesystem = {"provider": 1, "s3config": {"bucket": "copylee-cloud",
                                                  "key_prefix": "users/%username%/"}}
        db.execute("INSERT INTO folders VALUES (1, 'oss-private', '', ?)",
                   (json.dumps(filesystem).encode(),))
        db.execute("INSERT INTO users_folders_mapping VALUES (1, 1, 1, '/archive', 10000000000, 0)")
        db.execute("INSERT INTO shares VALUES (1, 'PQLPhuwVsz5rgZdpYAUXoZ', 'setup.exe', 1, ?, "
                   "1792590572090, 1792590572090, 1792595630972, 0, '', 0, 2, 1)",
                   (json.dumps(["/setup.exe"]).encode(),))
        db.commit()


def test_import_accounts_files_mounts_and_shares(site, tmp_path):  # noqa: F811
    client, app, settings, sent = site
    signup(client, sent, EMAIL)
    home = tmp_path / "old-home"
    (home / "zotero").mkdir(parents=True)
    (home / "zotero" / "A.zip").write_bytes(b"attachment")
    (home / "setup.exe").write_bytes(b"binary")
    key = asyncssh.generate_private_key("ssh-ed25519").export_public_key().decode().strip()
    source = tmp_path / "sftpgo.db"
    legacy_db(source, home, key)

    preview = run(settings, app.state.engine, source, {"copy": EMAIL}, False, True)
    assert "copy → reader@qq.com" in preview[0]
    with Session(app.state.engine) as session:
        assert session.exec(select(DriveMount)).first() is None

    with pytest.raises(ValueError, match="没有这些用户"):
        run(settings, app.state.engine, source, {"nobody": EMAIL}, True, False)
    with pytest.raises(ValueError, match="没有注册"):
        run(settings, app.state.engine, source, {"HK": "missing@qq.com"}, True, False)

    for _ in range(2):  # 重复执行不会产生重复数据
        run(settings, app.state.engine, source, {"copy": EMAIL}, True, True)
    with Session(app.state.engine) as session:
        user = session.exec(select(User).where(User.email == EMAIL)).one()
        mounts = {row.path: row for row in session.exec(select(DriveMount)).all()}
        assert mounts["/archive"].location == "users/copy/"
        assert mounts["/archive"].quota_bytes == 10_000_000_000
        assert mounts["/"].used_bytes == len(b"attachment") + len(b"binary")
        share = session.get(DriveShare, "PQLPhuwVsz5rgZdpYAUXoZ")
        assert share.paths == ["/setup.exe"] and share.used == 2 and share.mode == "read"
        assert accounts.check_password(session, "COPY", "old-password").id == user.id
        fingerprint = asyncssh.import_public_key(key).get_fingerprint("sha256")
        assert accounts.check_key(session, "copy", fingerprint).id == user.id
        assert len(accounts.credentials(session, user.id)) == 1

    assert sorted(names(client)) == ["archive", "setup.exe", "zotero"]
    info = client.get("/api/s/PQLPhuwVsz5rgZdpYAUXoZ").json()
    assert info["unlocked"] and info["name"] == "setup.exe"
    got = client.get("/api/s/PQLPhuwVsz5rgZdpYAUXoZ/download", params={"path": "/setup.exe"})
    assert got.content == b"binary"

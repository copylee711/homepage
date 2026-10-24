import asyncio
import os
import socket
import time

import asyncssh
import bcrypt
import httpx
import pytest
from sqlmodel import Session

from app import audit
from app.cli import migrate
from app.database import make_engine
from app.drive import accounts, dav, sftp
from app.drive.serve import Context, start_dav
from app.models import User
from app.settings import Settings
from app.storage import save

LEGACY = "old-sftpgo-password"


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


@pytest.fixture
def context(tmp_path):
    settings = Settings(data_dir=tmp_path / "data", static_dir=tmp_path / "dist",
                        sync_enabled=False, scut_sync_enabled=False)
    migrate(settings)
    audit.setup(settings.audit_dir, "drive.log")
    engine = make_engine(settings)
    key = asyncssh.generate_private_key("ssh-ed25519")
    with Session(engine) as session:
        session.add(User(id="u1", email="reader@qq.com", password_hash="x", name="读者",
                         created_at="2026-01-01T00:00:00+00:00"))
        save(session, "u1", quota_mb=1)
        accounts.enable(session, settings, "u1", True)
        session.commit()
        accounts.set_login(session, "u1", "HK",
                           legacy_hash=bcrypt.hashpw(LEGACY.encode(), bcrypt.gensalt(4)).decode())
        app_password = accounts.add_app_password(session, "u1", "Zotero")["password"]
        accounts.add_key(session, "u1", "laptop", key.export_public_key().decode())
    yield Context(engine, settings), key, app_password
    engine.dispose()


def run_sftp(context, scenario):
    async def main():
        server = await sftp.start(context, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        try:
            return await scenario(port)
        finally:
            server.close()
            await server.wait_closed()

    return asyncio.run(main())


def connect(port, **options):
    return asyncssh.connect("127.0.0.1", port, known_hosts=None, **options)


def test_sftp_password_key_and_file_operations(context):
    ctx, key, app_password = context

    async def scenario(port):
        with pytest.raises(asyncssh.PermissionDenied):
            await connect(port, username="hk", password="wrong", client_keys=None)
        async with connect(port, username="hk", password=LEGACY, client_keys=None) as conn:
            async with conn.start_sftp_client() as client:
                assert await client.realpath(".") == "/"
                await client.mkdir("/docs")
                async with client.open("/docs/a.txt", "wb") as handle:
                    await handle.write(b"hello over sftp")
                assert await client.listdir("/docs") == [".", "..", "a.txt"] or \
                    sorted(await client.listdir("/docs")) == [".", "..", "a.txt"]
                assert (await client.stat("/docs/a.txt")).size == 15
                await client.rename("/docs/a.txt", "/docs/b.txt")
                async with client.open("/docs/b.txt", "rb") as handle:
                    await handle.seek(6)
                    assert await handle.read() == b"over sftp"
                async with client.open("/docs/b.txt", "r+b") as handle:
                    await handle.seek(0)
                    await handle.write(b"HELLO")
                async with client.open("/docs/b.txt", "rb") as handle:
                    assert await handle.read() == b"HELLO over sftp"
                with pytest.raises(asyncssh.SFTPError):
                    await client.rmdir("/docs")
                await client.remove("/docs/b.txt")
                await client.rmdir("/docs")
                assert sorted(await client.listdir("/")) == [".", ".."]
                if hasattr(os, "statvfs"):  # asyncssh 只在支持 statvfs 的系统上声明该扩展
                    vfs = await client.statvfs("/")
                    assert vfs.blocks * vfs.frsize == 1024 * 1024
        async with connect(port, username="reader@qq.com", password=app_password,
                           client_keys=None) as conn:
            async with conn.start_sftp_client() as client:
                with pytest.raises(asyncssh.SFTPError):
                    async with client.open("/big.bin", "wb") as handle:
                        await handle.write(b"x" * (1024 * 1024 + 1))
                assert not await client.exists("/big.bin")
        async with connect(port, username="HK", client_keys=[key]) as conn:
            async with conn.start_sftp_client() as client:
                assert await client.listdir("/") is not None
            with pytest.raises((asyncssh.ChannelOpenError, asyncssh.ProcessError, OSError,
                                asyncssh.Error)):
                await conn.run("ls", check=True)

    run_sftp(ctx, scenario)


def test_sftp_abandoned_upload_is_discarded(context):
    ctx, _, app_password = context

    async def scenario(port):
        conn = await connect(port, username="HK", password=app_password, client_keys=None)
        client = await conn.start_sftp_client()
        handle = await client.open("/partial.bin", "wb")
        await handle.write(b"half")
        conn.close()
        await conn.wait_closed()
        await asyncio.sleep(0.3)
        async with connect(port, username="HK", password=app_password,
                           client_keys=None) as again:
            async with again.start_sftp_client() as client:
                return await client.exists("/partial.bin")

    assert run_sftp(ctx, scenario) is False


def test_sftp_failures_are_throttled(context):
    ctx, _, app_password = context

    async def scenario(port):
        for _ in range(10):
            with pytest.raises(asyncssh.PermissionDenied):
                await connect(port, username="HK", password="nope", client_keys=None)
        with pytest.raises(asyncssh.PermissionDenied):
            await connect(port, username="HK", password=app_password, client_keys=None)

    run_sftp(ctx, scenario)


@pytest.fixture
def webdav(context):
    ctx, _, app_password = context
    port = free_port()
    server = start_dav(ctx, f"127.0.0.1:{port}")
    deadline = time.time() + 5
    while time.time() < deadline:
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
            break
        except OSError:
            time.sleep(0.05)
    with httpx.Client(base_url=f"http://127.0.0.1:{port}", auth=("HK", app_password),
                      timeout=10) as client:
        yield client, port
    server.stop()


def test_webdav_operations(webdav):
    client, port = webdav
    anonymous = httpx.request("PROPFIND", f"http://127.0.0.1:{port}/", headers={"Depth": "1"})
    assert anonymous.status_code == 401 and "Basic" in anonymous.headers["www-authenticate"]
    legacy = httpx.request("PROPFIND", f"http://127.0.0.1:{port}/", headers={"Depth": "0"},
                           auth=("hk", LEGACY))
    assert legacy.status_code == 207

    assert client.request("MKCOL", "/zotero/").status_code == 201
    assert client.put("/zotero/A.zip", content=b"zotero attachment").status_code == 201
    assert client.put("/zotero/A.prop", content=b"<properties/>").status_code == 201
    listing = client.request("PROPFIND", "/zotero/", headers={"Depth": "1"})
    assert listing.status_code == 207
    assert "A.zip" in listing.text and "A.prop" in listing.text
    assert client.get("/zotero/A.zip").content == b"zotero attachment"
    ranged = client.get("/zotero/A.zip", headers={"Range": "bytes=7-16"})
    assert ranged.status_code == 206 and ranged.content == b"attachment"

    moved = client.request("MOVE", "/zotero/A.prop",
                           headers={"Destination": f"http://127.0.0.1:{port}/zotero/B.prop"})
    assert moved.status_code in {201, 204}
    copied = client.request("COPY", "/zotero/A.zip",
                            headers={"Destination": f"http://127.0.0.1:{port}/A.zip"})
    assert copied.status_code in {201, 204}
    over = client.request("COPY", "/zotero/A.zip", headers={
        "Destination": f"http://127.0.0.1:{port}/A.zip", "Overwrite": "F"})
    assert over.status_code == 412

    lock = client.request("LOCK", "/zotero/B.prop", headers={"Timeout": "Second-60"}, content=(
        '<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/>'
        '</D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>'))
    assert lock.status_code == 200
    token = lock.headers["lock-token"]
    assert client.put("/zotero/B.prop", content=b"x").status_code == 423
    assert client.request("UNLOCK", "/zotero/B.prop",
                          headers={"Lock-Token": token}).status_code == 204

    too_big = client.put("/huge.bin", content=b"x" * (1024 * 1024))
    assert too_big.status_code == 507
    assert client.get("/huge.bin").status_code == 404
    assert client.delete("/zotero/").status_code == 204
    assert client.request("PROPFIND", "/zotero/", headers={"Depth": "0"}).status_code == 404


def test_webdav_rejects_disabled_drive(webdav, context):
    client, _ = webdav
    ctx, _, _ = context
    with Session(ctx.engine) as session:
        save(session, "u1", drive_enabled=False)
        session.commit()
    dav_cache_cleared = client.request("PROPFIND", "/", headers={"Depth": "0"})
    # 认证缓存仍然有效时，打开网盘会被 Drive 拒绝；缓存过期后则直接拒绝登录。
    assert dav_cache_cleared.status_code in {401, 403}
    assert dav.CACHE_SECONDS <= 600

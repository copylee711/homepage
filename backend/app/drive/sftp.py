"""SFTP 服务：asyncssh 负责 SSH 协议，文件操作全部交给 Drive。

只提供 SFTP 子系统，不开放 shell、exec、SCP 与端口转发。认证方式为 SSH 公钥、
应用密码或导入的旧密码。客户端断开时未关闭的上传会被丢弃，不会留下半个文件。
"""

import asyncio
import logging
import posixpath
import stat as statmode
from pathlib import Path

import asyncssh
from sqlmodel import Session

from .. import storage
from . import accounts, paths
from .errors import Conflict, DriveError, Forbidden, NotFound, QuotaExceeded
from .vfs import Drive

logger = logging.getLogger("copylee.drive.sftp")

OPEN_READ, OPEN_WRITE, OPEN_APPEND = 0x01, 0x02, 0x04
OPEN_CREATE, OPEN_TRUNCATE, OPEN_EXCLUSIVE = 0x08, 0x10, 0x20


def translate(error: DriveError) -> asyncssh.SFTPError:
    if isinstance(error, NotFound):
        return asyncssh.SFTPNoSuchFile(error.message)
    if isinstance(error, Forbidden):
        return asyncssh.SFTPPermissionDenied(error.message)
    if isinstance(error, QuotaExceeded):
        return asyncssh.SFTPQuotaExceeded("Quota exceeded")
    if isinstance(error, Conflict):
        return asyncssh.SFTPFailure(error.message)
    return asyncssh.SFTPFailure(error.message)


def virtual(path: bytes) -> str:
    """客户端路径以网盘根目录为起点；先按 POSIX 规则折叠 .. 再规范化。"""
    text = path.decode("utf-8", "replace") or "."
    return paths.clean(posixpath.normpath(posixpath.join("/", text)))


def attributes(entry, read_only: bool) -> asyncssh.SFTPAttrs:
    if entry.is_dir:
        mode = statmode.S_IFDIR | (0o555 if read_only else 0o755)
        kind = asyncssh.FILEXFER_TYPE_DIRECTORY
    else:
        mode = statmode.S_IFREG | (0o444 if read_only else 0o644)
        kind = asyncssh.FILEXFER_TYPE_REGULAR
    mtime = int(entry.mtime)
    return asyncssh.SFTPAttrs(type=kind, size=entry.size, uid=0, gid=0, permissions=mode,
                              atime=mtime, mtime=mtime)


class Reader:
    def __init__(self, drive: Drive, path: str):
        self.drive, self.path = drive, path
        self.handle = drive.open_read(path)
        self.position = 0

    def read(self, offset: int, size: int) -> bytes:
        if offset != self.position:
            if self.handle.seekable():
                self.handle.seek(offset)
            else:
                self.handle.close()
                self.handle = self.drive.open_read(self.path, offset, log=False)
        data = self.handle.read(size)
        self.position = offset + len(data)
        return data

    def close(self):
        self.handle.close()


class Writer:
    def __init__(self, drive: Drive, path: str, seed: bool, append: bool):
        self.upload = drive.upload(path, seed=seed)
        self.append = append

    def read(self, offset: int, size: int) -> bytes:
        return self.upload.read(offset, size)

    def write(self, offset: int, data: bytes) -> int:
        try:
            return self.upload.write(data, self.upload.size if self.append else offset)
        except DriveError:
            # 写入失败（例如超出配额）后丢弃整个文件，关闭句柄时不再保存。
            self.upload.abort()
            raise

    def close(self):
        if not self.upload.done:
            self.upload.commit()

    def abort(self):
        self.upload.abort()


class DriveSFTPServer(asyncssh.SFTPServer):
    def __init__(self, chan, context):
        super().__init__(chan)
        conn = chan.get_connection()
        self.drive = Drive(context.engine, context.settings, conn.get_extra_info("drive_user"),
                           protocol="sftp", ip=conn.get_extra_info("peername", ("",))[0],
                           ua=conn.get_extra_info("client_version", "") or "")
        self.handles: set = set()

    async def call(self, function, *args):
        try:
            return await asyncio.to_thread(function, *args)
        except DriveError as error:
            raise translate(error) from None

    def read_only(self, path: str) -> bool:
        mount, _ = self.drive.resolve(path)
        return mount.read_only or mount.backend.read_only

    async def describe(self, path: str) -> asyncssh.SFTPAttrs:
        def run():
            return attributes(self.drive.stat(path), self.read_only(path))

        return await self.call(run)

    # —— 路径与属性 ——

    async def realpath(self, path):
        return virtual(path).encode()

    async def stat(self, path):
        return await self.describe(virtual(path))

    async def lstat(self, path):
        return await self.describe(virtual(path))

    async def fstat(self, file_obj):
        if isinstance(file_obj, Writer):
            return asyncssh.SFTPAttrs(type=asyncssh.FILEXFER_TYPE_REGULAR,
                                      size=file_obj.upload.size, permissions=0o100644)
        return await self.describe(file_obj.path)

    async def setstat(self, path, attrs):
        target = virtual(path)
        if attrs.mtime is not None:
            await self.call(self.drive.set_mtime, target, attrs.mtime)

    async def fsetstat(self, file_obj, attrs):
        if isinstance(file_obj, Writer) and attrs.size is not None:
            await self.call(file_obj.upload.truncate, attrs.size)

    async def scandir(self, path):
        target = virtual(path)

        def run():
            read_only = self.read_only(target)
            return [(entry.name, attributes(entry, read_only))
                    for entry in self.drive.list(target)]

        items = await self.call(run)
        here = await self.describe(target)
        for name in (".", ".."):
            yield asyncssh.SFTPName(name.encode(), attrs=here)
        for name, attrs in items:
            yield asyncssh.SFTPName(name.encode(), attrs=attrs)

    async def statvfs(self, path):
        def run():
            mount, _ = self.drive.resolve(virtual(path))
            allowed = self.drive.allowance(mount)
            if allowed is None:
                return 1 << 40, 1 << 40
            if mount.quota:
                return mount.quota, max(allowed, 0)
            with Session(self.drive.engine) as session:
                return storage.plan(session, self.drive.user_id).quota_bytes, max(allowed, 0)

        total, free = await self.call(run)
        block = 4096
        return asyncssh.SFTPVFSAttrs(bsize=block, frsize=block, blocks=total // block,
                                     bfree=free // block, bavail=free // block, namemax=255)

    # —— 文件 ——

    async def open(self, path, pflags, attrs):
        target = virtual(path)

        def run():
            writing = pflags & (OPEN_WRITE | OPEN_APPEND)
            if not writing:
                return Reader(self.drive, target)
            exists = self.drive.exists(target)
            if exists and pflags & OPEN_EXCLUSIVE:
                raise Conflict("文件已存在")
            if not exists and not pflags & OPEN_CREATE:
                raise NotFound("文件不存在")
            seed = exists and not pflags & OPEN_TRUNCATE
            return Writer(self.drive, target, seed, bool(pflags & OPEN_APPEND))

        handle = await self.call(run)
        self.handles.add(handle)
        return handle

    async def read(self, file_obj, offset, size):
        return await self.call(file_obj.read, offset, size)

    async def write(self, file_obj, offset, data):
        if not isinstance(file_obj, Writer):
            raise asyncssh.SFTPPermissionDenied("文件以只读方式打开")
        return await self.call(file_obj.write, offset, data)

    async def close(self, file_obj):
        self.handles.discard(file_obj)
        # 连接断开时 asyncssh 也会逐个关闭句柄；这时的上传不完整，直接丢弃。
        if isinstance(file_obj, Writer) and self.channel.is_closing():
            await asyncio.to_thread(file_obj.abort)
            return
        await self.call(file_obj.close)

    # —— 目录与改名 ——

    async def mkdir(self, path, attrs):
        await self.call(self.drive.mkdir, virtual(path))

    async def rmdir(self, path):
        await self.call(self.drive.rmdir, virtual(path))

    async def remove(self, path):
        target = virtual(path)

        def run():
            if self.drive.stat(target).is_dir:
                raise Forbidden("请使用 rmdir 删除目录")
            self.drive.delete(target)

        await self.call(run)

    async def rename(self, oldpath, newpath):
        await self.call(self.drive.move, virtual(oldpath), virtual(newpath), False)

    async def posix_rename(self, oldpath, newpath):
        await self.call(self.drive.move, virtual(oldpath), virtual(newpath), True)

    async def readlink(self, path):
        raise asyncssh.SFTPOpUnsupported("不支持符号链接")

    async def symlink(self, oldpath, newpath):
        raise asyncssh.SFTPOpUnsupported("不支持符号链接")

    async def link(self, oldpath, newpath):
        raise asyncssh.SFTPOpUnsupported("不支持硬链接")

    async def exit(self):
        for handle in list(self.handles):
            if isinstance(handle, Writer):
                await asyncio.to_thread(handle.abort)
            else:
                await asyncio.to_thread(handle.close)
        self.handles.clear()


class DriveSSHServer(asyncssh.SSHServer):
    def __init__(self, context):
        self.context = context
        self.conn = None
        self.ip = ""

    def connection_made(self, conn):
        self.conn = conn
        self.ip = (conn.get_extra_info("peername") or ("",))[0]

    def begin_auth(self, username):
        return True

    def password_auth_supported(self):
        return True

    def public_key_auth_supported(self):
        return True

    def authenticated(self, username: str, user_id: str, method: str):
        self.conn.set_extra_info(drive_user=user_id, drive_login=username, drive_method=method)

    def auth_completed(self):
        info = self.conn.get_extra_info
        self.context.log("drive.login", self.ip, user=info("drive_user"), login=info("drive_login"),
                         method=info("drive_method"), protocol="sftp")

    async def validate_password(self, username, password):
        def run():
            with Session(self.context.engine) as session:
                if accounts.blocked(session, username, self.ip):
                    return None
                user = accounts.check_password(session, username, password)
                if user is None:
                    accounts.fail(session, username, self.ip)
                    return None
                return user.id

        user_id = await asyncio.to_thread(run)
        if user_id is None:
            self.context.log("drive.login_failed", self.ip, login=username, protocol="sftp")
            return False
        self.authenticated(username, user_id, "password")
        return True

    async def validate_public_key(self, username, key):
        fingerprint = key.get_fingerprint("sha256")

        def run():
            with Session(self.context.engine) as session:
                if accounts.blocked(session, username, self.ip):
                    return None
                user = accounts.check_key(session, username, fingerprint)
                return user.id if user else None

        user_id = await asyncio.to_thread(run)
        if user_id is None:
            return False
        self.authenticated(username, user_id, "publickey")
        return True


def load_host_keys(directory: Path) -> list:
    """沿用旧服务的主机密钥（文件名 id_* 或 ssh_host_*_key），没有时生成 Ed25519。"""
    directory.mkdir(parents=True, exist_ok=True)
    keys = sorted(path for path in directory.iterdir()
                  if path.is_file() and not path.name.endswith(".pub")
                  and (path.name.startswith("id_") or path.name.startswith("ssh_host_")))
    if not keys:
        target = directory / "ssh_host_ed25519_key"
        target.write_bytes(asyncssh.generate_private_key("ssh-ed25519").export_private_key())
        target.chmod(0o600)
        keys = [target]
    return [asyncssh.read_private_key(str(path)) for path in keys]


async def start(context, host: str, port: int):
    return await asyncssh.create_server(
        lambda: DriveSSHServer(context), host, port,
        server_host_keys=load_host_keys(context.settings.host_keys_dir),
        sftp_factory=lambda chan: DriveSFTPServer(chan, context),
        allow_scp=False, login_timeout=60, keepalive_interval=60,
        server_version="CopyLeeDrive",
    )

"""WebDAV 服务：WsgiDAV 负责协议（PROPFIND、LOCK 等），资源读写全部交给 Drive。

客户端每个请求都带 Basic 认证，旧密码是 bcrypt，逐次校验代价太高，
因此成功的凭据在内存里缓存几分钟；密码或权限变更最多延迟这么久生效。

团队空间挂在 /t 下（/t/<代号>/ 是一个团队的根目录），由 TeamProvider 提供，
不要求成员开通个人云盘，权限按团队角色计算。
"""

import hashlib
import io
import threading
import time

import wsgidav.util  # noqa: F401  先加载 util，避免 wsgidav.dav_error 的循环导入
from sqlmodel import Session, select
from wsgidav.dav_error import (
    HTTP_CONFLICT,
    HTTP_FORBIDDEN,
    HTTP_INSUFFICIENT_STORAGE,
    HTTP_NOT_FOUND,
    DAVError,
)
from wsgidav.dav_provider import DAVCollection, DAVNonCollection, DAVProvider
from wsgidav.dc.base_dc import BaseDomainController
from wsgidav.wsgidav_app import WsgiDAVApp

from . import accounts, paths
from .errors import Conflict, DriveError, Forbidden, Invalid, NotFound, QuotaExceeded
from .vfs import Drive, TeamDrive

CACHE_SECONDS = 300
USER_KEY = "copylee.drive_user"
DRIVE_KEY = "copylee.drive"
TEAMS_SHARE = "/t"


def translate(error: DriveError) -> DAVError:
    if isinstance(error, NotFound):
        return DAVError(HTTP_NOT_FOUND, error.message)
    if isinstance(error, Forbidden):
        return DAVError(HTTP_FORBIDDEN, error.message)
    if isinstance(error, QuotaExceeded):
        return DAVError(HTTP_INSUFFICIENT_STORAGE, error.message)
    if isinstance(error, (Conflict, Invalid)):
        return DAVError(HTTP_CONFLICT, error.message)
    return DAVError(HTTP_FORBIDDEN, error.message)


def guarded(function, *args, **kwargs):
    try:
        return function(*args, **kwargs)
    except DriveError as error:
        raise translate(error) from None


class SeekableReader(io.RawIOBase):
    """WsgiDAV 处理 Range 时会 seek；对象存储的流不能 seek，就按偏移重新打开。"""

    def __init__(self, drive: Drive, path: str):
        self.drive, self.path = drive, path
        self.handle = drive.open_read(path)
        self.position = 0

    def readable(self):
        return True

    def seekable(self):
        return True

    def seek(self, offset, whence=io.SEEK_SET):
        if whence != io.SEEK_SET:
            raise io.UnsupportedOperation("只支持从文件开头定位")
        if offset != self.position:
            self.handle.close()
            self.handle = self.drive.open_read(self.path, offset, log=False)
            self.position = offset
        return offset

    def tell(self):
        return self.position

    def readinto(self, target):
        data = self.handle.read(len(target))
        target[:len(data)] = data
        self.position += len(data)
        return len(data)

    def close(self):
        if not self.closed:
            self.handle.close()
        super().close()


class Sink:
    """begin_write 返回的写入对象；提交与回滚在 end_write 里决定。"""

    def __init__(self, upload):
        self.upload = upload

    def write(self, data):
        guarded(self.upload.write, data)

    def close(self):
        pass


def make_resource(drive: Drive, path: str, entry, environ, prefix: str = ""):
    if entry.is_dir:
        return Folder(drive, path, entry, environ, prefix)
    return File(drive, path, entry, environ, prefix)


def share_path(prefix: str, path: str) -> str:
    """Drive 内的路径 → WsgiDAV 的资源路径（团队空间前面加上 /<代号>）。"""
    return prefix + ("" if path == "/" and prefix else path)


class Common:
    """文件与目录共用的操作；DELETE/MOVE/COPY 由 Drive 一次完成，不让 WsgiDAV 逐个处理。"""

    def local(self, dest_path: str) -> str:
        """目标的资源路径 → Drive 内的路径；团队空间不能移动或复制到别的团队。"""
        dest = guarded(paths.clean, dest_path)
        if not self.prefix:
            return dest
        if not paths.within(dest, self.prefix):
            raise DAVError(HTTP_FORBIDDEN, "不能移动或复制到其他团队")
        return paths.clean(dest[len(self.prefix):] or "/")

    def handle_delete(self):
        guarded(self.drive.delete, self.vpath)
        return True

    def handle_move(self, dest_path):
        guarded(self.drive.move, self.vpath, self.local(dest_path), True)
        return True

    def handle_copy(self, dest_path, *, depth_infinity):
        guarded(self.drive.copy, self.vpath, self.local(dest_path), True)
        return True

    def delete(self):
        guarded(self.drive.delete, self.vpath)

    def get_display_name(self):
        return self.entry.name

    def get_creation_date(self):
        return self.entry.mtime or None

    def get_last_modified(self):
        return self.entry.mtime or None

    def set_last_modified(self, dest_path, time_stamp, *, dry_run):
        if not dry_run:
            guarded(self.drive.set_mtime, self.local(dest_path), time_stamp)
        return True


class File(Common, DAVNonCollection):
    def __init__(self, drive: Drive, path: str, entry, environ, prefix: str = ""):
        super().__init__(share_path(prefix, path), environ)
        self.drive, self.vpath, self.entry, self.prefix = drive, path, entry, prefix
        self.upload = None

    def get_content_length(self):
        return self.entry.size

    def get_etag(self):
        return self.entry.etag or f"{self.entry.size:x}-{int(self.entry.mtime):x}"

    def support_etag(self):
        return True

    def support_ranges(self):
        return True

    def get_content(self):
        return guarded(SeekableReader, self.drive, self.vpath)

    def begin_write(self, *, content_type=None):
        self.upload = guarded(self.drive.upload, self.vpath)
        return Sink(self.upload)

    def end_write(self, *, with_errors):
        if self.upload is None:
            return
        if with_errors:
            self.upload.abort()
        else:
            guarded(self.upload.commit)


class Folder(Common, DAVCollection):
    def __init__(self, drive: Drive, path: str, entry, environ, prefix: str = ""):
        super().__init__(share_path(prefix, path), environ)
        self.drive, self.vpath, self.entry, self.prefix = drive, path, entry, prefix

    def get_etag(self):
        return None

    def get_member_names(self):
        return [entry.name for entry in guarded(self.drive.list, self.vpath)]

    def get_member_list(self):
        result = []
        for entry in guarded(self.drive.list, self.vpath):
            child = paths.join(self.vpath, entry.name)
            result.append(make_resource(self.drive, child, entry, self.environ, self.prefix))
        return result

    def get_member(self, name):
        child = paths.join(self.vpath, name)
        try:
            entry = self.drive.stat(child)
        except NotFound:
            return None
        except DriveError as error:
            raise translate(error) from None
        return make_resource(self.drive, child, entry, self.environ, self.prefix)

    def create_empty_resource(self, name):
        child = paths.join(self.vpath, guarded(paths.check_name, name))
        if self.environ.get("REQUEST_METHOD") == "LOCK":
            # 锁定尚不存在的文件时需要先占位（Windows 资源管理器会这样做）。
            upload = guarded(self.drive.upload, child)
            guarded(upload.commit)
            return make_resource(self.drive, child, guarded(self.drive.stat, child), self.environ,
                                 self.prefix)
        from .backends import Entry

        return File(self.drive, child, Entry(paths.name(child), False, 0, time.time()),
                    self.environ, self.prefix)

    def create_collection(self, name):
        guarded(self.drive.mkdir, paths.join(self.vpath, guarded(paths.check_name, name)))

    def get_used_bytes(self):
        mount, _ = self.drive.resolve(self.vpath)
        with Session(self.drive.engine) as session:
            from ..models import DriveMount, Team

            if isinstance(self.drive, TeamDrive):
                row = session.get(Team, self.drive.team_id)
            else:
                row = session.get(DriveMount, mount.id) if mount.id else None
            return row.used_bytes if row else 0

    def get_available_bytes(self):
        mount, _ = self.drive.resolve(self.vpath)
        allowed = self.drive.allowance(mount)
        return max(allowed, 0) if allowed is not None else None


class DriveProvider(DAVProvider):
    def __init__(self, context):
        super().__init__()
        self.context = context

    def drive(self, environ) -> Drive:
        drive = environ.get(DRIVE_KEY)
        if drive is None:
            drive = guarded(Drive, self.context.engine, self.context.settings, environ[USER_KEY],
                            protocol="webdav", ip=environ.get("copylee.client_ip", ""),
                            ua=environ.get("HTTP_USER_AGENT", ""))
            environ[DRIVE_KEY] = drive
        return drive

    def get_resource_inst(self, path, environ):
        drive = self.drive(environ)
        try:
            target = paths.clean(path)
            entry = drive.stat(target)
        except (NotFound, Invalid):
            return None
        except DriveError as error:
            raise translate(error) from None
        return make_resource(drive, target, entry, environ)


class TeamsRoot(DAVCollection):
    """/t/：列出自己所在的团队，目录名是团队代号。"""

    def __init__(self, provider: "TeamProvider", environ):
        super().__init__("/", environ)
        self.provider = provider

    def get_display_name(self):
        return "团队"

    def get_member_names(self):
        from ..models import Team, TeamMember

        user_id = self.environ[USER_KEY]
        with Session(self.provider.context.engine) as session:
            owned = session.exec(select(Team.id).where(Team.user_id == user_id)).all()
            joined = session.exec(select(TeamMember.team_id)
                                  .where(TeamMember.user_id == user_id)).all()
        return sorted({*owned, *joined})

    def get_member(self, name):
        return self.provider.get_resource_inst(f"/{name}", self.environ)

    def create_empty_resource(self, name):
        raise DAVError(HTTP_FORBIDDEN, "请在网页上创建团队")

    def create_collection(self, name):
        raise DAVError(HTTP_FORBIDDEN, "请在网页上创建团队")


class TeamProvider(DAVProvider):
    def __init__(self, context):
        super().__init__()
        self.context = context

    def drive(self, environ, team_id: str) -> TeamDrive | None:
        """当前用户在该团队的空间；不是成员时为 None。同一请求内缓存。"""
        from .. import teams
        from ..models import Team

        cache = environ.setdefault(DRIVE_KEY + ".teams", {})
        if team_id not in cache:
            with Session(self.context.engine) as session:
                team = session.get(Team, team_id)
                usable = teams.usable(session, team)
                role = teams.role_of(session, team, environ[USER_KEY]) if usable else None
            cache[team_id] = None if role is None else guarded(
                TeamDrive, self.context.engine, self.context.settings, team_id,
                environ[USER_KEY], role == "view", protocol="webdav",
                ip=environ.get("copylee.client_ip", ""), ua=environ.get("HTTP_USER_AGENT", ""))
        return cache[team_id]

    def get_resource_inst(self, path, environ):
        parts = paths.split(path)
        if not parts:
            return TeamsRoot(self, environ)
        drive = self.drive(environ, parts[0])
        if drive is None:
            return None
        try:
            target = paths.clean("/".join(parts[1:]))
            entry = drive.stat(target)
        except (NotFound, Invalid):
            return None
        except DriveError as error:
            raise translate(error) from None
        return make_resource(drive, target, entry, environ, f"/{parts[0]}")


def client_ip(environ) -> str:
    remote = environ.get("REMOTE_ADDR", "")
    forwarded = environ.get("HTTP_X_FORWARDED_FOR", "")
    # 只信任本机反向代理（Caddy）给出的来源地址。
    if forwarded and remote in {"127.0.0.1", "::1"}:
        return forwarded.split(",")[-1].strip()
    return remote


def teams_only(environ) -> bool:
    """请求的是团队空间：不要求开通个人云盘。"""
    target = environ.get("SCRIPT_NAME", "") + environ.get("PATH_INFO", "")
    return target == TEAMS_SHARE or target.startswith(TEAMS_SHARE + "/")


class DriveDomainController(BaseDomainController):
    def __init__(self, wsgidav_app, config):
        super().__init__(wsgidav_app, config)
        self.context = config["copylee_context"]
        # 键里带上访问范围，团队空间的登录不会被当成个人云盘的登录。
        self.cache: dict[tuple[bool, str, str], tuple[str, float]] = {}
        self.lock = threading.Lock()

    def __str__(self):
        return "CopyLeeDriveDomainController"

    def get_domain_realm(self, path_info, environ):
        return "Copy Lee Drive"

    def require_authentication(self, realm, environ):
        return True

    def supports_http_digest_auth(self):
        return False

    def basic_auth_user(self, realm, user_name, password, environ):
        ip = client_ip(environ)
        environ["copylee.client_ip"] = ip
        scope = teams_only(environ)
        key = (scope, accounts.login_key(user_name), hashlib.sha256(password.encode()).hexdigest())
        now = time.time()
        with self.lock:
            cached = self.cache.get(key)
        if cached and cached[1] > now:
            environ[USER_KEY] = cached[0]
            return True
        with Session(self.context.engine) as session:
            if accounts.blocked(session, user_name, ip):
                return False
            user = accounts.check_password(session, user_name, password, require_drive=not scope)
            if user is None:
                accounts.fail(session, user_name, ip)
                self.context.log("drive.login_failed", ip, login=user_name, protocol="webdav")
                return False
            user_id = user.id
        with self.lock:
            if len(self.cache) > 1000:
                self.cache = {k: v for k, v in self.cache.items() if v[1] > now}
            self.cache[key] = (user_id, now + CACHE_SECONDS)
        self.context.log("drive.login", ip, user=user_id, login=user_name, protocol="webdav")
        environ[USER_KEY] = user_id
        return True


def make_app(context) -> WsgiDAVApp:
    return WsgiDAVApp({
        "provider_mapping": {TEAMS_SHARE: TeamProvider(context), "/": DriveProvider(context)},
        "http_authenticator": {
            "domain_controller": DriveDomainController,
            "accept_basic": True,
            "accept_digest": False,
            "default_to_digest": False,
            "trusted_auth_header": None,
        },
        "copylee_context": context,
        "lock_storage": True,
        "property_manager": True,
        "mutable_live_props": ["{DAV:}getlastmodified"],
        "hotfixes": {"emulate_win32_lastmod": True},
        "dir_browser": {"enable": False},
        "suppress_version_info": True,
        "verbose": 1,
        "logging": {"enable": False},
    })

"""一个用户的云盘视图：把虚拟路径解析到挂载点，检查只读与配额，并记录文件操作。

Web、SFTP、WebDAV 都通过 Drive 访问文件，因此权限、配额与审计只在这里实现一次。
"""

import io
import re
import time
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import BinaryIO

from sqlalchemy import text
from sqlmodel import Session, select

from .. import audit, storage, storage_terms
from ..models import Doc, DriveMount, HostedImage, Team
from . import paths
from .backends import Backend, Entry, ImagesBackend, LocalBackend, OssBackend
from .errors import Conflict, DriveError, Forbidden, Invalid, NotFound, QuotaExceeded
from .objects import oss_store

IMAGES_PATH = "/图床"


@dataclass
class Mount:
    id: str | None  # 图床挂载点是虚拟的，没有数据库记录
    path: str
    kind: str
    read_only: bool
    quota: int
    backend: Backend


class Unavailable(Backend):
    """OSS 未配置时的占位；挂载点仍然显示，但无法读写。"""

    read_only = True

    def stat(self, rel):
        return Entry("", True) if not rel else None

    def list(self, rel):
        raise Forbidden("该存储暂不可用")

    def open_read(self, rel, offset=0):
        raise Forbidden("该存储暂不可用")

    def usage(self):
        return 0, 0


def spool_dir(settings) -> Path:
    return settings.drive_dir / ".spool"


def make_backend(settings, row: DriveMount) -> Backend:
    if row.kind == "local":
        return LocalBackend(settings.drive_dir / row.location, spool_dir(settings))
    if row.kind == "oss":
        store = oss_store(settings)
        if store is not None:
            return OssBackend(store, row.location, spool_dir(settings))
    return Unavailable(spool_dir(settings))


def ensure_root(session: Session, settings, user_id: str) -> DriveMount:
    """开通云盘时创建本地根目录挂载点；由调用方提交。"""
    row = session.exec(
        select(DriveMount).where(DriveMount.user_id == user_id, DriveMount.path == "/")
    ).first()
    if row is None:
        row = DriveMount(id=uuid.uuid4().hex, user_id=user_id, path="/", kind="local",
                         location=user_id, created_at=time.time())
        session.add(row)
    (settings.drive_dir / row.location).mkdir(parents=True, exist_ok=True)
    return row


def image_rows(session: Session, user_id: str) -> list[tuple[str, int, float]]:
    rows = session.exec(
        select(HostedImage.path, HostedImage.size, HostedImage.created_at)
        .where(HostedImage.owner == user_id)
    ).all()
    return [(path, size, datetime.fromisoformat(created).timestamp())
            for path, size, created in rows]


class Drive:
    def __init__(self, engine, settings, user_id: str, *, protocol: str = "web", ip: str = "",
                 ua: str = ""):
        self.engine = engine
        self.settings = settings
        self.user_id = user_id
        self.actor = {"protocol": protocol, "ip": ip, "ua": ua}
        with Session(engine) as session:
            plan = storage.plan(session, user_id)
            if not plan.drive_enabled:
                raise Forbidden("云盘功能尚未为你开启")
            if not storage.agreed(session, user_id):
                raise Forbidden(storage_terms.REQUIRED)
            rows = session.exec(select(DriveMount).where(DriveMount.user_id == user_id)).all()
            self.mounts = [Mount(row.id, row.path, row.kind, row.read_only, row.quota_bytes,
                                 make_backend(settings, row)) for row in rows]
            images = image_rows(session, user_id)
            if plan.images_enabled or images:
                self.mounts.append(Mount(None, IMAGES_PATH, "images", True, 0, ImagesBackend(
                    settings.images_dir, images, spool_dir(settings))))
        if not any(mount.path == "/" for mount in self.mounts):
            raise Forbidden("云盘尚未初始化，请联系管理员")
        self.mounts.sort(key=lambda mount: len(mount.path), reverse=True)

    # —— 解析 ——

    def resolve(self, path: str) -> tuple[Mount, str]:
        for mount in self.mounts:
            if paths.within(path, mount.path):
                return mount, paths.relative(path, mount.path)
        raise NotFound("路径不存在")

    def is_mount(self, path: str) -> bool:
        return any(mount.path == path for mount in self.mounts)

    def children(self, path: str) -> list[Mount]:
        return [mount for mount in self.mounts
                if mount.path != path and paths.parent(mount.path) == path]

    def writable(self, path: str) -> tuple[Mount, str]:
        mount, rel = self.resolve(path)
        if mount.read_only or mount.backend.read_only:
            raise Forbidden("该目录只读")
        return mount, rel

    def log(self, event: str, path: str, **fields):
        audit.log(f"drive.{event}", self.actor["ip"], self.actor["ua"], user=self.user_id,
                  protocol=self.actor["protocol"], path=path, **fields)

    # —— 读取 ——

    def stat(self, path: str) -> Entry:
        path = paths.clean(path)
        mount, rel = self.resolve(path)
        if self.is_mount(path) and path != "/":
            return Entry(paths.name(path), True)
        entry = mount.backend.stat(rel)
        if entry is None:
            raise NotFound("文件不存在")
        entry.name = paths.name(path)
        return entry

    def exists(self, path: str) -> bool:
        try:
            self.stat(path)
        except NotFound:
            return False
        return True

    def list(self, path: str) -> list[Entry]:
        path = paths.clean(path)
        mount, rel = self.resolve(path)
        entries = {entry.name: entry for entry in mount.backend.list(rel)}
        for child in self.children(path):
            name = paths.name(child.path)
            entries[name] = Entry(name, True)
        return sorted(entries.values(), key=lambda entry: (not entry.is_dir, entry.name.lower()))

    def open_read(self, path: str, offset: int = 0, log: bool = True) -> BinaryIO:
        path = paths.clean(path)
        mount, rel = self.resolve(path)
        handle = mount.backend.open_read(rel, offset)
        if log and not offset:
            self.log("download", path)
        return handle

    def tree_size(self, path: str) -> tuple[int, int]:
        entry = self.stat(path)
        if not entry.is_dir:
            return entry.size, 1
        size = files = 0
        for child in self.list(path):
            child_size, child_files = self.tree_size(paths.join(path, child.name))
            size, files = size + child_size, files + child_files
        return size, files

    # —— 配额 ——

    def allowance(self, mount: Mount) -> int | None:
        """该挂载点还能写入的字节数；None 表示不限。"""
        with Session(self.engine) as session:
            if mount.quota > 0:
                row = session.get(DriveMount, mount.id)
                return mount.quota - (row.used_bytes if row else 0)
            return storage.remaining(session, self.user_id)

    def reserve(self, mount: Mount, delta: int):
        if delta <= 0:
            return
        allowed = self.allowance(mount)
        if allowed is not None and delta > allowed:
            raise QuotaExceeded("存储空间不足")

    def charge(self, mount: Mount, size: int, files: int):
        if mount.id is None or (not size and not files):
            return
        with Session(self.engine) as session:
            session.exec(text(
                "UPDATE drive_mount SET used_bytes = MAX(0, used_bytes + :size), "
                "used_files = MAX(0, used_files + :files) WHERE id = :id"
            ), params={"size": size, "files": files, "id": mount.id})
            session.commit()

    # —— 写入 ——

    def write(self, path: str, source: Path) -> int:
        """把临时文件保存到 path（覆盖已有文件）；source 随后不再存在。"""
        path = paths.clean(path)
        if self.is_mount(path):
            source.unlink(missing_ok=True)
            raise Conflict("同名目录已存在")
        try:
            mount, rel = self.writable(path)
            existing = mount.backend.stat(rel)
            if existing is not None and existing.is_dir:
                raise Conflict("同名目录已存在")
            old = existing.size if existing else 0
            size = source.stat().st_size
            self.reserve(mount, size - old)
        except Exception:
            source.unlink(missing_ok=True)
            raise
        mount.backend.put(rel, source)
        self.charge(mount, size - old, 0 if existing else 1)
        self.log("upload", path, size=size)
        return size

    def upload(self, path: str, seed: bool = False) -> "Upload":
        return Upload(self, paths.clean(path), seed)

    def mkdir(self, path: str, parents: bool = False):
        path = paths.clean(path)
        if path == "/" or self.is_mount(path):
            if parents:
                return
            raise Conflict("同名目录已存在")
        if parents:
            parent = paths.parent(path)
            if not self.exists(parent):
                self.mkdir(parent, parents=True)
            elif not self.stat(parent).is_dir:
                raise Conflict("上级路径不是目录")
            if self.exists(path):
                if self.stat(path).is_dir:
                    return
                raise Conflict("同名文件已存在")
        mount, rel = self.writable(path)
        mount.backend.mkdir(rel)
        self.log("mkdir", path)

    def delete(self, path: str):
        path = paths.clean(path)
        if self.is_mount(path):
            raise Forbidden("不能删除挂载点")
        mount, rel = self.writable(path)
        size, files = mount.backend.remove(rel)
        self.charge(mount, -size, -files)
        self.log("delete", path, size=size, files=files)

    def rmdir(self, path: str):
        """只删除空目录（SFTP 语义）。"""
        if not self.stat(path).is_dir:
            raise Invalid("不是目录")
        if self.list(path):
            raise Conflict("目录不为空")
        self.delete(path)

    def set_mtime(self, path: str, mtime: float):
        path = paths.clean(path)
        mount, rel = self.writable(path)
        mount.backend.set_mtime(rel, mtime)

    def prepare_target(self, src: str, dst: str, overwrite: bool):
        if src == dst or paths.within(dst, src):
            raise Invalid("不能移动或复制到自身内部")
        if self.is_mount(src) or self.is_mount(dst):
            raise Forbidden("不能移动或覆盖挂载点")
        if not self.exists(src):
            raise NotFound("文件不存在")
        if self.exists(dst):
            if not overwrite:
                raise Conflict("目标已存在")
            self.delete(dst)
        parent = paths.parent(dst)
        if not self.exists(parent) or not self.stat(parent).is_dir:
            raise NotFound("目标目录不存在")

    def transfer(self, src: str, dst: str, target: Mount):
        """跨挂载点复制：目录逐层创建，文件经本地临时文件中转。"""
        source, rel = self.resolve(src)
        _, target_rel = self.resolve(dst)
        entry = self.stat(src)
        if entry.is_dir:
            target.backend.mkdir(target_rel)
            for child in self.list(src):
                self.transfer(paths.join(src, child.name), paths.join(dst, child.name), target)
            return
        spool = target.backend.spool()
        try:
            source.backend.fetch(rel, spool)
            target.backend.put(target_rel, spool)
        finally:
            spool.unlink(missing_ok=True)

    def copy(self, src: str, dst: str, overwrite: bool = False):
        src, dst = paths.clean(src), paths.clean(dst)
        self.prepare_target(src, dst, overwrite)
        source, rel = self.resolve(src)
        target, target_rel = self.writable(dst)
        size, files = self.tree_size(src)
        self.reserve(target, size)
        if source is target:
            size, files = target.backend.copy(rel, target_rel)
        else:
            self.transfer(src, dst, target)
        self.charge(target, size, files)
        self.log("copy", src, target=dst, size=size)

    def move(self, src: str, dst: str, overwrite: bool = False):
        src, dst = paths.clean(src), paths.clean(dst)
        self.prepare_target(src, dst, overwrite)
        source, rel = self.writable(src)
        target, target_rel = self.writable(dst)
        if source is target:
            source.backend.move(rel, target_rel)
        else:
            size, files = self.tree_size(src)
            self.reserve(target, size)
            self.transfer(src, dst, target)
            self.charge(target, size, files)
            freed, removed = source.backend.remove(rel)
            self.charge(source, -freed, -removed)
        self.log("move", src, target=dst)


class Upload:
    """流式写入：内容先写入临时文件，提交时再检查配额并放到目标位置。

    seed=True 时先复制已有内容，供 SFTP 客户端在已有文件上随机写入。
    """

    def __init__(self, drive: Drive, path: str, seed: bool):
        if drive.is_mount(path):
            raise Conflict("同名目录已存在")
        mount, rel = drive.writable(path)
        existing = mount.backend.stat(rel)
        if existing is not None and existing.is_dir:
            raise Conflict("同名目录已存在")
        parent = paths.parent(path)
        if not drive.exists(parent) or not drive.stat(parent).is_dir:
            raise NotFound("上级目录不存在")
        allowed = drive.allowance(mount)
        self.limit = None if allowed is None else allowed + (existing.size if existing else 0)
        self.drive, self.path = drive, path
        self.spool = mount.backend.spool()
        if seed and existing is not None:
            mount.backend.fetch(rel, self.spool)
        self.file = self.spool.open("r+b")
        self.size = self.spool.stat().st_size
        self.done = False

    def write(self, data: bytes, offset: int | None = None) -> int:
        if offset is not None:
            self.file.seek(offset)
        end = self.file.tell() + len(data)
        if self.limit is not None and max(end, self.size) > self.limit:
            raise QuotaExceeded("存储空间不足")
        self.file.write(data)
        self.size = max(self.size, end)
        return len(data)

    def read(self, offset: int, size: int) -> bytes:
        self.file.seek(offset)
        return self.file.read(size)

    def truncate(self, size: int):
        self.file.truncate(size)
        self.size = size

    def commit(self) -> int:
        if self.done:
            return self.size
        self.done = True
        self.file.close()
        return self.drive.write(self.path, self.spool)

    def abort(self):
        if not self.done:
            self.done = True
            self.file.close()
            self.spool.unlink(missing_ok=True)


def rescan(engine, settings, user_id: str) -> list[dict]:
    """重新统计每个挂载点的实际用量（在系统外直接改动文件后使用）。"""
    result = []
    with Session(engine) as session:
        for row in session.exec(select(DriveMount).where(DriveMount.user_id == user_id)).all():
            size, files = make_backend(settings, row).usage()
            row.used_bytes, row.used_files = size, files
            session.add(row)
            result.append({"path": row.path, "size": size, "files": files})
        session.commit()
    return result


# —— 团队空间 ——

TEAMS_DIR = ".teams"
UNSAFE_NAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def team_dir(settings, team_id: str) -> Path:
    return settings.drive_dir / TEAMS_DIR / team_id


def snapshot_name(title: str) -> str:
    """文档标题 → 可以在 Windows 上使用的文件名主体。"""
    name = UNSAFE_NAME.sub("_", title).strip(" .") or "未命名文档"
    return name[:120]


class TeamDrive(Drive):
    """团队空间：只有一个本地挂载点的 Drive，配额与用量记在 team 表。

    团队文档以只读的“标题.md”出现在所在文件夹里（内容是 Markdown 快照），不能改写、删除或移动，
    只能在网页上编辑。文件夹移动或删除时，文档跟着移动或回到根目录。
    """

    def __init__(self, engine, settings, team_id: str, user_id: str, read_only: bool, *,
                 protocol: str = "web", ip: str = "", ua: str = ""):
        # 不调用 Drive.__init__：成员访问团队空间不要求开通自己的云盘。
        self.engine = engine
        self.settings = settings
        self.user_id = user_id
        self.team_id = team_id
        self.actor = {"protocol": protocol, "ip": ip, "ua": ua}
        with Session(engine) as session:
            team = session.get(Team, team_id)
            if team is None:
                raise NotFound("团队不存在")
            quota = team.quota_bytes
        folder = team_dir(settings, team_id)
        folder.mkdir(parents=True, exist_ok=True)
        self.mounts = [Mount(team_id, "/", "team", read_only,
                             quota, LocalBackend(folder, spool_dir(settings)))]

    def log(self, event: str, path: str, **fields):
        audit.log(f"team.{event}", self.actor["ip"], self.actor["ua"], user=self.user_id,
                  team=self.team_id, protocol=self.actor["protocol"], path=path, **fields)

    # —— 配额 ——

    def allowance(self, mount: Mount) -> int | None:
        with Session(self.engine) as session:
            team = session.get(Team, self.team_id)
            return (team.quota_bytes - team.used_bytes) if team else 0

    def charge(self, mount: Mount, size: int, files: int):
        if not size and not files:
            return
        with Session(self.engine) as session:
            session.exec(text(
                "UPDATE team SET used_bytes = MAX(0, used_bytes + :size), "
                "used_files = MAX(0, used_files + :files) WHERE id = :id"
            ), params={"size": size, "files": files, "id": self.team_id})
            session.commit()

    # —— 文档快照 ——

    def docs_in(self, folder: str, real: set[str]) -> dict[str, Doc]:
        """folder 下显示的文档：文件名 → 文档。所在文件夹已不存在的文档显示在根目录。"""
        with Session(self.engine) as session:
            rows = session.exec(select(Doc).where(Doc.team_id == self.team_id)
                                .order_by(Doc.created_at)).all()
        result: dict[str, Doc] = {}
        for doc in rows:
            home = doc.folder if doc.folder == "/" or self.real_dir(doc.folder) else "/"
            if home != folder:
                continue
            base = snapshot_name(doc.title)
            name, number = f"{base}.md", 1
            if name in real:
                name = f"{base}（文档）.md"
            while name in result or name in real:
                number += 1
                name = f"{base}（文档 {number}）.md"
            result[name] = doc
        return result

    def real_dir(self, path: str) -> bool:
        try:
            mount, rel = self.resolve(paths.clean(path))
            entry = mount.backend.stat(rel)
        except DriveError:
            return False
        return entry is not None and entry.is_dir

    def real_names(self, folder: str) -> set[str]:
        mount, rel = self.resolve(folder)
        try:
            return {entry.name for entry in mount.backend.list(rel)}
        except DriveError:
            return set()

    def doc_at(self, path: str) -> Doc | None:
        path = paths.clean(path)
        if path == "/":
            return None
        folder = paths.parent(path)
        if not self.real_dir(folder):
            return None
        return self.docs_in(folder, self.real_names(folder)).get(paths.name(path))

    @staticmethod
    def doc_entry(name: str, doc: Doc) -> Entry:
        return Entry(name, False, len(doc.markdown.encode()), doc.updated_at, doc=doc.id,
                     etag=f"doc-{doc.id}-{int(doc.updated_at * 1000):x}")

    # —— 读取 ——

    def stat(self, path: str) -> Entry:
        try:
            return super().stat(path)
        except NotFound:
            doc = self.doc_at(path)
            if doc is None:
                raise
            return self.doc_entry(paths.name(paths.clean(path)), doc)

    def list(self, path: str) -> list[Entry]:
        entries = super().list(path)
        names = {entry.name for entry in entries}
        docs = [self.doc_entry(name, doc)
                for name, doc in self.docs_in(paths.clean(path), names).items()]
        return sorted(entries + docs, key=lambda entry: (not entry.is_dir, entry.name.lower()))

    def open_read(self, path: str, offset: int = 0, log: bool = True):
        doc = None
        try:
            return super().open_read(path, offset, log)
        except NotFound:
            doc = self.doc_at(path)
            if doc is None:
                raise
        return io.BytesIO(doc.markdown.encode()[offset:])

    # —— 写入 ——

    def writable(self, path: str) -> tuple[Mount, str]:
        if self.doc_at(path) is not None:
            raise Forbidden("团队文档只能在网页上编辑")
        return super().writable(path)

    def copy(self, src: str, dst: str, overwrite: bool = False):
        if self.doc_at(src) is not None:
            raise Forbidden("团队文档不能复制，请在网页上导出 Markdown")
        super().copy(src, dst, overwrite)

    def move(self, src: str, dst: str, overwrite: bool = False):
        src, dst = paths.clean(src), paths.clean(dst)
        doc = self.doc_at(src)
        if doc is not None:
            self.move_doc(doc, src, dst)
            return
        moved_dir = self.real_dir(src)
        super().move(src, dst, overwrite)
        if moved_dir:
            self.refolder(src, dst)

    def delete(self, path: str):
        path = paths.clean(path)
        removed_dir = path != "/" and self.real_dir(path)
        super().delete(path)
        if removed_dir:
            self.refolder(path, "/", flatten=True)

    def move_doc(self, doc: Doc, src: str, dst: str):
        """移动或改名文档快照：改的是文档所在的文件夹与标题，正文不变。"""
        if self.mounts[0].read_only:
            raise Forbidden("该目录只读")
        folder = paths.parent(dst)
        if folder != "/" and not self.real_dir(folder):
            raise NotFound("目标目录不存在")
        with Session(self.engine) as session:
            row = session.get(Doc, doc.id)
            row.folder = folder
            name = paths.name(dst)
            if name != paths.name(src):
                row.title = (name[:-3] if name.lower().endswith(".md") else name).strip() or row.title
            session.add(row)
            session.commit()
        self.log("move", src, target=dst, doc=doc.id)

    def refolder(self, src: str, dst: str, flatten: bool = False):
        """文件夹移动后改写其中文档的位置；flatten 时（文件夹被删除）全部回到 dst。"""
        with Session(self.engine) as session:
            rows = session.exec(select(Doc).where(Doc.team_id == self.team_id)).all()
            for doc in rows:
                if not paths.within(doc.folder, src):
                    continue
                doc.folder = dst if flatten else paths.clean(dst + doc.folder[len(src):])
                session.add(doc)
            session.commit()

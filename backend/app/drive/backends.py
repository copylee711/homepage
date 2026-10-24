from __future__ import annotations

"""存储后端：本地目录、OSS 对象前缀、图床（只读）。

后端只处理挂载点内的相对路径（不带前导 /，根为空串），不关心用户、权限和配额，
这些由 vfs 负责。所有方法都是同步的，协议层在线程里调用。
"""

import os
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from .errors import Conflict, Forbidden, Invalid, NotFound


@dataclass
class Entry:
    name: str
    is_dir: bool
    size: int = 0
    mtime: float = 0
    etag: str = ""


class Backend:
    read_only = False

    def __init__(self, spool_dir: Path):
        self.spool_dir = spool_dir

    def spool(self) -> Path:
        """新建一个空的临时文件，供上传先落盘；与本地存储位于同一文件系统。"""
        self.spool_dir.mkdir(parents=True, exist_ok=True)
        handle, name = tempfile.mkstemp(dir=self.spool_dir, prefix="spool-")
        os.close(handle)
        return Path(name)

    def stat(self, rel: str) -> Entry | None:
        raise NotImplementedError

    def list(self, rel: str) -> list[Entry]:
        raise NotImplementedError

    def open_read(self, rel: str, offset: int = 0) -> BinaryIO:
        raise NotImplementedError

    def fetch(self, rel: str, target: Path):
        """把文件完整复制到本地临时文件，用于跨挂载复制或改写已有文件。"""
        with self.open_read(rel) as source, target.open("wb") as output:
            shutil.copyfileobj(source, output, 1024 * 1024)

    def put(self, rel: str, source: Path) -> int:
        """把临时文件放到目标位置（覆盖已有文件），返回大小；source 随后不再存在。"""
        raise Forbidden("该目录只读")

    def mkdir(self, rel: str):
        raise Forbidden("该目录只读")

    def remove(self, rel: str) -> tuple[int, int]:
        """删除文件或整个目录，返回释放的字节数与文件数。"""
        raise Forbidden("该目录只读")

    def move(self, src: str, dst: str):
        raise Forbidden("该目录只读")

    def copy(self, src: str, dst: str) -> tuple[int, int]:
        raise Forbidden("该目录只读")

    def set_mtime(self, rel: str, mtime: float):
        pass

    def usage(self) -> tuple[int, int]:
        raise NotImplementedError


# —— 本地目录 ——


class LocalBackend(Backend):
    def __init__(self, root: Path, spool_dir: Path):
        super().__init__(spool_dir)
        root.mkdir(parents=True, exist_ok=True)
        self.root = root
        self.real_root = os.path.realpath(root)

    def path(self, rel: str) -> Path:
        target = self.root.joinpath(*rel.split("/")) if rel else self.root
        real = os.path.realpath(target)
        # 符号链接或其他方式指向挂载点之外时一律拒绝。
        if real != self.real_root and not real.startswith(self.real_root + os.sep):
            raise Forbidden("路径不合法")
        return target

    @staticmethod
    def entry(name: str, stat: os.stat_result, is_dir: bool) -> Entry:
        return Entry(name, is_dir, 0 if is_dir else stat.st_size, stat.st_mtime,
                     f"{stat.st_ino:x}-{stat.st_size:x}-{int(stat.st_mtime_ns):x}")

    def stat(self, rel: str) -> Entry | None:
        target = self.path(rel)
        try:
            if target.is_symlink():
                return None
            stat = target.stat()
        except (FileNotFoundError, NotADirectoryError):
            return None
        is_dir = os.path.isdir(target)
        return self.entry(target.name if rel else "", stat, is_dir)

    def list(self, rel: str) -> list[Entry]:
        target = self.path(rel)
        try:
            items = list(os.scandir(target))
        except FileNotFoundError:
            raise NotFound("目录不存在") from None
        except NotADirectoryError:
            raise Invalid("不是目录") from None
        result = []
        for item in items:
            if item.is_symlink():
                continue
            try:
                result.append(self.entry(item.name, item.stat(), item.is_dir()))
            except FileNotFoundError:
                continue
        return result

    def open_read(self, rel: str, offset: int = 0) -> BinaryIO:
        target = self.path(rel)
        if not target.is_file() or target.is_symlink():
            raise NotFound("文件不存在")
        handle = target.open("rb")
        if offset:
            handle.seek(offset)
        return handle

    def put(self, rel: str, source: Path) -> int:
        target = self.path(rel)
        if not target.parent.is_dir():
            raise NotFound("上级目录不存在")
        if target.is_dir():
            raise Conflict("同名目录已存在")
        size = source.stat().st_size
        try:
            os.replace(source, target)
        except OSError:
            # 临时目录与存储不在同一文件系统时退回复制。
            shutil.move(source, target)
        target.chmod(0o640)
        return size

    def mkdir(self, rel: str):
        target = self.path(rel)
        if target.exists():
            raise Conflict("同名文件或目录已存在")
        if not target.parent.is_dir():
            raise NotFound("上级目录不存在")
        target.mkdir()

    def remove(self, rel: str) -> tuple[int, int]:
        if not rel:
            raise Forbidden("不能删除挂载点")
        target = self.path(rel)
        if target.is_symlink() or target.is_file():
            size = target.stat().st_size if not target.is_symlink() else 0
            target.unlink()
            return size, 1
        if not target.is_dir():
            raise NotFound("文件不存在")
        size, files = self.tree_usage(target)
        shutil.rmtree(target)
        return size, files

    def move(self, src: str, dst: str):
        if not src or not dst:
            raise Forbidden("不能移动挂载点")
        source, target = self.path(src), self.path(dst)
        if not source.exists():
            raise NotFound("文件不存在")
        if target.exists():
            raise Conflict("目标已存在")
        if not target.parent.is_dir():
            raise NotFound("目标目录不存在")
        os.rename(source, target)

    def copy(self, src: str, dst: str) -> tuple[int, int]:
        source, target = self.path(src), self.path(dst)
        if target.exists():
            raise Conflict("目标已存在")
        if not target.parent.is_dir():
            raise NotFound("目标目录不存在")
        if source.is_file():
            shutil.copy2(source, target)
            return target.stat().st_size, 1
        if not source.is_dir():
            raise NotFound("文件不存在")
        shutil.copytree(source, target, symlinks=False, ignore_dangling_symlinks=True)
        return self.tree_usage(target)

    def set_mtime(self, rel: str, mtime: float):
        target = self.path(rel)
        if target.exists():
            os.utime(target, (mtime, mtime))

    @staticmethod
    def tree_usage(root: Path) -> tuple[int, int]:
        size = files = 0
        for folder, _, names in os.walk(root):
            for item in names:
                path = os.path.join(folder, item)
                if not os.path.islink(path):
                    size += os.path.getsize(path)
                    files += 1
        return size, files

    def usage(self) -> tuple[int, int]:
        return self.tree_usage(self.root)


# —— OSS ——


class OssBackend(Backend):
    """对象存储没有真正的目录：以 / 结尾的空对象表示目录，目录下有对象时也视为存在。"""

    def __init__(self, store, prefix: str, spool_dir: Path):
        super().__init__(spool_dir)
        self.store = store
        self.prefix = prefix if not prefix or prefix.endswith("/") else prefix + "/"

    def key(self, rel: str) -> str:
        return self.prefix + rel

    def folder(self, rel: str) -> str:
        return self.prefix + rel + "/" if rel else self.prefix

    def is_dir(self, rel: str) -> bool:
        if not rel:
            return True
        objects, prefixes = self.store.list(self.folder(rel), limit=1)
        return bool(objects or prefixes)

    def stat(self, rel: str) -> Entry | None:
        if not rel:
            return Entry("", True)
        head = self.store.head(self.key(rel))
        name = rel.rsplit("/", 1)[-1]
        if head is not None:
            return Entry(name, False, head.size, head.mtime, head.etag)
        return Entry(name, True) if self.is_dir(rel) else None

    def list(self, rel: str) -> list[Entry]:
        base = self.folder(rel)
        objects, prefixes = self.store.list(base)
        if rel and not objects and not prefixes:
            if self.store.head(self.key(rel)) is not None:
                raise Invalid("不是目录")
            raise NotFound("目录不存在")
        result = {}
        for item in prefixes:
            name = item[len(base):].rstrip("/")
            if name:
                result[name] = Entry(name, True)
        for item in objects:
            name = item.key[len(base):]
            if not name:
                continue  # 目录自身的标记对象
            if name.endswith("/"):
                result.setdefault(name.rstrip("/"), Entry(name.rstrip("/"), True))
            else:
                result[name] = Entry(name, False, item.size, item.mtime, item.etag)
        return list(result.values())

    def open_read(self, rel: str, offset: int = 0) -> BinaryIO:
        if self.store.head(self.key(rel)) is None:
            raise NotFound("文件不存在")
        return self.store.get(self.key(rel), offset)

    def put(self, rel: str, source: Path) -> int:
        size = source.stat().st_size
        if self.is_dir(rel):
            raise Conflict("同名目录已存在")
        try:
            self.store.put_file(self.key(rel), source)
        finally:
            source.unlink(missing_ok=True)
        return size

    def mkdir(self, rel: str):
        if self.stat(rel) is not None:
            raise Conflict("同名文件或目录已存在")
        self.store.put_bytes(self.folder(rel), b"")

    def walk(self, rel: str):
        objects, _ = self.store.list(self.folder(rel), delimiter="")
        return objects

    def remove(self, rel: str) -> tuple[int, int]:
        if not rel:
            raise Forbidden("不能删除挂载点")
        head = self.store.head(self.key(rel))
        if head is not None:
            self.store.delete([self.key(rel)])
            return head.size, 1
        objects = self.walk(rel)
        if not objects:
            raise NotFound("文件不存在")
        self.store.delete([item.key for item in objects])
        files = [item for item in objects if not item.key.endswith("/")]
        return sum(item.size for item in files), len(files)

    def copy(self, src: str, dst: str) -> tuple[int, int]:
        if self.stat(dst) is not None:
            raise Conflict("目标已存在")
        head = self.store.head(self.key(src))
        if head is not None:
            self.store.copy(self.key(src), self.key(dst), head.size, self.spool)
            return head.size, 1
        objects = self.walk(src)
        if not objects:
            raise NotFound("文件不存在")
        source, target = self.folder(src), self.folder(dst)
        size = files = 0
        for item in objects:
            self.store.copy(item.key, target + item.key[len(source):], item.size, self.spool)
            if not item.key.endswith("/"):
                size, files = size + item.size, files + 1
        return size, files

    def move(self, src: str, dst: str):
        if not src or not dst:
            raise Forbidden("不能移动挂载点")
        self.copy(src, dst)
        self.remove(src)

    def usage(self) -> tuple[int, int]:
        objects, _ = self.store.list(self.prefix, delimiter="")
        files = [item for item in objects if not item.key.endswith("/")]
        return sum(item.size for item in files), len(files)


# —— 图床（只读） ——


class ImagesBackend(Backend):
    """按 年/月/图片 展示用户在图床上传的图片；增删请在图床页面操作。"""

    read_only = True

    def __init__(self, images_dir: Path, rows, spool_dir: Path):
        super().__init__(spool_dir)
        self.images_dir = images_dir
        # rows: [(path, size, created_at_timestamp)]
        self.files = {path: (size, mtime) for path, size, mtime in rows}

    def stat(self, rel: str) -> Entry | None:
        name = rel.rsplit("/", 1)[-1]
        if rel in self.files:
            size, mtime = self.files[rel]
            return Entry(name, False, size, mtime, rel)
        if not rel or any(path.startswith(rel + "/") for path in self.files):
            return Entry(name, True)
        return None

    def list(self, rel: str) -> list[Entry]:
        entry = self.stat(rel)
        if entry is None:
            raise NotFound("目录不存在")
        if not entry.is_dir:
            raise Invalid("不是目录")
        base = rel + "/" if rel else ""
        result = {}
        for path, (size, mtime) in self.files.items():
            if not path.startswith(base):
                continue
            head, _, rest = path[len(base):].partition("/")
            result[head] = Entry(head, True) if rest else Entry(head, False, size, mtime, path)
        return list(result.values())

    def open_read(self, rel: str, offset: int = 0) -> BinaryIO:
        if rel not in self.files:
            raise NotFound("文件不存在")
        handle = (self.images_dir / rel).open("rb")
        if offset:
            handle.seek(offset)
        return handle

    def usage(self) -> tuple[int, int]:
        return sum(size for size, _ in self.files.values()), len(self.files)

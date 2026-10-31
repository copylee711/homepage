"""Runs INSIDE an unprivileged, networkless, bounded disposable container."""
import base64
import json
import os
from pathlib import Path
import selectors
import signal
import stat
import subprocess
import sys
import time

LIMIT = 1024 * 1024
MAX_WRITE = 256 * 1024
MAX_ENTRIES = 500
ROOT = Path(os.environ.get("SANDBOX_WORKSPACE", "/workspace")).resolve()


def relative_to_root(path):
    value = path.relative_to(ROOT).as_posix()
    return "" if value == "." else value


def inside(path, must_exist=True):
    """Resolve in the sandbox and refuse anything outside /workspace."""
    resolved = path.resolve(strict=must_exist)
    try:
        return resolved, relative_to_root(resolved)
    except ValueError:
        raise ValueError("路径不在工作区内") from None


def candidate(raw):
    if not isinstance(raw, str) or not raw.strip() or len(raw) > 1024 or "\x00" in raw:
        raise ValueError("工作区路径无效")
    path = Path(raw)
    return path if path.is_absolute() else ROOT / path


def list_workspace(raw):
    target, relative = inside(candidate(raw or "."))
    if not target.is_dir():
        raise ValueError("不是文件夹")
    entries, truncated = [], False
    with os.scandir(target) as scan:
        for entry in scan:
            try:
                info = entry.stat(follow_symlinks=False)
            except OSError:
                continue
            if stat.S_ISLNK(info.st_mode):
                kind = "symlink"
            elif stat.S_ISDIR(info.st_mode):
                kind = "dir"
            elif stat.S_ISREG(info.st_mode):
                kind = "file"
            else:
                kind = "other"
            try:
                path = relative_to_root(Path(entry.path))
            except ValueError:
                continue
            entries.append({"name": entry.name, "path": path, "type": kind,
                            "size": 0 if kind == "dir" else info.st_size,
                            "modified": int(info.st_mtime)})
            if len(entries) >= MAX_ENTRIES:
                truncated = True
                break
    entries.sort(key=lambda item: ({"dir": 0, "file": 1, "symlink": 2, "other": 3}[item["type"]],
                                   item["name"].casefold()))
    parent = None if target == ROOT else relative_to_root(target.parent)
    return {"path": relative, "parent": parent, "entries": entries, "truncated": truncated, "root": "/workspace"}


def read_file(raw, value):
    target, relative = inside(candidate(raw))
    if not target.is_file():
        raise ValueError("不是可读取的文件")
    limit = min(LIMIT, max(1, int(value.get("limit") or LIMIT)))
    size = target.stat().st_size
    with target.open("rb") as file:
        data = file.read(limit + 1)
    return {"data": base64.b64encode(data[:limit]).decode(), "size": size,
            "truncated": len(data) > limit or size > limit, "path": relative}


def write_file(raw, value):
    content = value.get("content")
    if not isinstance(content, str) or content.count("\x00"):
        raise ValueError("仅支持写入文本文件")
    data = content.encode("utf-8")
    if len(data) > MAX_WRITE:
        raise ValueError("文件超过 256 KiB 上限")
    path = candidate(raw)
    # The parent must exist and resolve inside /workspace; the final component is
    # opened with O_NOFOLLOW so a symlink cannot redirect the write elsewhere.
    parent, _ = inside(path.parent)
    name = path.name
    if not name or name in {".", ".."} or "/" in name or "\\" in name:
        raise ValueError("文件名无效")
    target = parent / name
    if target.is_symlink() or (target.exists() and target.is_dir()):
        raise ValueError("不能覆盖符号链接或文件夹")
    overwrite = value.get("overwrite") is True
    if target.exists() and not overwrite:
        raise FileExistsError("文件已存在，请确认覆盖")
    flags = os.O_WRONLY | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    flags |= os.O_TRUNC if overwrite else os.O_EXCL
    descriptor = os.open(target, flags, 0o644)
    with os.fdopen(descriptor, "wb") as file:
        file.write(data)
    return {"ok": True, "path": relative_to_root(target), "size": len(data)}


def bash(value):
    command = value.get("command", "")
    if not isinstance(command, str) or len(command) > 20000:
        raise ValueError("命令无效")
    proc = subprocess.Popen(["/bin/bash", "-c", command], cwd="/workspace",
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            start_new_session=True,
                            env={"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/tmp",
                                 "LANG": "C.UTF-8", "TMPDIR": "/tmp"})
    output = bytearray()
    deadline = time.monotonic() + min(60, max(1, float(value.get("timeout") or 60)))
    poll = selectors.DefaultSelector()
    poll.register(proc.stdout, selectors.EVENT_READ)
    try:
        while time.monotonic() < deadline:
            if not poll.select(.1):
                continue
            chunk = os.read(proc.stdout.fileno(), 65536)
            if not chunk:
                return {"output": output.decode(errors="replace"), "exitCode": proc.wait(timeout=2)}
            output.extend(chunk)
            if len(output) > LIMIT:
                raise ValueError("工具输出超过 1 MiB，任务已停止")
        raise ValueError("命令超过 60 秒上限，任务已停止")
    finally:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()
        poll.close()


def main(value):
    op = value.get("op")
    # Browser-visible file APIs are root-restricted inside this container.
    if op == "list":
        return list_workspace(value.get("path", ""))
    if op == "file-read":
        return read_file(value.get("path", ""), value)
    if op == "file-write":
        return write_file(value.get("path", ""), value)
    if op == "bash":
        return bash(value)
    path = Path(value.get("path", ""))
    # Pi read/write tools resolve inside the sandbox; symlinks cannot cross mounts.
    if not path.is_absolute():
        path = Path("/workspace") / path
    if op == "read":
        with path.open("rb") as file:
            data = file.read(LIMIT + 1)
        if len(data) > LIMIT:
            raise ValueError("单次读取超过 1 MiB，请用 bash 分段读取")
        return {"data": base64.b64encode(data).decode()}
    if op == "access":
        if not os.access(path, os.R_OK):
            raise ValueError("文件不可读")
    elif op == "write":
        path.write_text(value["content"], encoding="utf-8")
    elif op == "mkdir":
        path.mkdir(parents=True, exist_ok=True)
    else:
        raise ValueError("工具不支持")
    return {"ok": True}


try:
    # Explicit UTF-8 framing is independent of the host's console encoding.
    value = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    output = json.dumps(main(value), ensure_ascii=False)
    sys.stdout.buffer.write((output + "\n").encode("utf-8"))
except Exception as error:
    detail = ("文件或目录不存在" if isinstance(error, FileNotFoundError) else
              "没有权限访问此文件或目录" if isinstance(error, PermissionError) else str(error)[:500])
    message = json.dumps({"error": detail}, ensure_ascii=False)
    sys.stdout.buffer.write((message + "\n").encode("utf-8"))
    sys.exit(1)

"""Runs INSIDE an unprivileged, networkless, bounded disposable container."""
import base64
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import time

LIMIT = 1024 * 1024


def main(value):
    op = value.get("op")
    if op == "bash":
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
    path = Path(value.get("path", ""))
    # Resolve in the sandbox, never on the broker host. Symlinks cannot cross mounts.
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
    print(json.dumps(main(json.load(sys.stdin)), ensure_ascii=False))
except Exception as error:
    print(json.dumps({"error": str(error)[:500]}, ensure_ascii=False))
    sys.exit(1)

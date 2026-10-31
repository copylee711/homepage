"""Host control plane. Never mounted into a tool container; no arbitrary Docker API."""
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import threading
import time

ROOT = Path(os.environ.get("SANDBOX_ROOT", "/var/lib/copylee-sandboxes"))
SECRET = os.environ["SANDBOX_SECRET"]
IMAGE = os.environ.get("SANDBOX_IMAGE", "copylee-agent-sandbox:latest")
USER = re.compile(r"^[a-f0-9]{64}$")
leases = {}
locks = {}
guard = threading.RLock()
slots = threading.BoundedSemaphore(4)
CAPACITY = 16


class Conflict(ValueError):
    """The user must explicitly confirm before an existing file is replaced."""


def docker(*args, **kwargs):
    return subprocess.run(["docker", *args], capture_output=True, timeout=90, **kwargs)


def cancel(user):
    # Per-user mutex prevents a cancellation racing a newly issued lease.
    docker("rm", "-f", "cl-sandbox-" + user)


def workspace(user):
    """A fixed 256 MiB ext4 image per user bounds both bytes and inodes persistently."""
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    image, mount = ROOT / (user + ".img"), ROOT / user
    with guard:
        if not image.exists():
            if len(list(ROOT.glob("*.img"))) >= CAPACITY:
                raise ValueError("沙箱用户容量已满，请联系管理员")
            with image.open("xb") as file:
                file.truncate(256 * 1024 * 1024)
            image.chmod(0o600)
            subprocess.run(["mkfs.ext4", "-q", "-F", "-m", "0", str(image)], check=True, timeout=30)
        mount.mkdir(mode=0o700, exist_ok=True)
        if not os.path.ismount(mount):
            subprocess.run(["mount", "-o", "loop,nodev,nosuid", str(image), str(mount)], check=True, timeout=15)
            os.chown(mount, 1000, 1000)
            mount.chmod(0o700)
    return mount


def run_tool(user, value, lease):
    if value.get("op") not in {"read", "write", "mkdir", "access", "bash", "list", "file-read", "file-write"}:
        raise ValueError("工具不支持")
    lock = locks.setdefault(user, threading.Lock())
    browsing = value.get("op") in {"list", "file-read", "file-write"}
    # Pi may issue parallel tool calls; serialize them within the user's workspace.
    # File browsing never waits behind a long model tool and never cancels it.
    if browsing:
        if not lock.acquire(blocking=False):
            raise ValueError("工作区正在执行任务，请稍后刷新")
    elif not lock.acquire(timeout=65):
        raise ValueError("等待当前用户的工具执行超时")
    if not slots.acquire(blocking=False):
        lock.release()
        raise ValueError("沙箱繁忙，请稍后重试")
    try:
        mount = workspace(user)
        with guard:
            if leases.get(lease, {}).get("expires", 0) <= time.monotonic():
                raise ValueError("执行授权已失效")
            created = subprocess.run([
                "docker", "create", "-i", "--name", "cl-sandbox-" + user,
                "--label", "copylee.sandbox=1", "--network", "none", "--read-only",
                "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                "--memory", "256m", "--memory-swap", "256m", "--cpus", "0.5", "--pids-limit", "48",
                "--ulimit", "nofile=128:128", "--ulimit", "fsize=134217728:134217728",
                "--tmpfs", "/tmp:rw,nosuid,nodev,size=16m,mode=1777", "--shm-size", "8m",
                "--mount", f"type=bind,src={mount},dst=/workspace",
                "--env", "HOME=/tmp", "--env", "PI_CODING_AGENT_DIR=/tmp/pi",
                "--log-driver", "none", IMAGE], capture_output=True, timeout=15)
            if created.returncode:
                raise ValueError("沙箱容器创建失败")
            proc = subprocess.Popen(["docker", "start", "-ai", "cl-sandbox-" + user],
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            output, _ = proc.communicate(json.dumps(value).encode(), timeout=75)
            if len(output) > 1500000:
                raise ValueError("工具输出超限")
            result = json.loads(output)
            if "error" in result:
                if result["error"].startswith("文件已存在"):
                    raise Conflict(result["error"])
                raise ValueError(result["error"])
            return result
        except (subprocess.TimeoutExpired, json.JSONDecodeError):
            raise ValueError("沙箱工具已停止或执行超时") from None
        finally:
            cancel(user)
            proc.wait(timeout=10)
    finally:
        slots.release()
        lock.release()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Never log tokens, file data or commands.

    def do_POST(self):
        try:
            if ipaddress.ip_address(self.client_address[0]) not in ipaddress.ip_network("192.168.84.0/24"):
                return self.reply(403, {"error": "来源无效"})
            size = int(self.headers.get("Content-Length", 0))
            if not 0 < size <= 512 * 1024:
                return self.reply(413, {"error": "请求过大"})
            value = json.loads(self.rfile.read(size))
            token = self.headers.get("Authorization", "").removeprefix("Bearer ")
            if self.path == "/tool":
                with guard:
                    lease = leases.get(token)
                    if not lease or lease["expires"] <= time.monotonic():
                        return self.reply(403, {"error": "执行租约已失效"})
                    user = lease["user"]
                return self.reply(200, run_tool(user, value, token))
            if not hmac.compare_digest(token, SECRET):
                return self.reply(401, {"error": "服务认证失败"})
            user = value.get("user", "")
            if not USER.fullmatch(user):
                return self.reply(422, {"error": "用户无效"})
            with guard:
                if self.path == "/lease":
                    token = secrets.token_urlsafe(48)
                    leases[token] = {"user": user, "expires": time.monotonic() + 20}
                    return self.reply(200, {"token": token})
                if self.path == "/renew":
                    lease = leases.get(value.get("token"))
                    if not lease or lease["user"] != user or lease["expires"] <= time.monotonic():
                        return self.reply(403, {"error": "租约已失效"})
                    lease["expires"] = time.monotonic() + 20
                    return self.reply(200, {"ok": True})
                if self.path == "/cancel":
                    for key, lease in list(leases.items()):
                        if lease["user"] == user:
                            del leases[key]
                    cancel(user)
                    return self.reply(200, {"ok": True})
            return self.reply(404, {"error": "接口不存在"})
        except Conflict as error:
            self.reply(409, {"error": str(error)[:500]})
        except ValueError as error:
            self.reply(400, {"error": str(error)[:500]})
        except Exception:
            self.reply(503, {"error": "沙箱服务不可用"})

    def reply(self, status, value):
        data = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass


def sweep():
    while True:
        time.sleep(1)
        with guard:
            expired = {lease["user"] for lease in leases.values() if lease["expires"] <= time.monotonic()}
            for key, lease in list(leases.items()):
                if lease["expires"] <= time.monotonic():
                    del leases[key]
            for user in expired:
                if not any(lease["user"] == user for lease in leases.values()):
                    cancel(user)


if __name__ == "__main__":
    # Fail closed across control-plane restarts; kill only our labelled tool containers.
    old = docker("ps", "-aq", "--filter", "label=copylee.sandbox=1").stdout.decode().split()
    if old:
        docker("rm", "-f", *old)
    threading.Thread(target=sweep, daemon=True).start()
    ThreadingHTTPServer(("192.168.84.1", 18082), Handler).serve_forever()

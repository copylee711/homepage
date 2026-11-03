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
import importlib.util

policy_spec = importlib.util.spec_from_file_location("project_policy", Path(__file__).with_name("project-policy.py"))
project_policy = importlib.util.module_from_spec(policy_spec)
policy_spec.loader.exec_module(project_policy)

web_spec = importlib.util.spec_from_file_location("web_access", Path(__file__).with_name("web-access.py"))
web_access = importlib.util.module_from_spec(web_spec)
web_spec.loader.exec_module(web_access)
search_spec = importlib.util.spec_from_file_location("web_search", Path(__file__).with_name("web-search.py"))
web_search = importlib.util.module_from_spec(search_spec); search_spec.loader.exec_module(web_search)
package_spec = importlib.util.spec_from_file_location("package_reader", Path(__file__).with_name("package-reader.py"))
package_reader = importlib.util.module_from_spec(package_spec)
package_spec.loader.exec_module(package_reader)
quota_spec = importlib.util.spec_from_file_location("sandbox_quotas", Path(__file__).with_name("sandbox-quotas.py"))
quota_module = importlib.util.module_from_spec(quota_spec); quota_spec.loader.exec_module(quota_module)
background_spec = importlib.util.spec_from_file_location('background_tasks', Path(__file__).with_name('background-tasks.py'))
background_module = importlib.util.module_from_spec(background_spec); background_spec.loader.exec_module(background_module)
web_slots = threading.BoundedSemaphore(4)

ROOT = Path(os.environ.get("SANDBOX_ROOT", "/var/lib/copylee-sandboxes"))
SECRET = os.environ["SANDBOX_SECRET"]
IMAGE = os.environ.get("SANDBOX_IMAGE", "copylee-agent-sandbox:latest")
NETWORK = os.environ.get("SANDBOX_NETWORK", "none")
if NETWORK not in {"none", "copylee-agent-tools"}:
    raise RuntimeError("Unsupported tool network")
if NETWORK != "none":
    subprocess.run(["iptables", "-C", "INPUT", "-s", "192.168.85.0/24", "-j", "DROP"], check=True)
    subprocess.run(["iptables", "-C", "DOCKER-USER", "-s", "192.168.85.0/24", "-j", "COPYLEE-TOOLS"], check=True)
    network_info = json.loads(subprocess.check_output(["docker", "network", "inspect", NETWORK]))[0]
    if not network_info.get("Internal"):
        raise RuntimeError("Tool network must be internal")
USER = re.compile(r"^[a-f0-9]{64}$")
leases = {}
locks = {}
guard = threading.RLock()
slots = threading.BoundedSemaphore(4)
CAPACITY = 16
quotas = quota_module.Quotas(ROOT)
active_memory = {}


class Conflict(ValueError):
    """The user must explicitly confirm before an existing file is replaced."""


def docker(*args, **kwargs):
    return subprocess.run(["docker", *args], capture_output=True, timeout=90, **kwargs)


def cancel(user):
    # Per-user mutex prevents a cancellation racing a newly issued lease.
    docker("rm", "-f", "cl-sandbox-" + user)


def workspace(user):
    """A quota-sized ext4 image per user bounds both bytes and inodes persistently."""
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    image, mount = ROOT / (user + ".img"), ROOT / user
    with guard:
        if not image.exists():
            if len(list(ROOT.glob("*.img"))) >= CAPACITY:
                raise ValueError("沙箱用户容量已满，请联系管理员")
            with image.open("xb") as file:
                file.truncate(int(quotas.get(user)['disk_mib']) * 1024 * 1024)
            image.chmod(0o600)
            subprocess.run(["mkfs.ext4", "-q", "-F", "-m", "0", str(image)], check=True, timeout=30)
        mount.mkdir(mode=0o700, exist_ok=True)
        if not os.path.ismount(mount):
            subprocess.run(["mount", "-o", "loop,nodev,nosuid", str(image), str(mount)], check=True, timeout=15)
            os.chown(mount, 1000, 1000)
            mount.chmod(0o700)
    return mount


def run_tool(user, value, lease):
    if value.get('op') == 'quota-info': return quotas.status(user)
    if value.get('op', '').startswith('background-'):
        with guard:
            if value['op'] == 'background-start': return backgrounds.start(user, value, leases[lease].get('policy'))
            if value['op'] == 'background-status': return backgrounds.logs(user, value['id']) if value.get('id') else backgrounds.list(user)
            if value['op'] == 'background-stop': return backgrounds.stop(user, value.get('id'))
            raise ValueError('后台操作无效')
    if value.get("op") in {"web-fetch", "web-search", "mcp-request", "image-fetch"}:
        if not web_slots.acquire(blocking=False):
            raise ValueError("联网请求繁忙，请稍后重试")
        try:
            if value.get('op') == 'image-fetch': return web_access.fetch_public(value.get('url'),image=True,use_proxy=value.get('useProxy',True))
            if value.get('op') == 'mcp-request': return web_search.mcp_request(value, web_access.fetch_public)
            if value.get('op') == 'web-search': return web_search.search_public(value, web_access.fetch_public)
            return web_access.fetch_resilient(value.get("url"))
        finally:
            web_slots.release()
    if value.get("op") not in {"read", "write", "mkdir", "access", "bash", "list", "search-files", "file-read", "file-write", "file-manage", "toolchain-list", "toolchain-change"}:
        raise ValueError("工具不支持")
    lock = locks.setdefault(user, threading.Lock())
    browsing = value.get("op") in {"list", "file-read", "file-write", "file-manage", "toolchain-list", "toolchain-change"}
    # Pi may issue parallel tool calls; serialize them within the user's workspace.
    # File browsing never waits behind a long model tool and never cancels it.
    if browsing:
        if not lock.acquire(blocking=False):
            raise ValueError("工作区正在执行任务，请稍后刷新")
    elif not lock.acquire(timeout=185):
        raise ValueError("等待当前用户的工具执行超时")
    if not slots.acquire(blocking=False):
        lock.release()
        raise ValueError("沙箱繁忙，请稍后重试")
    try:
        mount = workspace(user)
        with guard:
            if leases.get(lease, {}).get("expires", 0) <= time.monotonic():
                raise ValueError("执行授权已失效")
            quota = quotas.get(user)
            if sum(active_memory.values()) + backgrounds.memory_used() + quota['memory_mib'] > int(os.environ.get('SANDBOX_ACTIVE_MEMORY_MIB', '4096')):
                raise ValueError("沙箱运行内存预算已满，请等待其他任务结束")
            active_memory[user] = quota['memory_mib']
            value = {**value, '_timeout_limit': quota['timeout']}
            created = subprocess.run([
                "docker", "create", "-i", "--name", "cl-sandbox-" + user,
                "--label", "copylee.sandbox=1", "--network", NETWORK, "--read-only",
                "--sysctl", "net.ipv6.conf.all.disable_ipv6=1",
                "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                "--memory", str(quota['memory_mib']) + 'm', "--memory-swap", str(quota['memory_mib']) + 'm', "--cpus", str(quota['cpus']), "--pids-limit", str(quota['pids']),
                "--ulimit", "nofile=256:256", "--ulimit", f"fsize={quota['disk_mib'] * 1048576}:{quota['disk_mib'] * 1048576}",
                "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m,mode=1777", "--shm-size", "8m",
                *project_policy.mount_arguments(mount, leases[lease].get("policy")),
                "--env", "HOME=/tmp", "--env", "PI_CODING_AGENT_DIR=/tmp/pi",
                "--env", "HTTP_PROXY=http://192.168.85.2:3128", "--env", "HTTPS_PROXY=http://192.168.85.2:3128",
                "--log-driver", "none", IMAGE], capture_output=True, timeout=15)
            if created.returncode:
                raise ValueError("沙箱容器创建失败")
            proc = subprocess.Popen(["docker", "start", "-ai", "cl-sandbox-" + user],
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            output, _ = proc.communicate(json.dumps(value).encode(), timeout=quota['timeout'] + 15)
            if len(output) > (21 * 1024 * 1024 if value.get('op') == 'file-read' else 1500000):
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
        with guard: active_memory.pop(user, None)
        slots.release()
        lock.release()


backgrounds = background_module.BackgroundTasks(workspace, quotas, project_policy, IMAGE, NETWORK, active_memory)

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Never log tokens, file data or commands.

    def do_POST(self):
        try:
            if ipaddress.ip_address(self.client_address[0]) not in ipaddress.ip_network("192.168.84.0/24"):
                return self.reply(403, {"error": "来源无效"})
            size = int(self.headers.get("Content-Length", 0))
            if not 0 < size <= 21 * 1024 * 1024:
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
            if self.path == '/background/preview':
                return self.reply(200, backgrounds.preview(value.get('token'), value.get('path', '/')))
            if self.path == "/package":
                if not web_slots.acquire(blocking=False):
                    raise ValueError("包下载繁忙")
                try:
                    return self.reply(200, package_reader.read_package(value))
                finally:
                    web_slots.release()
            user = value.get("user", "")
            if not USER.fullmatch(user):
                return self.reply(422, {"error": "用户无效"})
            if self.path == '/background/stop-user':
                backgrounds.stop_user(user); return self.reply(200, {'ok': True})
            if self.path in {"/quota/get", "/quota/set"}:
                if self.path.endswith('/set') and any(t['state'] == 'running' for t in backgrounds.list(user)['tasks']): return self.reply(409, {'error': '请先停止该用户的后台任务'})
                user_lock = locks.setdefault(user, threading.Lock())
                if not user_lock.acquire(blocking=False):
                    return self.reply(409, {"error": "该用户正在运行工具，请先等待任务结束"})
                try:
                    return self.reply(200, quotas.save(user, value.get('quota', {})) if self.path.endswith('/set') else quotas.status(user))
                finally:
                    user_lock.release()
            with guard:
                if self.path == "/lease":
                    token = secrets.token_urlsafe(48)
                    leases[token] = {"user": user, "expires": time.monotonic() + 20,
                                     "policy": project_policy.policy(value.get("policy"))}
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
            backgrounds.sweep()
            expired = {lease["user"] for lease in leases.values() if lease["expires"] <= time.monotonic()}
            for key, lease in list(leases.items()):
                if lease["expires"] <= time.monotonic():
                    del leases[key]
            for user in expired:
                if not any(lease["user"] == user for lease in leases.values()):
                    cancel(user)


if __name__ == "__main__":
    # Fail closed across control-plane restarts; kill only our labelled tool containers.
    old = docker("ps", "-aq", "--filter", "label=copylee.sandbox=1").stdout.decode().split() + docker('ps', '-aq', '--filter', 'label=copylee.background=1').stdout.decode().split()
    if old:
        docker("rm", "-f", *old)
    threading.Thread(target=sweep, daemon=True).start()
    ThreadingHTTPServer(("192.168.84.1", 18082), Handler).serve_forever()

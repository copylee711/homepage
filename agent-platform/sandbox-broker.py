"""Host control plane. Never mounted into a tool container; no arbitrary Docker API."""
import base64
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import stat
import struct
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
            if value['op'] == 'background-start': return backgrounds.start(user, value, leases[lease].get('policy'), leases[lease].get('thread'))
            if value['op'] == 'background-status': return backgrounds.logs(user, value['id']) if value.get('id') else backgrounds.list(user)
            if value['op'] == 'background-stop': return backgrounds.stop(user, value.get('id'))
            if value['op'] == 'background-clear-history':
                task_id = value.get('id')
                if isinstance(task_id, str) and task_id and value.get('all') is not True:
                    return backgrounds.clear_history(user, task_id)
                if task_id is None and value.get('all') is True:
                    return backgrounds.clear_history(user)
                raise ValueError('请选择后台任务或明确清空历史')
            raise ValueError('后台操作无效')
    if value.get("op") in {"web-fetch", "web-search", "mcp-request", "image-fetch"}:
        if not web_slots.acquire(blocking=False):
            raise ValueError("联网请求繁忙，请稍后重试")
        try:
            if value.get('op') == 'image-fetch': return web_access.fetch_public(value.get('url'),image=True,use_proxy=value.get('useProxy',True))
            if value.get('op') == 'mcp-request': return web_search.mcp_request(value, web_access.fetch_public)
            if value.get('op') == 'web-search': return web_search.search_public(value, web_access.fetch_public)
            return web_access.compact_page(web_access.fetch_resilient(value.get("url")))
        finally:
            web_slots.release()
    if value.get("op") not in {"read", "write", "mkdir", "access", "bash", "list", "search-files", "file-read", "file-write", "file-manage", "toolchain-list", "toolchain-change"}:
        raise ValueError("工具不支持")
    readonly = value.get("op") in {"list", "file-read", "read", "search-files"}
    key = user + ":view" if readonly else user
    name = ("cl-sandbox-view-" if readonly else "cl-sandbox-") + user
    lock = locks.setdefault(key, threading.Lock())
    browsing = value.get("op") in {"list", "file-read", "file-write", "file-manage", "toolchain-list", "toolchain-change"}
    # Pi may issue parallel tool calls; serialize them within the user's workspace.
    # Read-only views use a separate container and never take the command lock.
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
            active_memory[key] = quota['memory_mib']
            value = {**value, '_timeout_limit': quota['timeout']}
            mount_args = project_policy.mount_arguments(mount, leases[lease].get("policy"))
            if readonly:
                mount_args = [arg + ",readonly" if arg.startswith("type=bind,") and ",readonly" not in arg else arg for arg in mount_args]
            created = subprocess.run([
                "docker", "create", "-i", "--name", name,
                "--label", "copylee.sandbox=1", "--network", "none" if readonly else NETWORK, "--read-only",
                "--sysctl", "net.ipv6.conf.all.disable_ipv6=1",
                "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                "--memory", str(quota['memory_mib']) + 'm', "--memory-swap", str(quota['memory_mib']) + 'm', "--cpus", str(quota['cpus']), "--pids-limit", str(quota['pids']),
                "--ulimit", "nofile=256:256", "--ulimit", f"fsize={quota['disk_mib'] * 1048576}:{quota['disk_mib'] * 1048576}",
                "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m,mode=1777", "--shm-size", "8m",
                *mount_args,
                "--env", "HOME=/tmp", "--env", "PI_CODING_AGENT_DIR=/tmp/pi",
                "--env", "HTTP_PROXY=http://192.168.85.2:3128", "--env", "HTTPS_PROXY=http://192.168.85.2:3128",
                "--log-driver", "none", IMAGE], capture_output=True, timeout=15)
            if created.returncode:
                raise ValueError("沙箱容器创建失败")
            proc = subprocess.Popen(["docker", "start", "-ai", name],
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
            docker("rm", "-f", name)
            proc.wait(timeout=10)
    finally:
        with guard: active_memory.pop(key, None)
        slots.release()
        lock.release()


class Terminal:
    """One interactive shell per user, relayed to the console over long polls.

    The container is disposable like a tool container: same mounts, quota and
    hardening, but kept alive while the user types. stdin carries framed control
    messages, stdout carries the raw pty bytes.
    """

    BUFFER_LIMIT = 1024 * 1024
    CHUNK = 256 * 1024

    def __init__(self, user, mount, policy, quota, cols, rows):
        self.user = user
        self.policy = policy
        self.name = 'cl-term-' + user
        self.lock = threading.Lock()
        self.cond = threading.Condition(self.lock)
        self.stdin_lock = threading.Lock()
        self.buffer = bytearray()
        self.base = 0
        self.closed = False
        self.error = ''
        self.last_use = time.monotonic()
        self.proc = None
        self.reader = None
        self.memory = quota['memory_mib']
        self.start(mount, quota, cols, rows)

    @property
    def cursor(self):
        return self.base + len(self.buffer)

    def start(self, mount, quota, cols, rows):
        with open(Path(__file__).with_name('sandbox-pty.py'), 'rb') as file:
            program = base64.b64encode(file.read()).decode()
        project = (self.policy or {}).get('project') or ''
        workdir = f'/workspace/{project}' if project else '/workspace'
        docker('rm', '-f', self.name)
        created = docker(
            'create', '-i', '--name', self.name, '--label', 'copylee.terminal=1',
            '--network', NETWORK, '--read-only',
            '--sysctl', 'net.ipv6.conf.all.disable_ipv6=1',
            '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
            '--memory', str(quota['memory_mib']) + 'm', '--memory-swap', str(quota['memory_mib']) + 'm',
            '--cpus', str(quota['cpus']), '--pids-limit', str(quota['pids']),
            '--ulimit', 'nofile=256:256', '--ulimit', f"fsize={quota['disk_mib'] * 1048576}:{quota['disk_mib'] * 1048576}",
            '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777', '--shm-size', '8m',
            *project_policy.mount_arguments(mount, self.policy),
            '--workdir', workdir,
            '--env', 'HOME=/tmp', '--env', 'TERM=xterm-256color', '--env', 'COLORTERM=truecolor',
            '--env', 'PI_CODING_AGENT_DIR=/tmp/pi',
            '--env', f'IRIS_PROJECT={project or "default"}', '--env', f'IRIS_PTY_PROGRAM={program}',
            '--env', 'HTTP_PROXY=http://192.168.85.2:3128', '--env', 'HTTPS_PROXY=http://192.168.85.2:3128',
            # The image entrypoint is the JSON tool worker; the terminal replaces
            # it with the PTY helper so the shell owns stdin/stdout.
            '--log-driver', 'none', '--entrypoint', 'python3', IMAGE,
            '-c', 'import base64,os;exec(base64.b64decode(os.environ["IRIS_PTY_PROGRAM"]))')
        if created.returncode:
            raise ValueError('终端容器创建失败')
        try:
            self.proc = subprocess.Popen(
                ['docker', 'start', '-ai', self.name],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except Exception:
            docker('rm', '-f', self.name)
            raise ValueError('终端容器启动失败')
        self.resize(cols, rows, initial=True)
        self.reader = threading.Thread(target=self._pump, daemon=True)
        self.reader.start()

    def _pump(self):
        stream = self.proc.stdout
        while True:
            try:
                chunk = stream.read1(65536) if hasattr(stream, 'read1') else stream.read(65536)
            except (ValueError, OSError):
                break
            if not chunk:
                break
            with self.cond:
                self.buffer.extend(chunk)
                if len(self.buffer) > self.BUFFER_LIMIT:
                    cut = len(self.buffer) - self.BUFFER_LIMIT
                    del self.buffer[:cut]
                    self.base += cut
                self.cond.notify_all()
        with self.cond:
            self.closed = True
            self.cond.notify_all()
        try:
            self.proc.wait(timeout=5)
        except Exception:
            pass

    def _frame(self, kind, payload):
        # Keystrokes and resizes arrive on different HTTP threads; one frame
        # must never interleave with another or the helper loses sync.
        with self.stdin_lock:
            self.proc.stdin.write(kind + struct.pack('>I', len(payload)) + payload)
            self.proc.stdin.flush()

    def write(self, data):
        self.last_use = time.monotonic()
        if self.closed:
            return False
        try:
            self._frame(b'i', data)
            return True
        except (BrokenPipeError, ValueError, OSError):
            self.close()
            return False

    def resize(self, cols, rows, initial=False):
        self.last_use = time.monotonic()
        cols, rows = max(20, min(int(cols or 100), 500)), max(5, min(int(rows or 30), 300))
        try:
            self._frame(b'r', f'{cols},{rows}'.encode())
        except (BrokenPipeError, ValueError, OSError):
            if not initial:
                self.close()

    def read(self, after, wait):
        with self.cond:
            deadline = time.monotonic() + max(0.0, min(wait, 20.0))
            while self.cursor <= after and not self.closed:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self.cond.wait(remaining)
            self.last_use = time.monotonic()
            start = max(0, after - self.base)
            chunk = bytes(self.buffer[start:start + self.CHUNK])
            return {'data': base64.b64encode(chunk).decode(),
                    'cursor': self.base + start + len(chunk), 'base': self.base,
                    'closed': self.closed, 'error': self.error}

    def close(self):
        with self.cond:
            if self.closed and self.proc is None:
                return
            self.closed = True
            self.cond.notify_all()
        if self.proc is not None:
            try:
                self.proc.stdin.close()
            except Exception:
                pass
            try:
                self.proc.terminate()
            except Exception:
                pass
            try:
                self.proc.wait(timeout=5)
            except Exception:
                try: self.proc.kill()
                except Exception: pass
        cancel_terminal(self.user)


terminals = {}
terminal_memory = {}
TERMINAL_IDLE = int(os.environ.get('SANDBOX_TERMINAL_IDLE_SECONDS', '1800'))


class Browser:
    """One real Chromium page per user, driven by Playwright inside a disposable
    container. Only JPEG frames and input events cross the boundary: the page
    never shares a port, a filesystem or a network namespace with the host.
    """

    def __init__(self, user, quota, width, height):
        self.user = user
        self.name = 'cl-browser-' + user
        self.lock = threading.Lock()
        self.cond = threading.Condition(self.lock)
        self.stdin_lock = threading.Lock()
        self.seq = 0
        self.frame = None
        self.closed = False
        self.error = ''
        self.last_use = time.monotonic()
        self.width, self.height = width, height
        self.proc = None
        self.reader = None
        self.ready = threading.Event()
        self.waiting = {}
        self.next_id = 0
        self.start(quota)

    def start(self, quota):
        with open(Path(__file__).with_name('browser-bridge.mjs'), 'rb') as file:
            program = base64.b64encode(file.read()).decode()
        docker('rm', '-f', self.name)
        created = docker(
            'create', '-i', '--name', self.name, '--label', 'copylee.browser=1',
            '--network', NETWORK, '--read-only',
            '--sysctl', 'net.ipv6.conf.all.disable_ipv6=1',
            '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
            '--memory', str(quota['memory_mib']) + 'm', '--memory-swap', str(quota['memory_mib']) + 'm',
            '--cpus', str(quota['cpus']), '--pids-limit', str(quota['pids']),
            '--ulimit', 'nofile=256:256', '--ulimit', f"fsize={quota['disk_mib'] * 1048576}:{quota['disk_mib'] * 1048576}",
            '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777', '--shm-size', '32m',
            '--env', 'HOME=/tmp',
            '--env', 'HTTP_PROXY=http://192.168.85.2:3128', '--env', 'HTTPS_PROXY=http://192.168.85.2:3128',
            '--env', 'IRIS_BROWSER_PROGRAM=' + program,
            '--log-driver', 'none', '--entrypoint', 'node', IMAGE,
            '-e', 'const f=require("fs");f.writeFileSync("/tmp/bridge.mjs",Buffer.from(process.env.IRIS_BROWSER_PROGRAM,"base64"));import("/tmp/bridge.mjs")')
        if created.returncode:
            raise ValueError('浏览器容器创建失败')
        try:
            self.proc = subprocess.Popen(
                ['docker', 'start', '-ai', self.name],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except Exception:
            docker('rm', '-f', self.name)
            raise ValueError('浏览器容器启动失败')
        self.reader = threading.Thread(target=self._pump, daemon=True)
        self.reader.start()
        if not self.ready.wait(50):
            with self.lock:
                message = self.error
            self.close()
            raise ValueError(message or '浏览器启动超时，请重试')

    def _pump(self):
        stream = self.proc.stdout
        while True:
            try:
                line = stream.readline()
            except (ValueError, OSError):
                break
            if not line:
                break
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            with self.cond:
                kind = event.get('type')
                if kind == 'frame':
                    self.seq = int(event.get('seq') or self.seq + 1)
                    self.frame = event
                    self.last_use = time.monotonic()
                    self.cond.notify_all()
                elif kind == 'ready':
                    self.ready.set()
                    self.cond.notify_all()
                elif kind == 'result':
                    slot = self.waiting.get(int(event.get('id') or 0))
                    if slot:
                        slot['value'] = event
                        slot['event'].set()
                elif kind == 'fatal':
                    self.error = str(event.get('error') or '')[:300]
                    self.ready.set()
        with self.cond:
            self.closed = True
            if not self.ready.is_set():
                self.ready.set()
            for slot in self.waiting.values():
                slot['event'].set()
            self.cond.notify_all()
        try:
            self.proc.wait(timeout=5)
        except Exception:
            pass

    def command(self, op, timeout=30, **payload):
        self.last_use = time.monotonic()
        if self.closed:
            raise ValueError('浏览器已关闭，请重新打开')
        with self.lock:
            self.next_id += 1
            ident = self.next_id
            slot = {'event': threading.Event(), 'value': None}
            self.waiting[ident] = slot
        message = {**payload, 'id': ident, 'op': op}
        try:
            with self.stdin_lock:
                self.proc.stdin.write((json.dumps(message, ensure_ascii=False) + '\n').encode())
                self.proc.stdin.flush()
        except (BrokenPipeError, ValueError, OSError):
            self.close()
            raise ValueError('浏览器已关闭，请重新打开') from None
        try:
            if not slot['event'].wait(timeout):
                raise ValueError('浏览器操作超时，请重试')
            value = slot['value'] or {}
            if not value.get('ok'):
                raise ValueError(str(value.get('error') or '浏览器操作失败'))
            return value.get('value') or {}
        finally:
            with self.lock:
                self.waiting.pop(ident, None)

    def read(self, after, wait):
        with self.cond:
            deadline = time.monotonic() + max(0.0, min(wait, 10.0))
            while self.seq <= after and not self.closed:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self.cond.wait(remaining)
            self.last_use = time.monotonic()
            frame = dict(self.frame) if self.frame else None
            return {'frame': frame, 'seq': self.seq, 'closed': self.closed,
                    'error': self.error, 'ready': self.ready.is_set()}

    def close(self):
        with self.cond:
            if self.proc is not None:
                try:
                    with self.stdin_lock:
                        self.proc.stdin.write(b'{"op":"close","id":0}\n')
                        self.proc.stdin.flush()
                except Exception:
                    pass
            self.closed = True
            self.cond.notify_all()
        if self.proc is not None:
            try:
                self.proc.stdin.close()
            except Exception:
                pass
            try:
                self.proc.wait(timeout=8)
            except Exception:
                try: self.proc.kill()
                except Exception: pass
        cancel_browser(self.user)


browsers = {}
browser_memory = {}
BROWSER_IDLE = int(os.environ.get('SANDBOX_BROWSER_IDLE_SECONDS', '1800'))


def cancel_browser(user):
    docker('rm', '-f', 'cl-browser-' + user)


def close_browser(user):
    with guard:
        item = browsers.pop(user, None)
        browser_memory.pop(user, None)
    if item:
        item.close()


def close_terminal(user):
    with guard:
        item = terminals.pop(user, None)
        terminal_memory.pop(user, None)
    if item:
        item.close()


def cancel_terminal(user):
    docker('rm', '-f', 'cl-term-' + user)


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
            if self.path.startswith('/pty/'):
                return self.pty(value)
            if self.path.startswith('/browser/'):
                return self.browser(value)
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
            if self.path == '/files/download':
                return self.download(user, value)
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
            if self.path == "/cancel":
                with guard:
                    for key, lease in list(leases.items()):
                        if lease["user"] == user:
                            del leases[key]
                    cancel(user)
                # Outside the broker guard: stop() takes the task lock, and start()
                # takes that lock before the guard. Install tasks only; previews stay.
                if value.get("stopInstalls") is True:
                    backgrounds.stop_installs(user)
                return self.reply(200, {"ok": True})
            with guard:
                if self.path == "/lease":
                    thread = value.get("thread")
                    token = secrets.token_urlsafe(48)
                    thread = thread if isinstance(thread, str) and re.fullmatch(r"[a-f0-9-]{36}", thread) else None
                    ttl = 300 if thread else 20
                    leases[token] = {"user": user, "expires": time.monotonic() + ttl, "ttl": ttl,
                                     "policy": project_policy.policy(value.get("policy")), "thread": thread}
                    return self.reply(200, {"token": token})
                if self.path == "/renew":
                    lease = leases.get(value.get("token"))
                    if not lease or lease["user"] != user or lease["expires"] <= time.monotonic():
                        return self.reply(403, {"error": "租约已失效"})
                    lease["expires"] = time.monotonic() + lease["ttl"]
                    return self.reply(200, {"ok": True})
            return self.reply(404, {"error": "接口不存在"})
        except Conflict as error:
            self.reply(409, {"error": str(error)[:500]})
        except ValueError as error:
            self.reply(400, {"error": str(error)[:500]})
        except Exception:
            self.reply(503, {"error": "沙箱服务不可用"})

    def download(self, user, value):
        path = value.get('path')
        if not isinstance(path, str) or len(path) > 1024 or any(c in path for c in '\x00\r\n'):
            return self.reply(422, {'error': '工作区路径无效'})
        parts = path.removeprefix('/workspace/').split('/')
        if any(part in {'', '.', '..'} for part in parts):
            return self.reply(422, {'error': '工作区路径无效'})
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        directory = os.open(workspace(user), flags)
        try:
            for part in parts[:-1]:
                child = os.open(part, flags, dir_fd=directory)
                os.close(directory)
                directory = child
            fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        except OSError:
            return self.reply(404, {'error': '文件不存在或不可下载'})
        finally:
            os.close(directory)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            os.close(fd)
            return self.reply(404, {'error': '请选择普通文件'})
        with os.fdopen(fd, 'rb') as file:
            size = info.st_size
            start, end, status = 0, size - 1, 200
            requested = value.get('range')
            if requested:
                match = re.fullmatch(r'bytes=(\d{0,20})-(\d{0,20})', str(requested))
                if match and match[1]:
                    start = int(match[1])
                    end = min(end, int(match[2])) if match[2] else end
                elif match and match[2] and int(match[2]):
                    start = max(0, size - int(match[2]))
                else:
                    start = size
                if start > end:
                    self.send_response(416)
                    self.send_header('Content-Range', f'bytes */{size}')
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                    return
                status = 206
            remaining = end - start + 1
            self.send_response(status)
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Content-Length', str(remaining))
            if status == 206:
                self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
            self.end_headers()
            file.seek(start)
            try:
                while remaining:
                    chunk = file.read(min(remaining, 256 * 1024))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def pty(self, value):
        user = value.get('user', '')
        if not USER.fullmatch(user):
            return self.reply(422, {'error': '用户无效'})
        if self.path == '/pty/open':
            close_terminal(user)
            quota = quotas.get(user)
            rules = project_policy.policy(value.get('policy'))
            with guard:
                used = sum(active_memory.values()) + backgrounds.memory_used() + sum(terminal_memory.values()) + sum(browser_memory.values())
                if used + quota['memory_mib'] > int(os.environ.get('SANDBOX_ACTIVE_MEMORY_MIB', '4096')):
                    return self.reply(409, {'error': '沙箱运行内存预算已满，请稍后重试'})
                terminal_memory[user] = quota['memory_mib']
            try:
                item = Terminal(user, workspace(user), rules, quota, value.get('cols'), value.get('rows'))
            except ValueError as error:
                with guard: terminal_memory.pop(user, None)
                return self.reply(400, {'error': str(error)})
            with guard:
                terminals[user] = item
            return self.reply(200, {'ok': True})
        with guard:
            item = terminals.get(user)
        if not item:
            return self.reply(404, {'error': '终端未打开'})
        if self.path == '/pty/write':
            if value.get('cols') and value.get('rows'):
                item.resize(value.get('cols'), value.get('rows'))
            data = value.get('data') or ''
            if len(data) > 256 * 1024:
                return self.reply(413, {'error': '输入过大'})
            ok = item.write(base64.b64decode(data)) if data else True
            return self.reply(200, {'ok': ok})
        if self.path == '/pty/stream':
            return self.pty_stream(item, int(value.get('after') or 0))
        if self.path == '/pty/read':
            return self.reply(200, item.read(int(value.get('after') or 0), float(value.get('wait') or 0)))
        if self.path == '/pty/close':
            close_terminal(user)
            return self.reply(200, {'ok': True})
        return self.reply(404, {'error': '接口不存在'})

    def browser_input(self, value):
        if not isinstance(value, dict):
            raise ValueError('浏览器输入无效')
        kind = value.get('kind')
        if kind not in {'mouse', 'click', 'dblclick', 'move', 'wheel', 'text', 'key'}:
            raise ValueError('浏览器输入类型无效')
        payload = {'kind': kind}
        if kind == 'mouse':
            action = value.get('action')
            if action not in {'down', 'up', 'move'}:
                raise ValueError('鼠标动作无效')
            payload['action'] = action
            payload['button'] = value.get('button') if value.get('button') in {'left', 'right', 'middle'} else 'left'
            payload['clickCount'] = max(1, min(int(value.get('clickCount') or 1), 3))
        if kind == 'key' and value.get('action') in {'down', 'up', 'press'}:
            payload['action'] = value.get('action')
        for key in ('x', 'y', 'dx', 'dy'):
            if value.get(key) is not None:
                payload[key] = int(value.get(key))
        if kind == 'text':
            text = value.get('text')
            if not isinstance(text, str) or len(text) > 20000:
                raise ValueError('输入内容无效')
            payload['text'] = text
        if kind == 'key':
            key = value.get('key')
            if not isinstance(key, str) or not key or len(key) > 40:
                raise ValueError('按键无效')
            payload['key'] = key
            modifiers = value.get('modifiers')
            if isinstance(modifiers, list):
                payload['modifiers'] = [m for m in modifiers if m in {'Control', 'Shift', 'Alt', 'Meta'}][:4]
        return payload

    def browser(self, value):
        user = value.get('user', '')
        if not USER.fullmatch(user):
            return self.reply(422, {'error': '用户无效'})
        if self.path == '/browser/open':
            close_browser(user)
            quota = quotas.get(user)
            width = max(320, min(int(value.get('width') or 1280), 1920))
            height = max(320, min(int(value.get('height') or 800), 1400))
            with guard:
                used = sum(active_memory.values()) + backgrounds.memory_used() + sum(terminal_memory.values()) + sum(browser_memory.values())
                if used + quota['memory_mib'] > int(os.environ.get('SANDBOX_ACTIVE_MEMORY_MIB', '4096')):
                    return self.reply(409, {'error': '沙箱运行内存预算已满，请稍后重试'})
                browser_memory[user] = quota['memory_mib']
            try:
                item = Browser(user, quota, width, height)
            except ValueError as error:
                with guard: browser_memory.pop(user, None)
                return self.reply(400, {'error': str(error)})
            with guard:
                browsers[user] = item
            url = value.get('url')
            if isinstance(url, str) and url.strip():
                try:
                    item.command('goto', 40, url=url[:4000])
                except ValueError as error:
                    return self.reply(200, {'ok': True, 'warning': str(error)[:300]})
            return self.reply(200, {'ok': True, 'width': width, 'height': height})
        with guard:
            item = browsers.get(user)
        if not item:
            return self.reply(404, {'error': '浏览器未打开'})
        if self.path in {'/browser/stream', '/browser/frame'}:
            after = max(0, int(value.get('after') or 0))
            if self.path == '/browser/stream':
                return self.browser_stream(item, after)
            wait = max(0.0, min(float(value.get('wait') or 0), 10.0))
            return self.reply(200, item.read(after, wait))
        if self.path == '/browser/input':
            events = value.get('events', [value])
            if not isinstance(events, list) or not 1 <= len(events) <= 16:
                return self.reply(422, {'error': '浏览器输入批次无效'})
            try:
                commands = [self.browser_input(event) for event in events]
                return self.reply(200, {'ok': True, 'value': item.command('inputs', 20, events=commands)})
            except (ValueError, TypeError) as error:
                return self.reply(400, {'error': str(error)})
        if self.path == '/browser/navigate':
            action = value.get('action')
            try:
                if action == 'goto':
                    url = value.get('url')
                    if not isinstance(url, str) or not url.strip() or len(url) > 4000:
                        return self.reply(422, {'error': '网址无效'})
                    return self.reply(200, {'ok': True, 'value': item.command('goto', 40, url=url)})
                if action in {'back', 'forward', 'reload'}:
                    return self.reply(200, {'ok': True, 'value': item.command(action, 30)})
                if action == 'resize':
                    width = max(320, min(int(value.get('width') or 1280), 1920))
                    height = max(320, min(int(value.get('height') or 800), 1400))
                    return self.reply(200, {'ok': True, 'value': item.command('resize', 15, width=width, height=height)})
            except ValueError as error:
                return self.reply(400, {'error': str(error)})
            return self.reply(422, {'error': '浏览器导航类型无效'})
        if self.path == '/browser/close':
            close_browser(user)
            return self.reply(200, {'ok': True})
        return self.reply(404, {'error': '接口不存在'})

    def pty_stream(self, item, after):
        # Terminal output follows the same shape as the browser: one open
        # response, pushed chunks, no per-keystroke round trip to poll.
        self.send_response(200)
        self.send_header('Content-Type', 'application/x-ndjson; charset=utf-8')
        self.send_header('Cache-Control', 'no-store, no-transform')
        self.send_header('X-Accel-Buffering', 'no')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.close_connection = True
        deadline = time.monotonic() + 120
        last_ping = time.monotonic()
        try:
            while time.monotonic() < deadline:
                payload = item.read(after, 1.0)
                cursor = int(payload.get('cursor') or 0)
                if payload.get('data'):
                    if cursor <= after:
                        cursor = after + 1
                    line = json.dumps({'type': 'data', 'data': payload['data'], 'cursor': cursor,
                                       'base': payload.get('base', 0)}, ensure_ascii=False).encode() + b'\n'
                    self.wfile.write(line)
                    self.wfile.flush()
                    after = cursor
                    last_ping = time.monotonic()
                elif cursor > after:
                    after = cursor
                if payload.get('closed'):
                    self.wfile.write(b'{"type":"closed"}\n')
                    self.wfile.flush()
                    return
                if time.monotonic() - last_ping >= 5.0:
                    last_ping = time.monotonic()
                    self.wfile.write(b'{"type":"ping"}\n')
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def browser_stream(self, item, after):
        # One long response carries every frame the page produces, the way a
        # remote-desktop viewer works. Frames are acknowledged by Chromium only
        # after they leave this socket, so the browser never outruns the client.
        self.send_response(200)
        self.send_header('Content-Type', 'application/x-ndjson; charset=utf-8')
        self.send_header('Cache-Control', 'no-store, no-transform')
        self.send_header('X-Accel-Buffering', 'no')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.close_connection = True
        deadline = time.monotonic() + 120
        last_ping = 0.0
        try:
            while time.monotonic() < deadline:
                payload = item.read(after, 1.0)
                if payload.get('closed'):
                    self.wfile.write(b'{"type":"closed"}\n')
                    self.wfile.flush()
                    return
                frame = payload.get('frame')
                if frame and int(payload.get('seq') or 0) > after:
                    after = int(payload['seq'])
                    self.wfile.write(json.dumps({'type': 'frame', 'frame': frame}, ensure_ascii=False).encode() + b'\n')
                    self.wfile.flush()
                elif time.monotonic() - last_ping >= 1.0:
                    last_ping = time.monotonic()
                    self.wfile.write(b'{"type":"ping"}\n')
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

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
            stale = [user for user, item in terminals.items()
                     if item.closed or time.monotonic() - item.last_use > TERMINAL_IDLE]
            stale_browsers = [user for user, item in browsers.items()
                              if item.closed or time.monotonic() - item.last_use > BROWSER_IDLE]
        # Removing a terminal shells out to docker; keep that off the guard so a
        # slow container teardown cannot stall every other sandbox request.
        for user in stale:
            close_terminal(user)
        for user in stale_browsers:
            close_browser(user)
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
    old = docker("ps", "-aq", "--filter", "label=copylee.sandbox=1").stdout.decode().split() + docker('ps', '-aq', '--filter', 'label=copylee.background=1').stdout.decode().split() + docker('ps', '-aq', '--filter', 'label=copylee.terminal=1').stdout.decode().split() + docker('ps', '-aq', '--filter', 'label=copylee.browser=1').stdout.decode().split()
    if old:
        docker("rm", "-f", *old)
    threading.Thread(target=sweep, daemon=True).start()
    ThreadingHTTPServer(("192.168.84.1", 18082), Handler).serve_forever()

"""用真实 Caddy 和本地上游验证回源入口；不连接生产数据库或发信。"""

import http.client
import json
import secrets
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def main():
    executable = shutil.which("caddy")
    if not executable:
        raise SystemExit("Install Caddy before running this integration check")
    requests = []

    class Upstream(BaseHTTPRequestHandler):
        def do_POST(self):
            requests.append((self.path, dict(self.headers)))
            self.send_response(204)
            self.end_headers()

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    key = secrets.token_hex(32)
    root = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="copylee-origin-test-") as folder:
        folder = Path(folder)
        guard = folder / "guard.caddy"
        guard.write_text((root / "deploy/email-code-origin.caddy.example").read_text(
            encoding="utf-8").replace("REPLACE_WITH_RANDOM_64_HEX_SECRET", key), encoding="utf-8")
        # 使用仓库中的实际主站路由，避免测试维护另一份匹配或执行顺序。
        source = (root / "deploy/Caddyfile.example").read_text(encoding="utf-8")
        begin = source.index("    @backend path ")
        end = source.index("    handle_path /media", begin)
        routes = source[begin:end].replace("/etc/caddy/email-code-origin.caddy", str(guard))
        routes = routes.replace("127.0.0.1:8000", f"127.0.0.1:{server.server_port}")
        config = folder / "Caddyfile"
        config.write_text(f"{{\n    admin off\n    auto_https off\n}}\nhttp://127.0.0.1:{port} {{\n"
                          + routes + "\n}\n", encoding="utf-8")
        with (folder / "caddy.log").open("w+") as log:
            process = subprocess.Popen([executable, "run", "--config", str(config),
                                        "--adapter", "caddyfile"], stdout=log, stderr=log)
            try:
                for _ in range(100):
                    try:
                        with socket.create_connection(("127.0.0.1", port), timeout=.1):
                            break
                    except OSError:
                        if process.poll() is not None:
                            raise AssertionError("Caddy failed to start; check config syntax")
                        time.sleep(.05)
                else:
                    raise AssertionError("Caddy start timed out")

                def call(path, headers):
                    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
                    connection.request("POST", path, body="{}", headers=headers)
                    response = connection.getresponse()
                    response.read()
                    connection.close()
                    return response.status

                checked = 0
                for path in ("/api/account/code", "/api/account/code/", "/api/account/%63ode",
                             "/api%2faccount/code", "//api/account/code", "/api/account//code",
                             "/api/account/x/../code", "/API/ACCOUNT/CODE"):
                    for headers in ({}, {"X-Copylee-Esa-Origin": "forged",
                                         "Captcha-Verify-Param": "forged",
                                         "X-Captcha-Verify-Code": "T001"}):
                        before = len(requests)
                        assert call(path, headers) == 403, path
                        assert len(requests) == before, f"Rejected request reached upstream: {path}"
                        checked += 1
                for path in ("/api/account/code/", "/api/account/%63ode", "//api/account/code"):
                    before = len(requests)
                    assert call(path, {"X-Copylee-Esa-Origin": key}) == 403, path
                    assert len(requests) == before
                    checked += 1
                # 回源身份认证与验证码解耦：正确密钥无需任何验证码票据即可转发。
                for path in ("/api/account/code", "/api/account/code?purpose=reset"):
                    assert call(path, {"X-Copylee-Esa-Origin": key}) == 204
                    checked += 1
                assert call("/api/account/config", {"X-Copylee-Esa-Origin": "forged",
                                                   "Captcha-Verify-Param": "test"}) == 204
                assert all("x-copylee-esa-origin" not in {k.lower() for k in headers}
                           and "captcha-verify-param" not in {k.lower() for k in headers}
                           for _, headers in requests)
                print(json.dumps({"passed": checked + 1, "upstreamRequests": len(requests),
                                  "providerIndependent": True, "secretsStripped": True}))
            finally:
                process.terminate()
                process.wait(timeout=5)
                server.shutdown()


if __name__ == "__main__":
    main()

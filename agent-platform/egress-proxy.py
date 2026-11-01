"""Credential-free HTTP(S) proxy on the isolated tools network only."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
from pathlib import Path
import socket
import selectors
import threading
import time
import os
import http.client

spec = importlib.util.spec_from_file_location('web_access', Path(__file__).with_name('web-access.py'))
web = importlib.util.module_from_spec(spec); spec.loader.exec_module(web)
slots = threading.BoundedSemaphore(16)
MAX_TRANSFER = 64 * 1024 * 1024

def connect(address, port):
    upstream = os.environ.get('EGRESS_UPSTREAM_PROXY', '')
    if upstream:
        host, proxy_port = upstream.rsplit(':', 1)
        tunnel = http.client.HTTPConnection(host, int(proxy_port), timeout=12)
        tunnel.set_tunnel(address, port); tunnel.connect()
        return tunnel.sock
    return socket.create_connection((address, port), timeout=12)

class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *_): pass
    def handle_one_request(self):
        self.connection.settimeout(15)
        super().handle_one_request()
    def do_CONNECT(self):
        if not slots.acquire(blocking=False): return self.error(429)
        remote = None
        try:
            if '/' in self.path or '@' in self.path or not self.path.endswith(':443'): return self.error(403)
            _, port, address = web.resolve_url('https://' + self.path)
            remote = connect(address, port)
            self.send_response(200, 'Connection Established'); self.end_headers(); self.wfile.flush()
            self.close_connection = True
            remote.setblocking(False); self.connection.setblocking(False)
            end = time.monotonic() + 120
            total = 0
            with selectors.DefaultSelector() as poll:
                poll.register(self.connection, selectors.EVENT_READ, remote)
                poll.register(remote, selectors.EVENT_READ, self.connection)
                while time.monotonic() < end and total < MAX_TRANSFER:
                    ready = poll.select(15)
                    if not ready: return
                    for key, _ in ready:
                        data = key.fileobj.recv(65536)
                        if not data: return
                        total += len(data)
                        # Bounded timeout under backpressure; no unbounded buffers.
                        destination = key.data; destination.settimeout(10); destination.sendall(data); destination.setblocking(False)
        except Exception:
            if remote is None: self.error(403)
        finally:
            if remote: remote.close()
            slots.release()
    def forward(self):
        if not slots.acquire(blocking=False): return self.error(429)
        remote = None
        try:
            url, port, address = web.resolve_url(self.path)
            if url.scheme != 'http': return self.error(403)
            if self.headers.get('Transfer-Encoding'): return self.error(411)
            length = int(self.headers.get('Content-Length', '0'))
            if length < 0 or length > 8 * 1024 * 1024: return self.error(413)
            remote = connect(address, port)
            path = url.path or '/'
            if url.query: path += '?' + url.query
            blocked = {'host', 'connection', 'proxy-connection', 'proxy-authorization', 'keep-alive', 'upgrade', 'transfer-encoding'}
            lines = [f'{self.command} {path} HTTP/1.1', 'Host: ' + url.hostname.encode('idna').decode(), 'Connection: close']
            lines.extend(f'{key}: {value}' for key, value in self.headers.items() if key.lower() not in blocked)
            remote.sendall(('\r\n'.join(lines) + '\r\n\r\n').encode('latin-1'))
            remaining = length
            while remaining:
                chunk = self.rfile.read(min(65536, remaining))
                if not chunk: raise ValueError('short body')
                remote.sendall(chunk); remaining -= len(chunk)
            self.close_connection = True
            total = 0
            while total < MAX_TRANSFER:
                data = remote.recv(65536)
                if not data: break
                total += len(data); self.wfile.write(data)
        except Exception:
            if remote is None: self.error(403)
        finally:
            if remote: remote.close()
            slots.release()
    do_GET = do_HEAD = do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = forward
    def error(self, status):
        self.close_connection = True
        self.send_response(status); self.send_header('Content-Length', '0'); self.send_header('Connection', 'close'); self.end_headers()

if __name__ == '__main__':
    ThreadingHTTPServer(('192.168.85.2', 3128), Handler).serve_forever()

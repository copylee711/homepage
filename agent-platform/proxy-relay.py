"""Relay only the private Compose subnet to the host's loopback Mihomo listener."""
import ipaddress
import select
import socket
import socketserver

NETWORK = ipaddress.ip_network("192.168.84.0/24")


class Relay(socketserver.BaseRequestHandler):
    def handle(self):
        if ipaddress.ip_address(self.client_address[0]) not in NETWORK:
            return
        with socket.create_connection(("127.0.0.1", 7890), timeout=10) as upstream:
            upstream.settimeout(60)
            self.request.settimeout(60)
            sockets = [upstream, self.request]
            while True:
                readable, _, _ = select.select(sockets, [], [], 60)
                if not readable:
                    return
                for source in readable:
                    chunk = source.recv(65536)
                    if not chunk:
                        return
                    (self.request if source is upstream else upstream).sendall(chunk)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 64

    def handle_error(self, request, client_address):
        pass  # No request details in host logs.


if __name__ == "__main__":
    with Server(("192.168.84.1", 17890), Relay) as server:
        server.serve_forever()

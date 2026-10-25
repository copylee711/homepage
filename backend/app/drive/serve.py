"""云盘协议进程：python -m app.drive.serve

同一进程里运行 SFTP（asyncio）与 WebDAV（cheroot 线程池），共用数据库与存储配置。
文件操作日志写入审计目录下的 drive.log，与网页后端的 audit.log 分开滚动。
"""

import argparse
import asyncio
import logging
import signal
import threading
from dataclasses import dataclass

from cheroot import wsgi

from .. import audit
from ..database import make_engine
from ..settings import Settings
from . import dav, sftp

logger = logging.getLogger("copylee.drive")


@dataclass
class Context:
    engine: object
    settings: Settings

    def log(self, event: str, ip: str, **fields):
        audit.log(event, ip, **fields)


def address(value: str) -> tuple[str, int]:
    host, _, port = value.rpartition(":")
    return host.strip("[]") or "0.0.0.0", int(port)


def start_dav(context: Context, listen: str) -> wsgi.Server:
    server = wsgi.Server(address(listen), dav.make_app(context), numthreads=24,
                         server_name="CopyLeeDrive", timeout=120)
    server.prepare()
    threading.Thread(target=server.serve, name="webdav", daemon=True).start()
    return server


async def main(settings: Settings, sftp_listen: str, dav_listen: str):
    context = Context(make_engine(settings), settings)
    audit.setup(settings.audit_dir, "drive.log")
    settings.drive_dir.mkdir(parents=True, exist_ok=True)
    dav_server = start_dav(context, dav_listen)
    host, port = address(sftp_listen)
    ssh_server = await sftp.start(context, host, port)
    logger.info("SFTP 监听 %s，WebDAV 监听 %s", sftp_listen, dav_listen)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for name in ("SIGTERM", "SIGINT"):
        if hasattr(signal, name):
            try:
                loop.add_signal_handler(getattr(signal, name), stop.set)
            except NotImplementedError:  # Windows 开发环境
                pass
    try:
        await stop.wait()
    finally:
        ssh_server.close()
        await ssh_server.wait_closed()
        dav_server.stop()
        context.engine.dispose()


def run():
    parser = argparse.ArgumentParser(description="Copy Lee 云盘 SFTP/WebDAV 服务")
    parser.add_argument("--sftp", help="SFTP 监听地址，默认取 COPYLEE_SFTP_LISTEN")
    parser.add_argument("--dav", help="WebDAV 监听地址，默认取 COPYLEE_DAV_LISTEN")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    logging.getLogger("asyncssh").setLevel(logging.WARNING)
    settings = Settings()
    asyncio.run(main(settings, args.sftp or settings.sftp_listen, args.dav or settings.dav_listen))


if __name__ == "__main__":
    run()

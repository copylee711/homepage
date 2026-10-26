"""第三方图床：由服务器代为上传，避免浏览器跨域限制，也不把图床令牌暴露给协作者。

配置包含上传地址、文件字段名、请求头、额外表单字段，以及从返回 JSON 中取图片地址的路径（如 data.url）。
上传前解析域名，只允许公网地址，连接时固定连到检查过的 IP（TLS 仍按域名校验证书），
防止借图床配置访问服务器所在的内网或本机，也防止解析结果在检查后被替换。
"""

import asyncio
import ipaddress
import json
import socket
from urllib.parse import urlsplit

import httpcore
import httpx
from fastapi import HTTPException

MASK = "••••"
RESPONSE_LIMIT = 1024 * 1024
TIMEOUT = 30
MIME = {"jpg": "image/jpeg", "png": "image/png", "webp": "image/webp", "gif": "image/gif"}


def mask(value: str) -> str:
    return MASK + value[-4:] if len(value) > 8 else MASK


def masked(config: dict | None) -> dict | None:
    """返回给前端的配置：请求头与表单的值只显示末尾几位，令牌不离开服务器。"""
    if not config:
        return None
    return {**config, "headers": {k: mask(v) for k, v in config.get("headers", {}).items()},
            "form": {k: mask(v) for k, v in config.get("form", {}).items()}}


def merge(new: dict, old: dict | None) -> dict:
    """保存时，仍是掩码的值沿用原来的内容，用户只需改动想改的那一项。"""
    old = old or {}
    for section in ("headers", "form"):
        previous = old.get(section, {})
        new[section] = {key: previous.get(key, "") if value.startswith(MASK) and value == mask(previous.get(key, ""))
                        else value for key, value in new.get(section, {}).items()}
    return new


def validate(config: dict):
    parts = urlsplit(config["url"])
    if parts.scheme not in {"http", "https"} or not parts.hostname:
        raise HTTPException(400, "图床上传地址必须以 http:// 或 https:// 开头")
    for key, value in [*config.get("headers", {}).items(), *config.get("form", {}).items()]:
        if not key.strip() or "\n" in key or "\r" in key or "\n" in value or "\r" in value:
            raise HTTPException(400, f"请求头或表单字段「{key}」格式不正确")


async def resolve(host: str, port: int) -> ipaddress._BaseAddress:
    try:
        infos = await asyncio.to_thread(socket.getaddrinfo, host, port, type=socket.SOCK_STREAM)
    except socket.gaierror:
        raise HTTPException(400, f"无法解析图床域名 {host}") from None
    addresses = {ipaddress.ip_address(info[4][0]) for info in infos}
    if not addresses or any(not address.is_global for address in addresses):
        raise HTTPException(400, "图床地址不能指向内网或本机")
    return sorted(addresses, key=lambda address: address.version)[0]


class PinnedBackend(httpcore.AsyncNetworkBackend):
    """所有连接都连到检查过的 IP；TLS 握手仍用 URL 里的域名，证书按域名校验。"""

    def __init__(self, address: str):
        self.address = address
        self.inner = httpcore.AnyIOBackend()

    async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        return await self.inner.connect_tcp(self.address, port, timeout=timeout,
                                            local_address=local_address, socket_options=socket_options)

    async def connect_unix_socket(self, path, timeout=None, socket_options=None):
        raise httpcore.ConnectError("不支持 Unix 套接字")

    async def sleep(self, seconds):
        await self.inner.sleep(seconds)


async def post(url: str, address: str, headers: dict, files: dict, data: dict) -> tuple[int, bytes]:
    """以 multipart 发送并读取有限长度的响应；单独成函数便于测试替换。"""
    request = httpx.Request("POST", url, headers=headers, files=files, data=data)
    body = request.read()
    timeout = {"connect": TIMEOUT, "read": TIMEOUT, "write": TIMEOUT, "pool": TIMEOUT}
    async with httpcore.AsyncConnectionPool(network_backend=PinnedBackend(address)) as pool:
        async with pool.stream("POST", url, headers=list(request.headers.raw), content=body,
                               extensions={"timeout": timeout}) as response:
            received = b""
            async for chunk in response.aiter_stream():
                received += chunk
                if len(received) > RESPONSE_LIMIT:
                    raise HTTPException(502, "图床返回的内容过大")
            return response.status, received


def pick(data, path: str):
    for part in [item for item in path.replace("[", ".").replace("]", "").split(".") if item]:
        if isinstance(data, list) and part.isdigit() and int(part) < len(data):
            data = data[int(part)]
        elif isinstance(data, dict) and part in data:
            data = data[part]
        else:
            return None
    return data


def explain(data) -> str:
    """尽量从图床的错误响应里取出可读的说明。"""
    if isinstance(data, dict):
        for key in ("message", "msg", "error", "detail", "reason"):
            value = data.get(key)
            if isinstance(value, str) and value:
                return value[:200]
            if isinstance(value, dict):
                inner = explain(value)
                if inner:
                    return inner
    return ""


async def upload(config: dict, payload: bytes, extension: str) -> str:
    validate(config)
    parts = urlsplit(config["url"])
    host = parts.hostname
    port = parts.port or (443 if parts.scheme == "https" else 80)
    address = await resolve(host, port)
    files = {config.get("field") or "file": (f"image.{extension}", payload, MIME[extension])}
    try:
        status, body = await post(config["url"], str(address), config.get("headers", {}), files,
                                  config.get("form", {}))
    except (httpx.HTTPError, httpcore.TimeoutException, httpcore.NetworkError, httpcore.ProtocolError) as exc:
        raise HTTPException(502, f"连接图床失败：{type(exc).__name__}") from None
    try:
        data = json.loads(body)
    except ValueError:
        data = None
    if status >= 400:
        raise HTTPException(502, f"图床返回错误 {status}" + (f"：{explain(data)}" if explain(data) else ""))
    path = config.get("url_path", "").strip()
    url = pick(data, path) if path else body.decode(errors="replace").strip()
    if not isinstance(url, str) or not url.startswith(("https://", "http://")) or len(url) > 2000:
        detail = explain(data)
        raise HTTPException(502, f"没有在图床的返回中找到图片地址（路径 {path or '整个响应'}）"
                                 + (f"：{detail}" if detail else ""))
    return url

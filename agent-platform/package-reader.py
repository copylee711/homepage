"""Read pinned npm text resources without installing or executing package code."""
import base64
import fnmatch
import gzip
import hashlib
import io
import json
import re
import tarfile
from urllib.request import build_opener, HTTPRedirectHandler, Request
from urllib.parse import quote, urlsplit

NAME = re.compile(r"^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$")
VERSION = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")
class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("包仓库不允许重定向")


def registry_read(url, limit):
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname != "registry.npmjs.org" or parsed.port or parsed.username:
        raise ValueError("包下载地址必须属于 npm 官方仓库")
    with build_opener(NoRedirect).open(Request(url, headers={"User-Agent": "CopyLee-Package-Reader/1.0"}), timeout=15) as response:
        if urlsplit(response.url).hostname != "registry.npmjs.org":
            raise ValueError("不允许仓库外跳转")
        data = response.read(limit + 1)
    if len(data) > limit: raise ValueError("包超过下载上限")
    return data


def selected(path, patterns, conventional):
    if patterns is None: patterns = [conventional]
    if not isinstance(patterns, list): return False
    allowed = False
    for pattern in patterns:
        if not isinstance(pattern, str): continue
        negative = pattern.startswith("!")
        pattern = pattern.lstrip("!").removeprefix("./").rstrip("/")
        matches = not pattern or path == pattern or path.startswith(pattern + "/") or fnmatch.fnmatchcase(path, pattern)
        if matches: allowed = not negative
    return allowed


def read_package(value):
    name, version = value.get("name", ""), value.get("version", "")
    if not NAME.fullmatch(name) or not VERSION.fullmatch(version):
        raise ValueError("需要有效包名和固定版本号")
    metadata = json.loads(registry_read("https://registry.npmjs.org/" + quote(name, safe="") + "/" + quote(version, safe=""), 1024 * 1024))
    dist = metadata.get("dist", {})
    archive = registry_read(dist.get("tarball", ""), 5 * 1024 * 1024)
    integrity = dist.get("integrity", "")
    actual = "sha512-" + base64.b64encode(hashlib.sha512(archive).digest()).decode()
    if actual not in integrity.split(): raise ValueError("包完整性校验失败，需要 SHA-512")
    # Bound decompressed bytes before tar parsing; never extract onto the host.
    with gzip.GzipFile(fileobj=io.BytesIO(archive)) as stream:
        expanded = stream.read(32 * 1024 * 1024 + 1)
    if len(expanded) > 32 * 1024 * 1024: raise ValueError("包解压后超过上限")
    manifest = metadata.get("pi") or {}
    resources = []
    with tarfile.open(fileobj=io.BytesIO(expanded), mode="r:") as package:
        for index, item in enumerate(package):
            if index > 2000: raise ValueError("包文件数量过多")
            path = item.name.removeprefix("package/")
            if not item.isfile() or path.startswith("/") or ".." in path.split("/") or "\\" in path: continue
            kind = ("skill" if (path == "SKILL.md" or path.endswith("/SKILL.md")) and selected(path, manifest.get("skills"), "skills") else
                    "prompt" if path.endswith(".md") and selected(path, manifest.get("prompts"), "prompts") else None)
            if not kind: continue
            if item.size > 128 * 1024 or len(resources) >= 30: raise ValueError("文本资源超过上限")
            text = package.extractfile(item).read().decode("utf-8")
            if "\x00" in text: raise ValueError("包文本无效")
            resources.append({"kind": kind, "path": path, "text": text})
    if not resources: raise ValueError("此包没有可安全加载的文本技能或提示词。JavaScript/TypeScript 扩展需独立代码审查，不能在持有服务密钥的进程直接安装。")
    return {"name": name, "version": version, "integrity": actual, "resources": resources, "extensionsDisabled": True}

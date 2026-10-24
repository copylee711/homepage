"""虚拟路径：以 / 开头、用 / 分隔、NFC 规范化，不含 . 与 .. 等可能逃逸的片段。"""

import unicodedata

from .errors import Invalid

MAX_NAME_BYTES = 255
MAX_DEPTH = 64


def check_name(name: str) -> str:
    name = unicodedata.normalize("NFC", name)
    if name in {"", ".", ".."} or "/" in name or "\\" in name:
        raise Invalid("文件名不合法")
    if any(ord(char) < 32 or ord(char) == 127 for char in name):
        raise Invalid("文件名不能包含控制字符")
    if len(name.encode()) > MAX_NAME_BYTES:
        raise Invalid("文件名过长")
    return name


def clean(path: str) -> str:
    """把客户端给出的路径规范成 /a/b；根目录为 /。"""
    if "\x00" in path:
        raise Invalid("路径不合法")
    parts = [check_name(part) for part in path.replace("\\", "/").split("/") if part]
    if len(parts) > MAX_DEPTH:
        raise Invalid("目录层级过深")
    return "/" + "/".join(parts)


def split(path: str) -> list[str]:
    return [part for part in path.split("/") if part]


def join(base: str, *names: str) -> str:
    return clean("/".join([base, *names]))


def parent(path: str) -> str:
    return "/" + "/".join(split(path)[:-1])


def name(path: str) -> str:
    parts = split(path)
    return parts[-1] if parts else ""


def within(path: str, root: str) -> bool:
    return root == "/" or path == root or path.startswith(root + "/")


def relative(path: str, root: str) -> str:
    """root 下的相对路径，不带前导 /；path 等于 root 时为空串。"""
    if root == "/":
        return path.strip("/")
    return path[len(root):].strip("/")

"""Host-owned project mount policy, bound to an execution lease, never tool input."""
import os
import re
import stat

PROJECT = re.compile(r"^[a-zA-Z0-9_\-一-龥]{1,40}$")
RESERVED = {"__proto__", "constructor", "prototype", "lost+found", "node_modules"}


def project_id(value):
    if not isinstance(value, str) or not PROJECT.fullmatch(value) or value in RESERVED:
        raise ValueError("项目空间标识无效")
    return value


def policy(value):
    if value is None:
        return None  # Trusted owner file browser / terminal, unchanged capability.
    if not isinstance(value, dict):
        raise ValueError("项目权限无效")
    primary = project_id(value.get("project"))
    scope = value.get("scope", "project_only")
    if scope not in {"project_only", "scoped", "full"}:
        raise ValueError("项目权限无效")
    extra = value.get("extraProjects", {})
    if not isinstance(extra, dict) or len(extra) > 64:
        raise ValueError("项目权限无效")
    grants = {primary: "write"}
    if scope == "scoped":
        for name, access in extra.items():
            project_id(name)
            if access not in {"read", "write"}:
                raise ValueError("项目权限无效")
            if name != primary:
                grants[name] = access
    return {"project": primary, "scope": scope, "grants": grants}


def mount_arguments(root, rules):
    if rules is None or rules["scope"] == "full":
        return ["--mount", f"type=bind,src={root},dst=/workspace"]
    args = ["--tmpfs", "/workspace:rw,nosuid,nodev,size=1m,mode=0755"]
    for name, access in rules["grants"].items():
        target = root / project_id(name)
        try:
            target.mkdir(mode=0o700)
            os.chown(target, 1000, 1000)
        except FileExistsError:
            pass
        # Never follow user-created symlinks into another project or host path.
        if not stat.S_ISDIR(target.lstat().st_mode) or target.is_symlink():
            raise ValueError("项目目录不是普通目录，请在工作区修复")
        args += ["--mount", f"type=bind,src={target},dst=/workspace/{name},bind-recursive=disabled" + (",readonly" if access == "read" else "")]
    return args

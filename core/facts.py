"""Bounded, read-only observation adapters for Core.

Facts inspect live host state. They never release holds, mutate the journal, or
inherit authority from the privileged request dispatcher.
"""

from __future__ import annotations

import datetime as dt
import os
import pathlib
import platform
import re
import shutil
import subprocess
from typing import Any


FACT_SAFE_NAME = re.compile(r"^[A-Za-z0-9_@.:+-]{1,128}$")
PATH_TEXT_LIMIT = 4096


def observation_name(item: str) -> str | None:
    if item == "kernel":
        return item
    if ":" not in item:
        return None
    kind, arg = item.split(":", 1)
    if kind in {"disk", "pkg", "path", "unit", "unit-user", "kmod"} and arg:
        if kind == "path":
            return item if arg.startswith("/") else None
        if kind in {"pkg", "unit", "unit-user", "kmod"} and not FACT_SAFE_NAME.match(arg):
            return None
        return item
    return None


def _run_timeout(command: list[str], timeout: int = 5, env=None):
    try:
        return subprocess.run(
            command, capture_output=True, text=True, timeout=timeout, check=False, env=env
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return subprocess.CompletedProcess(command, 1, "", str(exc))


def fact_kernel() -> dict[str, Any]:
    running = platform.release()
    modules = pathlib.Path("/lib/modules")
    installed = sorted(
        path.name for path in modules.iterdir()
        if path.is_dir() and not path.name.startswith(".")
    ) if modules.is_dir() else []
    newest = installed[-1] if installed else None
    default_boot = None
    if shutil.which("grubby"):
        proc = _run_timeout(["grubby", "--default-kernel"], timeout=3)
        if proc.returncode == 0 and proc.stdout.strip():
            default_boot = proc.stdout.strip()
    return {
        "running": running,
        "installed": installed[-12:],
        "newest_installed": newest,
        "default_boot": default_boot,
        "reboot_pending": bool(newest and running != newest),
    }


def fact_disk(mount: str = "/") -> dict[str, Any]:
    if not isinstance(mount, str) or not mount.startswith("/"):
        raise ValueError("disk mount must be an absolute path")
    status = os.statvfs(mount)
    used = status.f_blocks - status.f_bfree
    avail = status.f_bavail
    denom = used + avail
    return {
        "mount": mount,
        "used_percent": int(round((100.0 * used / denom) if denom else 0)),
        "used_blocks": used,
        "avail_blocks": avail,
        "frsize": status.f_frsize,
        "source": "statvfs-df",
    }


def fact_pkg(name: str) -> dict[str, Any]:
    if not FACT_SAFE_NAME.match(name):
        raise ValueError("package name is not safe")
    if shutil.which("rpm"):
        proc = _run_timeout(["rpm", "-q", "--qf", "%{NAME}-%{VERSION}-%{RELEASE}.%{ARCH}\\n", name])
        if proc.returncode == 0:
            return {"name": name, "installed": True, "nevra": proc.stdout.strip(), "source": "rpm"}
        return {"name": name, "installed": False, "nevra": None, "source": "rpm"}
    return {"name": name, "installed": None, "nevra": None, "source": None,
            "error": "no supported package query"}


def fact_unit(name: str, user: bool = False, request=None) -> dict[str, Any]:
    if not FACT_SAFE_NAME.match(name):
        raise ValueError("unit name is not safe")
    command = ["systemctl"]
    env = None
    run_user = None
    if user:
        uid = (request or {}).get("_peer_uid")
        if isinstance(uid, int) and uid >= 0:
            env = {
                "PATH": "/usr/bin:/bin",
                "XDG_RUNTIME_DIR": f"/run/user/{uid}",
                "DBUS_SESSION_BUS_ADDRESS": f"unix:path=/run/user/{uid}/bus",
            }
            run_user = uid
        command.append("--user")
    command.extend(["show", name, "-p", "LoadState", "-p", "ActiveState",
                    "-p", "SubState", "-p", "Result", "-p", "UnitFileState"])
    try:
        proc = subprocess.run(
            command, capture_output=True, text=True, timeout=5, check=False,
            env=env, user=run_user,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        proc = subprocess.CompletedProcess(command, 1, "", str(exc))
    fields = {}
    for line in (proc.stdout or "").splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            fields[key] = value
    return {
        "name": name,
        "scope": "user" if user else "system",
        "load": fields.get("LoadState"),
        "active": fields.get("ActiveState"),
        "sub": fields.get("SubState"),
        "result": fields.get("Result"),
        "enabled": fields.get("UnitFileState"),
        "failed": fields.get("ActiveState") == "failed" or fields.get("Result") == "exit-code",
        "ok": proc.returncode == 0,
    }


def fact_path(path: str) -> dict[str, Any]:
    if not isinstance(path, str) or not path.startswith("/"):
        raise ValueError("path must be absolute")
    target = pathlib.Path(path)
    if not target.exists():
        return {"path": path, "exists": False}
    info = target.stat()
    data = {
        "path": path,
        "exists": True,
        "type": ("dir" if target.is_dir() else "symlink" if target.is_symlink() else
                 "file" if target.is_file() else "other"),
        "size": info.st_size,
        "mtime": dt.datetime.fromtimestamp(info.st_mtime, dt.timezone.utc).isoformat(),
    }
    if target.is_file() and info.st_size <= PATH_TEXT_LIMIT:
        raw = target.read_bytes()
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = None
        if text is not None:
            data["text"] = text
            kv = {}
            for line in text.splitlines():
                if "=" in line and not line.lstrip().startswith("#"):
                    key, value = line.split("=", 1)
                    if key.isidentifier():
                        kv[key] = value
            if kv:
                data["kv"] = kv
    return data


def fact_kmod(name: str) -> dict[str, Any]:
    if not FACT_SAFE_NAME.match(name):
        raise ValueError("module name is not safe")
    loaded = pathlib.Path("/sys/module", name).is_dir()
    version = None
    filename = None
    if shutil.which("modinfo"):
        proc = _run_timeout(["modinfo", "-F", "version", name])
        if proc.returncode == 0 and proc.stdout.strip():
            version = proc.stdout.strip().splitlines()[0]
        loc = _run_timeout(["modinfo", "-F", "filename", name])
        if loc.returncode == 0 and loc.stdout.strip():
            filename = loc.stdout.strip().splitlines()[0]
    built_for = []
    modules = pathlib.Path("/lib/modules")
    if modules.is_dir():
        for kernel_dir in sorted(path for path in modules.iterdir() if path.is_dir())[-12:]:
            extra = kernel_dir / "extra" / name
            if extra.is_dir() and any(extra.glob("*.ko*")):
                built_for.append(kernel_dir.name)
            elif any((kernel_dir / "extra").glob(f"{name}.ko*")):
                built_for.append(kernel_dir.name)
    return {
        "name": name,
        "loaded": loaded,
        "version": version,
        "filename": filename,
        "built_for_kernels": built_for,
    }


def collect_fact(spec: str, request=None) -> dict[str, Any]:
    if spec == "kernel":
        return fact_kernel()
    if spec.startswith("disk:"):
        return fact_disk(spec.split(":", 1)[1] or "/")
    if spec == "disk":
        return fact_disk("/")
    if spec.startswith("pkg:"):
        return fact_pkg(spec.split(":", 1)[1])
    if spec.startswith("unit-user:"):
        return fact_unit(spec.split(":", 1)[1], user=True, request=request)
    if spec.startswith("unit:"):
        return fact_unit(spec.split(":", 1)[1], user=False, request=request)
    if spec.startswith("path:"):
        return fact_path(spec.split(":", 1)[1])
    if spec.startswith("kmod:"):
        return fact_kmod(spec.split(":", 1)[1])
    raise ValueError(f"unknown fact {spec}")

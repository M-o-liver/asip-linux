"""Small, data-driven support contract shared by installer checks and tests."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import os
from pathlib import Path
import platform
import shutil
import subprocess


@dataclass(frozen=True, slots=True)
class Distro:
    family: str
    display_name: str
    package_manager: str
    packages: tuple[str, ...]
    supported: bool = True


DISTROS = {
    "fedora": Distro("fedora", "Fedora", "dnf", (
        "audit", "polkit", "python3-pip",
    )),
    "ubuntu": Distro("debian", "Ubuntu", "apt-get", (
        "auditd", "policykit-1", "python3-venv",
    )),
    "debian": Distro("debian", "Debian", "apt-get", (
        "auditd", "policykit-1", "python3-venv",
    )),
    "arch": Distro("arch", "Arch Linux", "pacman", (
        "audit", "polkit", "python", "python-pip",
    )),
    "cachyos": Distro("arch", "CachyOS", "pacman", (
        "audit", "polkit", "python", "python-pip",
    )),
}


def read_os_release(path: Path = Path("/etc/os-release")) -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return values
    for line in lines:
        key, separator, value = line.partition("=")
        if separator:
            values[key.lower()] = value.strip().strip('"')
    return values


def detect(path: Path = Path("/etc/os-release")) -> Distro | None:
    release = read_os_release(path)
    distro_id = release.get("id", "").lower()
    if distro_id in DISTROS:
        return DISTROS[distro_id]
    for candidate in release.get("id_like", "").lower().split():
        if candidate in DISTROS:
            base = DISTROS[candidate]
            return Distro(base.family, release.get("pretty_name", distro_id or "Linux"),
                          base.package_manager, base.packages, False)
    return None


def system_check(path: Path = Path("/etc/os-release")) -> dict[str, object]:
    distro = detect(path)
    architecture = platform.machine().lower()
    available = shutil.disk_usage(os.environ.get("TMPDIR", "/tmp")).free
    try:
        host_python = subprocess.run(
            ["/usr/bin/python3", "-c", "import sys; print('%d%d' % sys.version_info[:2])"],
            text=True, capture_output=True, check=True, timeout=5,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        host_python = ""
    checks = {
        "architecture": architecture in {"x86_64", "amd64"},
        "distribution": bool(distro and distro.supported),
        "package_manager": bool(distro and shutil.which(distro.package_manager)),
        "python_runtime": host_python in {"312", "313", "314"},
        "systemd": Path("/run/systemd/system").is_dir() and bool(shutil.which("systemctl")),
        "graphical_session": bool(os.environ.get("WAYLAND_DISPLAY") or os.environ.get("DISPLAY")),
        "graphical_authentication": bool(shutil.which("pkexec")),
        "disk_space": available >= 1024 * 1024 * 1024,
    }
    return {
        "ready": all(checks.values()),
        "checks": checks,
        "distro": asdict(distro) if distro else None,
        "architecture": architecture,
        "free_bytes": available,
        "host_python": host_python,
        "installed_version": (Path("/usr/lib/asip/VERSION").read_text(encoding="utf-8").strip()
                              if Path("/usr/lib/asip/VERSION").is_file() else None),
    }


def main() -> int:
    import argparse
    parser = argparse.ArgumentParser()
    parser.parse_args()
    distro = detect()
    if not distro or not distro.supported:
        parser.error("this distribution is outside ASIP's supported package contract")
    print(" ".join(distro.packages))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

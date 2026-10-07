#!/usr/bin/env python3
"""Install optional user runtimes without changing the privileged daemon."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import venv

SOURCE = Path(__file__).resolve().parents[1]

def run(*argv):
    subprocess.run(argv, check=True)

def install(kind, prepare=False):
    if os.getuid() == 0:
        raise SystemExit("Install user runtimes as the operator, not root")
    data = Path(os.environ.get("XDG_DATA_HOME", str(Path.home()/".local/share"))) / "asip"
    binary = Path.home()/".local/bin"
    files = ([SOURCE/"pyproject.toml", SOURCE/"asip_mcp.py", SOURCE/"VERSION", SOURCE/"LICENSE"] + sorted((SOURCE/"core").glob("*.py"))
             if kind == "mcp" else [SOURCE/"desktop/requirements.in"])
    digest = hashlib.sha256((sys.executable + sys.version + kind).encode())
    for path in files:
        digest.update(path.name.encode()); digest.update(path.read_bytes())
    environment = data/(kind+"-envs")/digest.hexdigest()[:20]
    python = environment/"bin/python"
    ready = environment/"ASIP_READY"
    environment.parent.mkdir(parents=True, exist_ok=True)
    with (environment.parent/"install.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not ready.exists():
            if environment.exists(): shutil.rmtree(environment)
            try:
                venv.EnvBuilder(with_pip=True, system_site_packages=(kind == "desktop")).create(environment)
                if kind == "mcp":
                    # pip writes build metadata; installed source is root-owned.
                    with tempfile.TemporaryDirectory(prefix="asip-mcp-build-") as directory:
                        build = Path(directory)
                        for path in files:
                            target = build/path.relative_to(SOURCE)
                            target.parent.mkdir(parents=True, exist_ok=True)
                            shutil.copyfile(path, target)
                        run(str(python), "-m", "pip", "install", "--no-input", str(build))
                    run(str(python), "-c", "import asip_mcp; from mcp.server import MCPServer")
                else:
                    run(str(python), "-m", "pip", "install", "--no-input", "-r", str(SOURCE/"desktop/requirements.in"))
                    run(str(python), "-c", "import gi, openai_codex; gi.require_version('Gtk','4.0'); gi.require_version('WebKit','6.0')")
                ready.write_text("ready\n")
            except BaseException:
                shutil.rmtree(environment, ignore_errors=True)
                raise
        if not prepare:
            binary.mkdir(parents=True, exist_ok=True)
            if kind == "mcp":
                for name in ("asip-mcp-inspect", "asip-mcp-admin"):
                    temporary = binary/(name+".new")
                    temporary.unlink(missing_ok=True)
                    temporary.symlink_to(environment/"bin"/name)
                    temporary.replace(binary/name)
            else:
                temporary = data/"desktop-current.new"
                temporary.unlink(missing_ok=True)
                temporary.symlink_to(environment)
                temporary.replace(data/"desktop-current")
                launcher = binary/"asip-desktop"
                shutil.copyfile(SOURCE/"desktop/asip-desktop", launcher)
                launcher.chmod(0o755)
                applications = data.parent/"applications"
                applications.mkdir(parents=True, exist_ok=True)
                entry = (SOURCE/"desktop/org.asip.Desktop.desktop").read_text()
                command = str(launcher).replace("%", "%%")
                for character in ("\\", '"', "`", "$"):
                    command = command.replace(character, "\\" + character)
                command = command.replace("\\", "\\\\")
                entry = entry.replace("Exec=asip-desktop\n", 'Exec="' + command + '"\n')
                (applications/"org.asip.Desktop.desktop").write_text(entry)
                icons = data.parent/"icons/hicolor/scalable/apps"
                icons.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(SOURCE/"desktop/org.asip.Desktop.svg", icons/"org.asip.Desktop.svg")
                refresh = shutil.which("update-desktop-database")
                if refresh:
                    run(refresh, str(applications))
    print(json.dumps({"runtime": kind, "path": str(environment), "activated": not prepare}))

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=("mcp", "desktop"), default="mcp", nargs="?")
    parser.add_argument("--prepare", action="store_true", help="Build without replacing current launchers")
    args = parser.parse_args()
    install(args.kind, args.prepare)

if __name__ == "__main__": main()

"""Repository identity without crawling the computer or reading project content."""
import hashlib
import os
from pathlib import Path
import re
import subprocess
from urllib.parse import urlsplit


def git(cwd, *args):
    try:
        result = subprocess.run(["git", "-c", "core.fsmonitor=false", "-C", str(cwd), *args], capture_output=True,
                                text=True, timeout=3, env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"})
        return result.stdout.strip() if result.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


def remote_identity(remote):
    """Drop userinfo/query/fragment and unify SSH/HTTPS GitHub-style remotes."""
    remote = remote.strip()
    if re.match(r"^[^/]+@[^:]+:", remote):
        host, path = remote.split(":", 1)
        return host.split("@")[-1].lower()+"/"+path.rstrip("/").removesuffix(".git")
    parts = urlsplit(remote)
    if parts.hostname:
        return parts.hostname.lower()+parts.path.rstrip("/").removesuffix(".git")
    # A local remote is not an authority or canonical public repository identity.
    return ""


def discover(cwd):
    cwd = str(Path(cwd).expanduser().resolve())
    root = git(cwd, "rev-parse", "--show-toplevel")
    if not root:
        return None
    root = str(Path(root).resolve())
    remote = remote_identity(git(root, "remote", "get-url", "origin"))
    identity = "repo:"+remote if remote else "path:"+os.path.normcase(root)
    return {"id": "p_"+hashlib.sha256(identity.encode()).hexdigest()[:24],
            "name": remote.rsplit("/", 1)[-1] if remote else Path(root).name,
            "root": root, "repository": remote, "method": "repository" if remote else "git-root"}


def contains(root, cwd):
    try:
        Path(cwd).resolve().relative_to(Path(root).resolve())
        return True
    except ValueError:
        return False


def evidence(cwd):
    """Only HEAD and filenames; a digest of the diff is evidence, not its content."""
    root = git(cwd, "rev-parse", "--show-toplevel")
    if not root:
        return {}
    status = git(root, "status", "--porcelain=v1", "--untracked-files=normal")
    return {"head": git(root, "rev-parse", "HEAD"), "branch": git(root, "branch", "--show-current"),
            "status": status.splitlines()[:100], "status_sha256": hashlib.sha256(status.encode()).hexdigest()}

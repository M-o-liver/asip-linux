#!/usr/bin/python3
"""Narrow root entrypoint: revalidate one staged release and run ASIP's engine."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
from pathlib import PurePosixPath
import shutil
import subprocess
import sys
import tarfile
import tempfile


def verify_private_payload(artifact: Path, manifest_path: Path) -> dict:
    """Validate the root-private copy without importing staged code."""
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    required = {"artifact", "sha256", "source_commit", "version"}
    if not isinstance(manifest, dict) or manifest.get("schema_version") != 1 or not required.issubset(manifest):
        raise ValueError("release manifest is incomplete or unsupported")
    if artifact.name != manifest["artifact"]:
        raise ValueError("release manifest identifies a different payload")
    digest = hashlib.sha256()
    with artifact.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != manifest["sha256"]:
        raise ValueError("release payload digest does not match")
    expected = f"asip-{manifest['version']}"
    with tarfile.open(artifact, "r:gz") as archive:
        members = archive.getmembers()
        for member in members:
            name = PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts or not name.parts or name.parts[0] != expected:
                raise ValueError("release payload contains an unsafe path")
            if member.issym() or member.islnk():
                target = PurePosixPath(member.linkname)
                if target.is_absolute() or ".." in target.parts:
                    raise ValueError("release payload contains an unsafe link")
    names = {member.name.rstrip("/") for member in members}
    required_files = {f"{expected}/asip", f"{expected}/VERSION", f"{expected}/core/daemon.py",
                      f"{expected}/wheelhouse/SHA256SUMS"}
    if not required_files.issubset(names):
        raise ValueError("release payload is missing required installation files")
    return manifest


def fail(message: str) -> int:
    print(f"ASIP installer: {message}", file=sys.stderr)
    return 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("stage", type=Path)
    parser.add_argument("expected_sha256")
    parser.add_argument("expected_version")
    parser.add_argument("expected_source_commit")
    args = parser.parse_args()
    if os.geteuid() != 0:
        return fail("the installation helper must run as root")
    stage = args.stage.resolve()
    if not stage.is_dir() or stage.is_symlink():
        return fail("the staged release directory is invalid")
    manifest_path = stage / "release.json"
    try:
        if manifest_path.stat().st_size > 64 * 1024:
            raise ValueError("release manifest is too large")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if (manifest.get("sha256"), manifest.get("version"), manifest.get("source_commit")) != (
                args.expected_sha256, args.expected_version, args.expected_source_commit):
            raise ValueError("staged release identity changed after prevalidation")
        artifact_name = manifest.get("artifact") if isinstance(manifest, dict) else None
        if not isinstance(artifact_name, str) or Path(artifact_name).name != artifact_name:
            raise ValueError("release artifact name is invalid")
        artifact = stage / artifact_name
    except Exception as exc:
        return fail(str(exc))
    uid_text = os.environ.get("PKEXEC_UID", "")
    try:
        operator = pwd.getpwuid(int(uid_text)).pw_name
    except (KeyError, ValueError):
        return fail("the graphical operator identity is unavailable")
    # The staged directory is intentionally user-owned. Re-extract the verified
    # archive into a root-owned private directory before executing any payload
    # file, closing the verify/execute race without trusting the AppImage mount.
    private = Path(tempfile.mkdtemp(prefix="asip-install-root-", dir="/var/tmp"))
    os.chmod(private, 0o700)
    try:
        private_artifact = private / artifact.name
        private_manifest = private / "release.json"
        shutil.copyfile(artifact, private_artifact)
        shutil.copyfile(manifest_path, private_manifest)
        manifest = verify_private_payload(private_artifact, private_manifest)
        with tarfile.open(private_artifact, "r:gz") as archive:
            archive.extractall(private, filter="data")
        source = private / f"asip-{manifest['version']}"
        client = source / "asip"
        if not client.is_file() or client.is_symlink():
            return fail("the canonical installer is missing")
        installed = Path("/usr/lib/asip/VERSION")
        command = [str(client), "install", "--privileged"]
        if installed.is_file() and installed.read_text(encoding="utf-8").strip() != manifest["version"]:
            command.append("--self-upgrade")
        environment = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "ASIP_OPERATOR": operator,
                       "ASIP_SOURCE_ROOT": str(source), "LANG": "C.UTF-8"}
        return subprocess.run(command, env=environment, check=False).returncode
    finally:
        shutil.rmtree(private, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())

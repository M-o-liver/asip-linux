"""Verify and stage the immutable release before crossing privilege."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import tempfile
from typing import Any


class StageError(ValueError):
    pass


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_manifest(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise StageError(f"Release manifest is unreadable: {exc}") from exc
    required = {"artifact", "sha256", "source_commit", "version"}
    if not isinstance(value, dict) or not required.issubset(value):
        raise StageError("Release manifest is incomplete")
    if value.get("schema_version") != 1:
        raise StageError("Release manifest format is unsupported")
    return value


def verify_payload(artifact: Path, manifest_path: Path) -> dict[str, Any]:
    manifest = load_manifest(manifest_path)
    if artifact.name != manifest["artifact"]:
        raise StageError("Release manifest identifies a different payload")
    if sha256(artifact) != manifest["sha256"]:
        raise StageError("Release payload digest does not match")
    expected = f"asip-{manifest['version']}"
    try:
        with tarfile.open(artifact, "r:gz") as archive:
            members = archive.getmembers()
            for member in members:
                name = PurePosixPath(member.name)
                if name.is_absolute() or ".." in name.parts or not name.parts or name.parts[0] != expected:
                    raise StageError("Release payload contains an unsafe path")
                if member.issym() or member.islnk():
                    target = PurePosixPath(member.linkname)
                    if target.is_absolute() or ".." in target.parts:
                        raise StageError("Release payload contains an unsafe link")
    except (OSError, tarfile.TarError) as exc:
        raise StageError(f"Release payload is unreadable: {exc}") from exc
    required = {f"{expected}/asip", f"{expected}/VERSION", f"{expected}/core/daemon.py",
                f"{expected}/wheelhouse/SHA256SUMS"}
    names = {member.name.rstrip("/") for member in members}
    if not required.issubset(names):
        raise StageError("Release payload is missing required installation files")
    return manifest


def stage_payload(artifact: Path, manifest_path: Path, destination: Path | None = None) -> Path:
    manifest = verify_payload(artifact, manifest_path)
    if destination is None:
        destination = Path(tempfile.mkdtemp(prefix="asip-installer-"))
    else:
        destination.mkdir(mode=0o700, parents=True, exist_ok=False)
    os.chmod(destination, 0o700)
    staged_artifact = destination / artifact.name
    staged_manifest = destination / "release.json"
    shutil.copyfile(artifact, staged_artifact)
    shutil.copyfile(manifest_path, staged_manifest)
    verify_payload(staged_artifact, staged_manifest)
    (destination / "STAGED").write_text(
        json.dumps({"version": manifest["version"], "source_commit": manifest["source_commit"],
                    "sha256": manifest["sha256"]}) + "\n",
        encoding="utf-8",
    )
    return destination

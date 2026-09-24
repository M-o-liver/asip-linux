"""Offline-testable release metadata and artifact verification for ASIP.

The first product release deliberately has no built-in network updater. A
local JSON manifest and a local tar artifact exercise the same contract that a
future HTTPS provider can implement. Digest verification is active today;
signature fields are reserved and rejected until a maintainer-controlled
verification key and policy exist.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import sys
import tarfile
import tempfile
from dataclasses import dataclass
from typing import Any

if __package__ in (None, ""):
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from core.protocol import (
    PRIVILEGED_SOCKET,
    READ_ONLY_SOCKET,
    SCHEMA_VERSION,
    UnixClient,
    VERSION,
)


METADATA_ENV = "ASIP_RELEASE_METADATA"
SOCKET_DIR_ENV = "ASIP_RELEASE_SOCKET_DIR"
VERSION_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$")
REQUIRED_ARTIFACT_FILES = (
    "a", "asip", "asip-inspect", "core",
    "VERSION", "LICENSE", "README.md", "SECURITY.md", "CONTRIBUTING.md",
    "CHANGELOG.md", "RELEASE_NOTES.md", "SUPPORT.md", "INSTALL.md",
    "UPGRADE.md", "UNINSTALL.md", "pyproject.toml", "asip_mcp.py", "cli",
    "eval/cases", "requirements/mcp.in",
    "requirements/mcp-py312-linux-x86_64.lock",
    "requirements/mcp-py313-linux-x86_64.lock",
    "requirements/mcp-py314-linux-x86_64.lock",
    "systemd/asip.socket", "systemd/asip.service",
    "systemd/asip-read.socket", "systemd/asip-read.service",
)
PRODUCT_ARTIFACT_FILES = (
    "install.sh", "scripts/restore_install_backup.sh", "scripts/uninstall_software.sh",
    "docs/ARCHITECTURE.md",
    "installer", "packaging/appimage", "wheelhouse",
)


class ReleaseError(ValueError):
    """An actionable release discovery or verification error."""


@dataclass(frozen=True)
class ReleaseMetadata:
    version: str
    artifact: pathlib.Path
    sha256: str
    signature: str | None = None
    key_id: str | None = None
    source: pathlib.Path | None = None
    mcp_wheelhouse: bool = False

    @classmethod
    def from_dict(cls, data: dict[str, Any], source: pathlib.Path | None = None):
        if not isinstance(data, dict):
            raise ReleaseError("release metadata must be a JSON object")
        version = data.get("version")
        artifact = data.get("artifact")
        digest = data.get("sha256")
        if not isinstance(version, str) or not VERSION_RE.fullmatch(version):
            raise ReleaseError("release metadata has an invalid semantic version")
        if not isinstance(artifact, str) or not artifact:
            raise ReleaseError("release metadata must name an artifact")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", digest):
            raise ReleaseError("release metadata must contain a 64-character SHA-256 digest")
        artifact_path = pathlib.Path(artifact).expanduser()
        if not artifact_path.is_absolute() and source is not None:
            artifact_path = (source.parent / artifact_path).resolve()
        return cls(
            version=version.lstrip("v"),
            artifact=artifact_path,
            sha256=digest.lower(),
            signature=data.get("signature") if isinstance(data.get("signature"), str) else None,
            key_id=data.get("key_id") if isinstance(data.get("key_id"), str) else None,
            source=source,
            mcp_wheelhouse=data.get("mcp_wheelhouse") is True,
        )


def version_tuple(value: str) -> tuple[int, int, int]:
    match = VERSION_RE.fullmatch(value)
    if not match:
        raise ReleaseError("invalid ASIP version: %s" % value)
    return tuple(int(part) for part in match.groups())


def load_metadata(source: str | os.PathLike[str] | None = None) -> ReleaseMetadata:
    """Load local metadata; HTTPS is intentionally a future provider seam."""
    configured = str(source or os.environ.get(METADATA_ENV, "")).strip()
    if not configured:
        raise ReleaseError(
            "no release metadata configured; set %s to a local manifest while "
            "production distribution is being prepared" % METADATA_ENV
        )
    if configured.startswith(("https://", "http://")):
        raise ReleaseError(
            "network release discovery is not enabled in this build; use a "
            "local manifest or install a future HTTPS release provider"
        )
    path = pathlib.Path(configured).expanduser().resolve()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ReleaseError("release metadata was not found: %s" % path) from exc
    except json.JSONDecodeError as exc:
        raise ReleaseError("release metadata is not valid JSON: %s" % exc) from exc
    return ReleaseMetadata.from_dict(data, path)


def live_product_version() -> tuple[str | None, str]:
    """Ask a running daemon for the installed product version.

    Returns (version, source). source is live-read, live-privileged, or
    unavailable. Never falls back to this process's source-tree VERSION.
    """
    request = {
        "schema_version": SCHEMA_VERSION,
        "op": "doctor",
        "argv": [],
        "cwd": "/",
        "reason": "",
        "client": {"name": "asip-release", "version": VERSION},
        "transport": "cli",
    }
    socket_dir = os.environ.get(SOCKET_DIR_ENV, "").strip()
    if socket_dir:
        base = pathlib.Path(socket_dir).expanduser()
        sockets = (
            (str(base / "read.sock"), "live-read"),
            (str(base / "sock"), "live-privileged"),
        )
    else:
        sockets = (
            (READ_ONLY_SOCKET, "live-read"),
            (PRIVILEGED_SOCKET, "live-privileged"),
        )
    for path, source in sockets:
        try:
            response = UnixClient(path).call(request).response
        except (OSError, ConnectionError, PermissionError, ValueError):
            continue
        if not response.get("ok") and response.get("exit", 1) != 0:
            continue
        data = response.get("data")
        if not isinstance(data, dict):
            try:
                data = json.loads(response.get("stdout") or "")
            except (TypeError, ValueError, json.JSONDecodeError):
                data = {}
        version = data.get("version") if isinstance(data, dict) else None
        if isinstance(version, str) and version.strip():
            return version.strip(), source
    return None, "unavailable"


def check_status(
    source: str | os.PathLike[str] | None = None,
    *,
    client_version: str = VERSION,
    installed_version: str | None = None,
    query_live: bool = True,
) -> dict[str, Any]:
    """Return upgrade status without treating checkout VERSION as installed."""
    installed_source = "supplied"
    if installed_version is None and query_live:
        installed_version, installed_source = live_product_version()
    elif installed_version is None:
        installed_source = "unavailable"
    result: dict[str, Any] = {
        "schema_version": 1,
        "client_version": client_version,
        "installed_version": installed_version,
        "installed_source": installed_source,
        "candidate_version": None,
        "latest_version": None,
        "available": False,
        "metadata": "unavailable",
        "artifact": None,
        "sha256": None,
    }
    if installed_version and client_version and installed_version != client_version:
        result["mismatch"] = (
            "client/source version %s differs from installed product %s"
            % (client_version, installed_version)
        )
    try:
        metadata = load_metadata(source)
    except ReleaseError as exc:
        result["message"] = str(exc)
        return result
    result.update({
        "candidate_version": metadata.version,
        "latest_version": metadata.version,
        "metadata": "available",
        "artifact": str(metadata.artifact),
        "sha256": metadata.sha256,
    })
    if not installed_version:
        result["message"] = (
            "live installed version unavailable; cannot compute upgrade eligibility"
        )
        return result
    try:
        result["available"] = version_tuple(metadata.version) > version_tuple(installed_version)
    except ReleaseError as exc:
        result["message"] = str(exc)
        return result
    result["message"] = (
        "upgrade available" if result["available"] else "installed version is current"
    )
    if metadata.signature:
        result["signature"] = "present"
    return result


def verify_artifact(metadata: ReleaseMetadata) -> None:
    """Verify the immutable artifact before it can reach the privileged path."""
    if metadata.signature:
        raise ReleaseError(
            "release signature is present but no maintainer-approved signature "
            "verifier is configured yet"
        )
    if not metadata.artifact.is_file():
        raise ReleaseError("release artifact was not found: %s" % metadata.artifact)
    digest = hashlib.sha256(metadata.artifact.read_bytes()).hexdigest()
    if digest != metadata.sha256:
        raise ReleaseError(
            "release artifact SHA-256 mismatch (expected %s, got %s)" %
            (metadata.sha256, digest)
        )
    if not tarfile.is_tarfile(metadata.artifact):
        raise ReleaseError("release artifact is not a readable tar archive")


def _safe_members(archive: tarfile.TarFile, destination: pathlib.Path):
    for member in archive.getmembers():
        name = pathlib.PurePosixPath(member.name)
        if name.is_absolute() or ".." in name.parts:
            raise ReleaseError("release artifact contains an unsafe path: %s" % member.name)
        if member.issym() or member.islnk() or not (member.isdir() or member.isfile()):
            raise ReleaseError("release artifact contains an unsupported entry: %s" % member.name)
        target = (destination / pathlib.Path(*name.parts)).resolve()
        if target != destination and destination not in target.parents:
            raise ReleaseError("release artifact escapes its staging directory")
        yield member


def prepare_artifact(metadata: ReleaseMetadata, destination: pathlib.Path | None = None) -> pathlib.Path:
    """Verify and safely unpack an artifact, returning a disposable stage."""
    verify_artifact(metadata)
    stage = destination or pathlib.Path(tempfile.mkdtemp(prefix="asip-release-"))
    stage.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        with tarfile.open(metadata.artifact, "r:*") as archive:
            archive.extractall(stage, members=_safe_members(archive, stage))
        root = stage
        if not (root / "asip").is_file():
            candidates = [path.parent for path in stage.rglob("asip") if path.is_file()]
            if len(candidates) == 1:
                root = candidates[0]
        required = REQUIRED_ARTIFACT_FILES
        if metadata.mcp_wheelhouse:
            required = required + PRODUCT_ARTIFACT_FILES
        missing = [name for name in required if not (root / name).exists()]
        if missing:
            raise ReleaseError("release artifact is missing: %s" % ", ".join(missing))
        return root
    except Exception:
        if destination is None:
            shutil.rmtree(stage, ignore_errors=True)
        raise


def prepare_shared_artifact(metadata: ReleaseMetadata) -> tuple[pathlib.Path, pathlib.Path]:
    """Prepare an artifact where ASIP's PrivateTmp daemon can consume it.

    The privileged daemon deliberately has a private /tmp namespace.  A stage
    created by the unprivileged CLI in the normal temporary directory is
    therefore not a usable self-upgrade source.  Keep the stage private to the
    operator while placing it under their cache directory, which remains
    visible to the daemon.  Return the extraction root separately from the
    cleanup root because release archives may contain one top-level directory.
    """
    configured = os.environ.get("ASIP_RELEASE_STAGE_PARENT", "").strip()
    parent = (
        pathlib.Path(configured).expanduser()
        if configured else pathlib.Path.home() / ".cache" / "asip" / "release-staging"
    )
    parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if parent.is_symlink() or not parent.is_dir():
        raise ReleaseError("release staging parent is not a private directory: %s" % parent)
    parent.chmod(0o700)
    stage = pathlib.Path(tempfile.mkdtemp(prefix="asip-release-", dir=parent))
    try:
        return prepare_artifact(metadata, stage), stage
    except Exception:
        shutil.rmtree(stage, ignore_errors=True)
        raise


def _print_status(status: dict[str, Any], as_json: bool):
    if as_json:
        print(json.dumps(status, separators=(",", ":"), sort_keys=True))
        return
    for key in ("client_version", "installed_version", "installed_source",
                "candidate_version", "latest_version", "available", "metadata",
                "message", "mismatch"):
        if key not in status:
            continue
        value = status.get(key)
        if isinstance(value, bool):
            value = str(value).lower()
        print("%s=%s" % (key, "" if value is None else value))
    if status.get("artifact"):
        print("artifact=%s" % status["artifact"])
    if status.get("sha256"):
        print("sha256=%s" % status["sha256"])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="ASIP release metadata helper")
    parser.add_argument("action", choices=("check", "prepare"))
    parser.add_argument("--metadata", default=None)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    if args.action == "check":
        _print_status(check_status(args.metadata), args.json)
        return 0
    try:
        metadata = load_metadata(args.metadata)
        installed, source = live_product_version()
        if installed is None:
            raise ReleaseError(
                "live installed version unavailable (%s); will not compare against this checkout"
                % source
            )
        if version_tuple(metadata.version) <= version_tuple(installed):
            raise ReleaseError("no newer ASIP release is available")
        root, stage = prepare_shared_artifact(metadata)
        if args.json:
            print(json.dumps(
                {"root": str(root), "stage": str(stage)},
                separators=(",", ":"), sort_keys=True,
            ))
        else:
            print(root)
        return 0
    except ReleaseError as exc:
        print("asip release: %s" % exc, file=os.sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Create and maintain privacy-bounded ASIP clean-machine qualification records."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import pathlib
import platform
import re
import shutil
import tarfile
import tempfile
import uuid
from typing import Any


SCHEMA_VERSION = 1
PHASES = (
    ("candidate_integrity", "Candidate artifact and offline dependencies"),
    ("clean_host", "Clean disposable Linux host preflight"),
    ("bootstrap", "Unprivileged bootstrap and handoff"),
    ("first_install", "One-time privileged first install"),
    ("fresh_session", "Fresh login group authority"),
    ("socket_boundary", "Mutation/read-only socket authority"),
    ("harness_mcp", "Harness refresh and MCP stdio contracts"),
    ("telemetry", "Default-off telemetry behavior"),
    ("change_recovery", "Change, verification, and recovery behavior"),
    ("reinstall", "Idempotent reinstall and state preservation"),
    ("upgrade", "Verified self-upgrade and deferred restart"),
    ("failure_injection", "Offline and integrity failure behavior"),
    ("removal", "Evidence-preserving removal procedure"),
)
PHASE_IDS = {phase_id for phase_id, _title in PHASES}
PROHIBITED_EVIDENCE_KEY = re.compile(
    r"(?:argv|command|credential|host(?:name)?|intent|journal|note|output|package|path|secret|user(?:name)?)",
    re.IGNORECASE,
)
SAFE_KEY = re.compile(r"^[a-z][a-z0-9_]{0,47}$")


class QualificationError(ValueError):
    """A qualification result or candidate is invalid."""


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def digest(path: pathlib.Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def os_release() -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        lines = pathlib.Path("/etc/os-release").read_text(encoding="utf-8").splitlines()
    except OSError:
        return values
    for line in lines:
        key, separator, value = line.partition("=")
        if separator and key in {"ID", "VERSION_ID"}:
            values[key.lower()] = value.strip().strip('"')[:80]
    return values


def safe_archive_names(artifact: pathlib.Path) -> list[str]:
    try:
        with tarfile.open(artifact, "r:*") as archive:
            names = archive.getnames()
    except (OSError, tarfile.TarError) as exc:
        raise QualificationError(f"candidate archive is unreadable: {exc}") from exc
    for name in names:
        candidate = pathlib.PurePosixPath(name)
        if candidate.is_absolute() or ".." in candidate.parts:
            raise QualificationError("candidate archive contains an unsafe path")
    return names


def validate_candidate(artifact: pathlib.Path, manifest_path: pathlib.Path) -> tuple[dict[str, Any], int]:
    if not artifact.is_file() or not manifest_path.is_file():
        raise QualificationError("candidate artifact and release manifest must be readable files")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise QualificationError(f"release manifest is unreadable: {exc}") from exc
    required = {"schema_version", "version", "artifact", "sha256", "mcp_wheelhouse"}
    if not isinstance(manifest, dict) or not required.issubset(manifest):
        raise QualificationError("release manifest is missing qualification fields")
    if manifest["schema_version"] != 1 or manifest["artifact"] != artifact.name:
        raise QualificationError("release manifest does not identify this candidate artifact")
    actual = digest(artifact)
    if manifest["sha256"] != actual:
        raise QualificationError("candidate artifact SHA-256 does not match the manifest")
    if manifest["mcp_wheelhouse"] is not True:
        raise QualificationError("candidate is not a product release with an MCP wheelhouse")
    names = safe_archive_names(artifact)
    required_suffixes = (
        "/asip", "/install.sh", "/README.md", "/LICENSE", "/SECURITY.md",
        "/INSTALL.md", "/UPGRADE.md",
        "/UNINSTALL.md", "/scripts/restore_install_backup.sh",
        "/scripts/uninstall_software.sh",
        "/wheelhouse/SHA256SUMS",
        "/wheelhouse/common/", "/wheelhouse/py312-linux-x86_64/",
        "/wheelhouse/py313-linux-x86_64/", "/wheelhouse/py314-linux-x86_64/",
        "/requirements/mcp-py312-linux-x86_64.lock",
        "/requirements/mcp-py313-linux-x86_64.lock",
        "/requirements/mcp-py314-linux-x86_64.lock",
    )
    for suffix in required_suffixes:
        if not any(name.endswith(suffix) or f"{suffix}" in f"{name}/" for name in names):
            raise QualificationError(f"candidate is missing required release content: {suffix}")
    return manifest, len(names)


def atomic_write(path: pathlib.Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".qualification-", dir=path.parent)
    temporary = pathlib.Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, indent=2, sort_keys=True)
            stream.write("\n")
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def load_result(path: pathlib.Path) -> dict[str, Any]:
    try:
        result = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise QualificationError(f"qualification result is unreadable: {exc}") from exc
    if not isinstance(result, dict) or result.get("schema_version") != SCHEMA_VERSION:
        raise QualificationError("qualification result has an unsupported schema")
    return result


def initialize(artifact: pathlib.Path, manifest_path: pathlib.Path, output: pathlib.Path) -> dict[str, Any]:
    manifest, member_count = validate_candidate(artifact, manifest_path)
    started = now()
    clean = shutil.which("asip") is None and not pathlib.Path("/etc/asip").exists()
    phases = [
        {"id": phase_id, "title": title, "status": "not_run", "evidence": {},
         "started_at": None, "finished_at": None, "note": None}
        for phase_id, title in PHASES
    ]
    phases[0].update({
        "status": "pass", "started_at": started, "finished_at": started,
        "evidence": {"archive_members": member_count, "wheelhouse_bundled": True},
    })
    phases[1].update({
        "status": "pass" if clean else "fail", "started_at": started, "finished_at": started,
        "evidence": {"asip_preexisting": not clean},
        "note": None if clean else "ASIP or /etc/asip already existed before qualification.",
    })
    release = os_release()
    result = {
        "schema_version": SCHEMA_VERSION,
        "run_id": str(uuid.uuid4()),
        "status": "in_progress",
        "started_at": started,
        "finished_at": None,
        "candidate": {
            "artifact": artifact.name,
            "sha256": manifest["sha256"],
            "version": str(manifest["version"]),
            "manifest_sha256": digest(manifest_path),
        },
        "platform": {
            "distro_id": release.get("id", "unknown"),
            "distro_version": release.get("version_id", "unknown"),
            "architecture": platform.machine()[:80],
            "python": platform.python_version(),
            "systemd_available": shutil.which("systemctl") is not None,
        },
        "privacy": {
            "raw_command_output_recorded": False,
            "raw_journal_recorded": False,
            "hostnames_usernames_paths_recorded": False,
        },
        "phases": phases,
    }
    atomic_write(output, result)
    return result


def parse_evidence(entries: list[str]) -> dict[str, Any]:
    evidence: dict[str, Any] = {}
    for entry in entries:
        key, separator, value = entry.partition("=")
        if not separator or not SAFE_KEY.fullmatch(key) or PROHIBITED_EVIDENCE_KEY.search(key):
            raise QualificationError(f"unsafe evidence field: {key or entry}")
        if len(value) > 160 or any(character in value for character in "\r\n"):
            raise QualificationError(f"evidence value is too long or multiline: {key}")
        if value in {"true", "false"}:
            clean: Any = value == "true"
        elif re.fullmatch(r"0|[1-9][0-9]*", value):
            clean = int(value)
        else:
            clean = value
        evidence[key] = clean
    return evidence


def record(path: pathlib.Path, phase_id: str, status: str,
           evidence_entries: list[str], note: str | None) -> dict[str, Any]:
    if phase_id not in PHASE_IDS:
        raise QualificationError(f"unknown qualification phase: {phase_id}")
    if note and (len(note) > 500 or "\n" in note):
        raise QualificationError("operator note must be one line and at most 500 characters")
    result = load_result(path)
    phase = next(item for item in result["phases"] if item["id"] == phase_id)
    timestamp = now()
    phase.update({
        "status": status,
        "evidence": parse_evidence(evidence_entries),
        "started_at": phase.get("started_at") or timestamp,
        "finished_at": timestamp,
        "note": note,
    })
    atomic_write(path, result)
    return result


def finalize(path: pathlib.Path) -> dict[str, Any]:
    result = load_result(path)
    statuses = [phase["status"] for phase in result["phases"]]
    result["status"] = "pass" if statuses and all(status == "pass" for status in statuses) else "fail"
    result["finished_at"] = now()
    atomic_write(path, result)
    return result


def render(result: dict[str, Any]) -> str:
    candidate = result["candidate"]
    host = result["platform"]
    lines = [
        f"# ASIP qualification {result['run_id']}", "",
        f"- Overall: **{result['status']}**",
        f"- Candidate: `{candidate['artifact']}` ({candidate['version']})",
        f"- SHA-256: `{candidate['sha256']}`",
        f"- Platform: {host['distro_id']} {host['distro_version']}, {host['architecture']}, Python {host['python']}",
        "- Privacy: no raw command output, journal records, hostnames, usernames, or paths are recorded.",
        "", "## Phases", "",
        "| Phase | Status | Evidence |", "|---|---:|---|",
    ]
    for phase in result["phases"]:
        evidence = ", ".join(f"{key}={value}" for key, value in sorted(phase["evidence"].items())) or "—"
        if phase.get("note"):
            evidence = f"{evidence}; note: {phase['note']}"
        lines.append(f"| {phase['title']} | {phase['status']} | {evidence} |")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="action", required=True)
    init = subparsers.add_parser("init")
    init.add_argument("--artifact", type=pathlib.Path, required=True)
    init.add_argument("--manifest", type=pathlib.Path, required=True)
    init.add_argument("--output", type=pathlib.Path, required=True)
    update = subparsers.add_parser("record")
    update.add_argument("--result", type=pathlib.Path, required=True)
    update.add_argument("--phase", choices=sorted(PHASE_IDS), required=True)
    update.add_argument("--status", choices=("pass", "fail", "skip"), required=True)
    update.add_argument("--evidence", action="append", default=[])
    update.add_argument("--note")
    finish = subparsers.add_parser("finalize")
    finish.add_argument("--result", type=pathlib.Path, required=True)
    report = subparsers.add_parser("render")
    report.add_argument("--result", type=pathlib.Path, required=True)
    report.add_argument("--output", type=pathlib.Path)
    args = parser.parse_args(argv)
    try:
        if args.action == "init":
            result = initialize(args.artifact, args.manifest, args.output)
            print(json.dumps({"result": str(args.output), "run_id": result["run_id"]}))
        elif args.action == "record":
            record(args.result, args.phase, args.status, args.evidence, args.note)
            print(json.dumps({"result": str(args.result), "phase": args.phase, "status": args.status}))
        elif args.action == "finalize":
            result = finalize(args.result)
            print(json.dumps({"result": str(args.result), "status": result["status"]}))
            return 0 if result["status"] == "pass" else 1
        else:
            rendered = render(load_result(args.result))
            if args.output:
                args.output.write_text(rendered, encoding="utf-8")
            else:
                print(rendered, end="")
    except QualificationError as exc:
        parser.error(str(exc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

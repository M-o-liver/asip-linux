#!/usr/bin/env python3
"""Preview or write a privacy-bounded ASIP support diagnostic."""

from __future__ import annotations

import argparse
import grp
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from typing import Any, Callable

if __package__ in (None, ""):
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from core.protocol import READ_ONLY_SOCKET, UnixClient, VERSION


SCHEMA_VERSION = 1
COUNTERS = (
    "completed_changes", "failed_changes", "open_changes",
    "privileged_operations", "configuration_changes", "snapshots", "rollbacks",
    "verification_pass", "verification_fail", "incomplete_operations",
)
HEALTH_FIELDS = ("read_socket", "snapshotter", "recovery", "machine")
UNITS = ("asip.socket", "asip.service", "asip-read.socket", "asip-read.service")


def read_summary() -> dict[str, Any]:
    response = UnixClient(READ_ONLY_SOCKET).call({
        "schema_version": 1, "op": "summary", "argv": [], "cwd": "/", "reason": "",
    }).response
    if not response.get("ok"):
        raise RuntimeError(response.get("error", {}).get("message", "ASIP summary unavailable"))
    return response.get("data", {})


def unit_state(name: str) -> str:
    try:
        result = subprocess.run(
            ["systemctl", "is-active", name], check=False, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "unavailable"
    value = result.stdout.strip()
    return value if value in {"active", "inactive", "failed", "activating", "deactivating"} else "unknown"


def socket_state(path: pathlib.Path, group: str) -> dict[str, Any]:
    try:
        details = path.stat()
    except OSError:
        return {"exists": False, "mode": None, "root_owned": False, "group_expected": False}
    try:
        expected_gid = grp.getgrnam(group).gr_gid
    except KeyError:
        expected_gid = -1
    return {
        "exists": True,
        "mode": format(stat.S_IMODE(details.st_mode), "04o"),
        "root_owned": details.st_uid == 0,
        "group_expected": details.st_gid == expected_gid,
    }


def command_version(command: str) -> dict[str, Any]:
    """Return a bounded, non-secret presence/version probe for support output."""
    executable = shutil.which(command)
    if not executable:
        return {"installed": False, "version": None}
    version = None
    try:
        result = subprocess.run(
            [executable, "--version"], check=False, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=3,
        )
        first = result.stdout.splitlines()[0].strip() if result.stdout else ""
        if first and len(first) <= 80 and re.fullmatch(r"[A-Za-z0-9_.+:/ -]+", first):
            version = first
    except (OSError, subprocess.TimeoutExpired):
        pass
    return {"installed": True, "version": version}


def installed_surface(summary: dict[str, Any]) -> dict[str, Any]:
    expected_version = str(summary.get("version", VERSION))
    version_files = {}
    for label, path in (("share", pathlib.Path("/usr/share/asip/VERSION")),
                        ("lib", pathlib.Path("/usr/lib/asip/VERSION"))):
        try:
            value = path.read_text(encoding="utf-8").splitlines()[0].strip()
        except (OSError, IndexError):
            value = None
        version_files[label] = value == expected_version
    return {
        "version_files_match": all(version_files.values()),
        "version_files": version_files,
        "restore_helper": pathlib.Path("/usr/local/sbin/asip-restore").is_file(),
        "codex": command_version("codex"),
        "mcp": {
            "inspect_launcher": pathlib.Path.home().joinpath(".local/bin/asip-mcp-inspect").is_file(),
            "admin_launcher": pathlib.Path.home().joinpath(".local/bin/asip-mcp-admin").is_file(),
        },
    }


def build_diagnostic(
    summary: dict[str, Any], *,
    unit_reader: Callable[[str], str] = unit_state,
    socket_reader: Callable[[pathlib.Path, str], dict[str, Any]] = socket_state,
) -> dict[str, Any]:
    statistics = summary.get("statistics", {})
    health = summary.get("health", {})
    platform = summary.get("platform", {})
    return {
        "schema_version": SCHEMA_VERSION,
        "asip_version": str(summary.get("version", VERSION)),
        "platform": {
            "distribution": str(platform.get("distribution", "unknown"))[:120],
            "distro_family": str(platform.get("distro_family", "unknown"))[:80],
        },
        "health": {field: str(health.get(field, "unknown"))[:120] for field in HEALTH_FIELDS},
        "statistics": {field: max(0, int(statistics.get(field, 0))) for field in COUNTERS},
        "units": {name: unit_reader(name) for name in UNITS},
        "installation": installed_surface(summary),
        "sockets": {
            "privileged": socket_reader(pathlib.Path("/run/asip/sock"), "asip"),
            "read_only": socket_reader(pathlib.Path("/run/asip/read.sock"), "asip-read"),
        },
        "redaction": {
            "commands_and_argv": "excluded",
            "captured_output_and_blobs": "excluded",
            "change_intents_and_notes": "excluded",
            "journal_records": "excluded",
            "machine_policy_and_paths": "excluded",
            "usernames_and_hostnames": "excluded",
            "credentials": "excluded",
        },
    }


def write_diagnostic(path: pathlib.Path, diagnostic: dict[str, Any]) -> None:
    path = path.expanduser()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".asip-support-", dir=path.parent)
    temporary = pathlib.Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(diagnostic, stream, indent=2, sort_keys=True)
            stream.write("\n")
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def main(argv: list[str] | None = None,
         summary_reader: Callable[[], dict[str, Any]] = read_summary) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="action", required=True)
    subparsers.add_parser("preview")
    bundle = subparsers.add_parser("bundle")
    bundle.add_argument("--output", required=True, type=pathlib.Path)
    args = parser.parse_args(argv)
    try:
        diagnostic = build_diagnostic(summary_reader())
    except PermissionError:
        print(
            "asip support: permission denied reading the inspection socket; "
            "start a fresh login or harness from a host context that preserves "
            "the asip-read group. Do not use sg inside a confined runner: it "
            "may fail before ASIP starts.",
            file=sys.stderr,
        )
        return 77
    except FileNotFoundError:
        print(
            "asip support: the read-only socket is unavailable; check asip-read.socket",
            file=sys.stderr,
        )
        return 69
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"asip support: could not build the diagnostic: {exc}", file=sys.stderr)
        return 1
    if args.action == "preview":
        print(json.dumps(diagnostic, indent=2, sort_keys=True))
    else:
        write_diagnostic(args.output, diagnostic)
        print("ASIP support diagnostic written. Preview and approve it before sharing.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

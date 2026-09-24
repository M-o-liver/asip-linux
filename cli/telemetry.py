"""Opt-in local aggregate telemetry configuration.

This module deliberately has no network transport. It stores only local
consent and a random pseudonymous installation identifier, and builds an
inspectable aggregate payload from the bounded read-only summary query.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Callable

if __package__ in (None, ""):
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from core.protocol import READ_ONLY_SOCKET, UnixClient, VERSION


SCHEMA_VERSION = 1


def state_path() -> pathlib.Path:
    configured = os.environ.get("ASIP_TELEMETRY_STATE")
    if configured:
        return pathlib.Path(configured).expanduser()
    config = pathlib.Path(os.environ.get("XDG_CONFIG_HOME", pathlib.Path.home() / ".config"))
    return config / "asip" / "telemetry.json"


def default_state() -> dict[str, Any]:
    return {"schema_version": SCHEMA_VERSION, "enabled": False, "installation_id": None}


def load_state(path: pathlib.Path | None = None) -> dict[str, Any]:
    path = path or state_path()
    if not path.is_file():
        return default_state()
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("telemetry preference is unreadable: %s" % exc) from exc
    if not isinstance(state, dict) or state.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("telemetry preference has an unsupported schema")
    return {**default_state(), **state}


def save_state(state: dict[str, Any], path: pathlib.Path | None = None) -> pathlib.Path:
    path = path or state_path()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".telemetry-", dir=path.parent)
    os.close(descriptor)
    temporary = pathlib.Path(temporary_name)
    try:
        temporary.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
    return path


def ensure_installation_id(state: dict[str, Any]) -> str:
    value = state.get("installation_id")
    if not isinstance(value, str) or not value:
        value = str(uuid.uuid4())
        state["installation_id"] = value
    return value


def read_summary() -> dict[str, Any]:
    reply = UnixClient(READ_ONLY_SOCKET).call({
        "schema_version": 1, "op": "summary", "argv": [], "cwd": "/", "reason": ""
    }).response
    if not reply.get("ok"):
        raise RuntimeError(reply.get("error", {}).get("message", "ASIP summary unavailable"))
    return reply.get("data", {})


def build_payload(
    summary: dict[str, Any], state: dict[str, Any], *,
    now: Callable[[], dt.datetime] | None = None,
) -> dict[str, Any]:
    """Whitelist aggregate values so raw journal fields cannot leak by accident."""
    now = now or (lambda: dt.datetime.now(dt.timezone.utc))
    metrics = summary.get("statistics", {})
    platform = summary.get("platform", {})
    health = summary.get("health", {})
    return {
        "schema_version": SCHEMA_VERSION,
        "installation_id": ensure_installation_id(state),
        "report_window": now().date().isoformat(),
        "metrics": {
            "asip_version": str(summary.get("version", VERSION)),
            "distro_family": str(platform.get("distro_family", "unknown")),
            "snapshot_backend": str(health.get("snapshotter", "unknown")),
            "completed_changes": int(metrics.get("completed_changes", 0)),
            "failed_changes": int(metrics.get("failed_changes", 0)),
            "privileged_operations": int(metrics.get("privileged_operations", 0)),
            "configuration_changes": int(metrics.get("configuration_changes", 0)),
            "snapshots": int(metrics.get("snapshots", 0)),
            "rollbacks": int(metrics.get("rollbacks", 0)),
            "verification_pass": int(metrics.get("verification_pass", 0)),
            "verification_fail": int(metrics.get("verification_fail", 0)),
            "incomplete_operations": int(metrics.get("incomplete_operations", 0)),
        },
    }


def configured_endpoint() -> str | None:
    """Return an explicitly configured transport destination, if valid."""
    value = os.environ.get("ASIP_TELEMETRY_ENDPOINT", "").strip()
    if not value:
        return None
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("ASIP_TELEMETRY_ENDPOINT must be an http(s) URL")
    if parsed.username or parsed.password:
        raise ValueError("ASIP_TELEMETRY_ENDPOINT must not contain credentials")
    return value


def send_payload(
    payload: dict[str, Any], endpoint: str, *,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> dict[str, Any]:
    """Send one already-whitelisted payload through the isolated transport."""
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    request = urllib.request.Request(
        endpoint,
        data=body,
        headers={"Content-Type": "application/json", "User-Agent": f"asip/{VERSION}"},
        method="POST",
    )
    try:
        response = opener(request, timeout=10)
        raw = response.read()
        status_code = getattr(response, "status", None)
        if status_code is None:
            status_code = response.getcode()
    except (OSError, urllib.error.URLError, urllib.error.HTTPError) as exc:
        raise RuntimeError(f"telemetry delivery failed: {exc}") from exc
    if status_code < 200 or status_code >= 300:
        raise RuntimeError(f"telemetry endpoint returned HTTP {status_code}")
    if not raw:
        return {"ok": True, "status": status_code}
    try:
        result = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("telemetry endpoint returned invalid JSON") from exc
    if not isinstance(result, dict):
        raise RuntimeError("telemetry endpoint returned a non-object response")
    return result


def status(path: pathlib.Path | None = None) -> dict[str, Any]:
    state = load_state(path)
    return {
        "schema_version": SCHEMA_VERSION,
        "enabled": bool(state.get("enabled", False)),
        "installation_id": state.get("installation_id"),
        "installation_id_kind": "random pseudonymous identifier",
        "transport": "not configured; local aggregation only",
    }


def main(argv: list[str] | None = None,
         summary_reader: Callable[[], dict[str, Any]] = read_summary) -> int:
    parser = argparse.ArgumentParser(description="Manage ASIP opt-in aggregate telemetry")
    parser.add_argument("action", choices=("status", "preview", "enable", "disable", "send"))
    args = parser.parse_args(argv)
    path = state_path()
    state = load_state(path)
    if args.action == "status":
        print(json.dumps(status(path), indent=2, sort_keys=True))
        return 0
    if args.action == "enable":
        ensure_installation_id(state)
        state["enabled"] = True
        save_state(state, path)
        print(
            "Telemetry enabled locally. Data is sent only by an explicit "
            "'asip telemetry send' with ASIP_TELEMETRY_ENDPOINT configured."
        )
        return 0
    if args.action == "disable":
        state["enabled"] = False
        save_state(state, path)
        print("Telemetry disabled locally. No data is sent.")
        return 0
    if args.action == "send":
        if not state.get("enabled", False):
            print("Telemetry is disabled; enable it explicitly before sending.", file=sys.stderr)
            return 1
        try:
            endpoint = configured_endpoint()
        except ValueError as exc:
            print(f"Telemetry not sent: {exc}", file=sys.stderr)
            return 1
        if endpoint is None:
            print("Telemetry not sent: set ASIP_TELEMETRY_ENDPOINT explicitly.", file=sys.stderr)
            return 1
        payload = build_payload(summary_reader(), state)
        try:
            result = send_payload(payload, endpoint)
        except RuntimeError as exc:
            print(f"Telemetry not sent: {exc}", file=sys.stderr)
            return 1
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    had_id = state.get("installation_id")
    ensure_installation_id(state)
    if state.get("installation_id") != had_id:
        save_state(state, path)
    payload = build_payload(summary_reader(), state)
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

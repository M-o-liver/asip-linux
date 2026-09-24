"""Local development collector for ASIP aggregate telemetry.

This is deliberately a small, loopback-only stand-in for a future HTTPS
collector. It accepts only the already-whitelisted aggregate payload schema,
stores one record per installation/report window, and never accepts journal
records, commands, output, or credentials.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import re
import tempfile
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


SCHEMA_VERSION = 1
MAX_BODY = 64 * 1024
INSTALLATION_ID = re.compile(r"^[0-9a-f-]{36}$")
COUNTER_FIELDS = (
    "completed_changes",
    "failed_changes",
    "privileged_operations",
    "configuration_changes",
    "snapshots",
    "rollbacks",
    "verification_pass",
    "verification_fail",
    "incomplete_operations",
)
STRING_FIELDS = ("asip_version", "distro_family", "snapshot_backend")


class TelemetryError(ValueError):
    """The payload is not a valid aggregate telemetry report."""


def state_path() -> pathlib.Path:
    configured = os.environ.get("ASIP_TELEMETRY_SERVER_STATE")
    if configured:
        return pathlib.Path(configured).expanduser()
    state_home = pathlib.Path(os.environ.get("XDG_STATE_HOME", pathlib.Path.home() / ".local" / "state"))
    return state_home / "asip" / "telemetry-server.json"


def validate_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise TelemetryError("payload must be a JSON object")
    if set(payload) != {"schema_version", "installation_id", "report_window", "metrics"}:
        raise TelemetryError("payload contains fields outside the aggregate schema")
    if payload["schema_version"] != SCHEMA_VERSION:
        raise TelemetryError("unsupported telemetry schema version")
    installation_id = payload["installation_id"]
    if not isinstance(installation_id, str) or not INSTALLATION_ID.fullmatch(installation_id):
        raise TelemetryError("installation_id must be a UUID-shaped pseudonymous identifier")
    report_window = payload["report_window"]
    try:
        dt.date.fromisoformat(report_window)
    except (TypeError, ValueError) as exc:
        raise TelemetryError("report_window must be an ISO date") from exc
    metrics = payload["metrics"]
    if not isinstance(metrics, dict) or set(metrics) != set(STRING_FIELDS + COUNTER_FIELDS):
        raise TelemetryError("metrics must contain only the documented aggregate fields")
    clean_metrics: dict[str, Any] = {}
    for field in STRING_FIELDS:
        value = metrics[field]
        if not isinstance(value, str) or not value or len(value) > 80:
            raise TelemetryError(f"{field} must be a short non-empty string")
        clean_metrics[field] = value
    for field in COUNTER_FIELDS:
        value = metrics[field]
        if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > 2**63 - 1:
            raise TelemetryError(f"{field} must be a non-negative integer")
        clean_metrics[field] = value
    return {
        "schema_version": SCHEMA_VERSION,
        "installation_id": installation_id,
        "report_window": report_window,
        "metrics": clean_metrics,
    }


def default_state() -> dict[str, Any]:
    return {"schema_version": SCHEMA_VERSION, "reports": {}}


def load_state(path: pathlib.Path) -> dict[str, Any]:
    if not path.is_file():
        return default_state()
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise TelemetryError(f"collector state is unreadable: {exc}") from exc
    if not isinstance(state, dict) or state.get("schema_version") != SCHEMA_VERSION:
        raise TelemetryError("collector state has an unsupported schema")
    reports = state.get("reports")
    if not isinstance(reports, dict):
        raise TelemetryError("collector state reports are invalid")
    return {"schema_version": SCHEMA_VERSION, "reports": reports}


def save_state(state: dict[str, Any], path: pathlib.Path) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".telemetry-server-", dir=path.parent)
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


class TelemetryStore:
    def __init__(self, path: pathlib.Path):
        self.path = path
        self.state = load_state(path)

    def ingest(self, payload: Any) -> tuple[str, dict[str, Any]]:
        clean = validate_payload(payload)
        key = f"{clean['installation_id']}:{clean['report_window']}"
        existing = self.state["reports"].get(key)
        if existing == clean:
            return "duplicate", clean
        if existing is not None:
            raise TelemetryError("report window already exists with different data")
        self.state["reports"][key] = clean
        save_state(self.state, self.path)
        return "accepted", clean

    def summary(self) -> dict[str, Any]:
        reports = list(self.state["reports"].values())
        latest: dict[str, dict[str, Any]] = {}
        for report in reports:
            installation_id = report["installation_id"]
            if report["report_window"] > latest.get(installation_id, {}).get("report_window", ""):
                latest[installation_id] = report
        totals = {field: 0 for field in COUNTER_FIELDS}
        versions: dict[str, int] = {}
        distros: dict[str, int] = {}
        backends: dict[str, int] = {}
        for report in latest.values():
            metrics = report["metrics"]
            for field in COUNTER_FIELDS:
                totals[field] += metrics[field]
            for field, destination in (
                ("asip_version", versions),
                ("distro_family", distros),
                ("snapshot_backend", backends),
            ):
                value = metrics[field]
                destination[value] = destination.get(value, 0) + 1
        return {
            "schema_version": SCHEMA_VERSION,
            "participating_installations": len(latest),
            "accepted_report_windows": len(reports),
            "metrics": totals,
            "asip_versions": versions,
            "distro_families": distros,
            "snapshot_backends": backends,
        }


class TelemetryHandler(BaseHTTPRequestHandler):
    server: "TelemetryHTTPServer"

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, sort_keys=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send_json(HTTPStatus.OK, {"ok": True, "service": "asip-telemetry-local"})
        elif self.path == "/v1/telemetry/summary":
            self._send_json(HTTPStatus.OK, self.server.store.summary())
        else:
            self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:
        if self.path != "/v1/telemetry":
            self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            length = -1
        if length < 0 or length > MAX_BODY:
            self._send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"ok": False, "error": "invalid body size"})
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            outcome, clean = self.server.store.ingest(payload)
        except (UnicodeDecodeError, json.JSONDecodeError, TelemetryError) as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
            return
        status = HTTPStatus.CREATED if outcome == "accepted" else HTTPStatus.OK
        self._send_json(status, {"ok": True, "status": outcome, "report_window": clean["report_window"]})

    def do_PUT(self) -> None:
        self._send_json(HTTPStatus.METHOD_NOT_ALLOWED, {"ok": False, "error": "read-only route"})

    def do_DELETE(self) -> None:
        self._send_json(HTTPStatus.METHOD_NOT_ALLOWED, {"ok": False, "error": "read-only route"})

    def log_message(self, _format: str, *_args: Any) -> None:
        return


class TelemetryHTTPServer(ThreadingHTTPServer):
    def __init__(self, address: tuple[str, int], store: TelemetryStore):
        super().__init__(address, TelemetryHandler)
        self.store = store


def make_server(port: int, path: pathlib.Path | None = None) -> TelemetryHTTPServer:
    return TelemetryHTTPServer(("127.0.0.1", port), TelemetryStore(path or state_path()))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the localhost ASIP development telemetry collector")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--state", type=pathlib.Path, default=None)
    args = parser.parse_args(argv)
    server = make_server(args.port, args.state)
    print(f"ASIP local telemetry collector listening at http://127.0.0.1:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

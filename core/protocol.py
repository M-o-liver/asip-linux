"""Shared ASIP request/response contract and Unix-socket client.

The daemon and CLI intentionally remain standard-library only.  Optional
adapters (notably MCP) build on this module instead of translating shell
output back into state.
"""

from __future__ import annotations

import json
import pathlib
import socket
import time
from dataclasses import dataclass, field
from typing import Any, Callable


SCHEMA_VERSION = 1
_VERSION_FILE = pathlib.Path(__file__).resolve().parents[1] / "VERSION"
VERSION = _VERSION_FILE.read_text(encoding="utf-8").strip() if _VERSION_FILE.is_file() else "0.1.0"
PRIVILEGED_SOCKET = "/run/asip/sock"
READ_ONLY_SOCKET = "/run/asip/read.sock"
MAX_REQUEST_BYTES = 1024 * 1024
MAX_EXCERPT_BYTES = 16 * 1024


READ_ONLY_OPERATIONS = {
    "audit-pending",
    "blob",
    "brief",
    "context",
    "doctor",
    "drift-list",
    "eval-evidence",
    "facts",
    "journal-search",
    "log",
    "machine-policy",
    "operation",
    "project-list",
    "recovery",
    "summary",
}


def is_read_only(request: dict[str, Any]) -> bool:
    """Return whether a request is observational and may use read.sock."""
    op = request.get("op")
    action = request.get("action")
    if op in READ_ONLY_OPERATIONS:
        return True
    if op == "change" and action in ("list", "open", "show", "status"):
        return True
    if op == "maintenance" and action in ("list", "history", "open"):
        return True
    if op == "verify" and action == "list":
        return True
    if op == "ask" and action in ("list", "show"):
        return True
    if op == "access" and action in ("list", "show"):
        return True
    return False


def structured_error(
    code: str,
    message: str,
    *,
    exit_code: int = 64,
    retryable: bool = False,
    remediation: str = "",
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    error: dict[str, Any] = {
        "code": code,
        "message": message,
        "retryable": retryable,
    }
    if remediation:
        error["remediation"] = remediation
    if details:
        error["details"] = details
    return {
        "schema_version": SCHEMA_VERSION,
        "ok": False,
        "id": "",
        "exit": exit_code,
        "stdout": "",
        "stderr": message + "\n",
        "duration_ms": 0,
        "error": error,
    }


def normalize_response(response: dict[str, Any]) -> dict[str, Any]:
    """Add the v1 envelope while accepting responses from older daemons."""
    normalized = dict(response)
    normalized.setdefault("schema_version", SCHEMA_VERSION)
    normalized.setdefault("ok", normalized.get("exit", 1) == 0)
    normalized.setdefault("id", "")
    normalized.setdefault("exit", 1)
    normalized.setdefault("stdout", "")
    normalized.setdefault("stderr", "")
    normalized.setdefault("duration_ms", 0)
    return normalized


def excerpt(value: str, limit: int = MAX_EXCERPT_BYTES) -> tuple[str, bool]:
    """Return a UTF-8-safe head/tail excerpt suitable for model context."""
    encoded = value.encode("utf-8")
    if len(encoded) <= limit:
        return value, False
    marker = b"\n... ASIP OUTPUT OMITTED; READ THE BLOB RESOURCE ...\n"
    room = max(0, limit - len(marker))
    head = encoded[: room // 2]
    tail = encoded[-(room - len(head)) :] if room else b""
    return (head + marker + tail).decode("utf-8", errors="replace"), True


@dataclass
class SocketReply:
    response: dict[str, Any]
    frames: list[dict[str, Any]] = field(default_factory=list)


class UnixClient:
    """One-request ASIP client used by the CLI and protocol adapters."""

    def __init__(self, socket_path: str = PRIVILEGED_SOCKET):
        self.socket_path = socket_path

    def call(
        self,
        request: dict[str, Any],
        on_stream: Callable[[str, str], None] | None = None,
        *,
        retain_frames: bool = False,
    ) -> SocketReply:
        payload = dict(request)
        payload.setdefault("schema_version", SCHEMA_VERSION)
        # Socket-activated systemd listeners retain queued connections while
        # the daemon restarts. The server uses this timestamp to reject an old
        # request that was left behind after its caller stopped waiting.
        payload["client_sent_at"] = time.time()
        raw = (json.dumps(payload, separators=(",", ":")) + "\n").encode()
        if len(raw) > MAX_REQUEST_BYTES:
            raise ValueError("request exceeds the ASIP protocol limit")

        frames: list[dict[str, Any]] = []
        response: dict[str, Any] | None = None
        pending = b""
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
            conn.connect(self.socket_path)
            conn.sendall(raw)
            while response is None:
                chunk = conn.recv(65536)
                if not chunk:
                    break
                pending += chunk
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    if not line:
                        continue
                    frame = json.loads(line)
                    if "stream" in frame:
                        if retain_frames:
                            frames.append(frame)
                        if on_stream:
                            on_stream(frame["stream"], frame.get("data", ""))
                    else:
                        response = normalize_response(frame)
                        break
        if response is None:
            raise ConnectionError("ASIP daemon closed the socket without a response")
        return SocketReply(response=response, frames=frames)

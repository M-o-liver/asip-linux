#!/usr/bin/env python3
"""asipd: the one privileged execution path on an ASIP machine.

Connecting to /run/asip/sock with group asip is root-equivalent: the
caller can submit arbitrary root commands. /run/asip/read.sock
(asip-read) cannot execute commands or append journal records. Unix
socket DAC is the authorization boundary. ASIP is not a sandbox.
"""

import datetime as dt
import codecs
import grp
import hashlib
import json
import math
import os
import pathlib
import platform
import pwd
import re
import selectors
import signal
import shutil
import stat
import subprocess
import threading
import time
import uuid

if __package__ in (None, ""):
    import sys
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from core.protocol import (
    MAX_REQUEST_BYTES,
    SCHEMA_VERSION,
    VERSION,
    excerpt,
    is_read_only,
    normalize_response,
    structured_error,
)
from core.facts import (
    collect_fact,
    fact_disk,
    fact_kernel,
    fact_kmod,
    fact_path,
    fact_pkg,
    fact_unit,
    observation_name as _observation_name,
)
from core import maintenance
from core.maintenance import MAINTENANCE_NAMES

SOCKET = "/run/asip/sock"
READ_SOCKET = "/run/asip/read.sock"
STATE = pathlib.Path("/var/lib/asip")
JOURNAL = STATE / "journal.jsonl"
BLOBS = STATE / "blobs"
MACHINE = pathlib.Path("/etc/asip/MACHINE.md")
PROJECTS = pathlib.Path("/etc/asip/projects.md")
DRIFT_DECISIONS = pathlib.Path("/etc/asip/drift.md")
ACCESS_DIR = STATE / "access"
MAX_REQUEST = MAX_REQUEST_BYTES
HOLD_KINDS = ("reboot_window", "operator", "predecessor", "deferred")
OPERATION_TERMINAL_STATES = frozenset(
    ("finished", "failed", "detached", "skipped", "interrupted")
)
OPERATOR_QUESTIONS_SURFACE = {
    "application": "ASIP",
    "view": "computer",
    "section": "operator_questions",
}
ACCESS_SURFACE = {
    "application": "ASIP",
    "view": "settings",
    "section": "connected_services",
}
ASK_GATE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
ASK_CHOICE = re.compile(r"^[a-z][a-z0-9-]{0,23}$")
ASK_MAX_QUESTION = 280
ASK_MAX_CANNOT = 500
ASK_MAX_NOTE = 2000
ASK_MAX_UNANSWERED = 8
ASK_MAX_PER_CHANGE = 3
ASK_FRESH_HOURS = 12
ACCESS_NAME = re.compile(r"^[a-z][a-z0-9._-]{0,63}$")
ACCESS_ENV = re.compile(r"^[A-Z_][A-Z0-9_]{0,63}$")
ACCESS_MAX_LABEL = 120
ACCESS_MAX_VALUE = 65536
HOLD_KIND_WHY = {
    "reboot_window": "The work is justified but needs an operator reboot window.",
    "operator": "The work is justified but needs explicit operator approval.",
    "predecessor": "Another named change or condition must happen first.",
    "deferred": "The work is intentionally deferred until a stated condition.",
}
SERIAL_LOCK = threading.RLock()
JOURNAL_LOCK = threading.RLock()
# A synchronous root command owns the mutation lane until it exits. Keep that
# ownership bounded so a lost client, a child waiting on ASIP, or a command
# that never returns cannot wedge every later administrative request forever.
COMMAND_TIMEOUT_SECONDS = 15 * 60
COMMAND_TERMINATE_GRACE_SECONDS = 5
SOCKET_REQUEST_TIMEOUT_SECONDS = 10.0
SERIAL_LANE_WAIT_SECONDS = 5.0
MAX_QUEUED_REQUEST_AGE_SECONDS = 60.0
ACCESS_USE_TIMEOUT_SECONDS = 5 * 60


def asip_gid():
    return grp.getgrnam("asip").gr_gid


def asip_read_gid():
    return grp.getgrnam("asip-read").gr_gid


def product_versions(request):
    """Distinguish this daemon (installed) from the calling client/source."""
    client = None
    payload = request.get("client")
    if isinstance(payload, dict) and isinstance(payload.get("version"), str):
        client = payload["version"] or None
    return {
        "client_version": client,
        "installed_version": VERSION,
        "installed_source": "live-daemon",
        "match": (None if not client else client == VERSION),
    }


def fail(message, exit_code=64):
    return structured_error("invalid_request", message, exit_code=exit_code)


def request_metadata(request):
    """Journal useful request provenance without treating it as identity."""
    fields = {"schema_version": SCHEMA_VERSION}
    if request.get("request_key"):
        fields["request_key"] = request["request_key"]
    if request.get("standalone_reason"):
        fields["standalone_reason"] = request["standalone_reason"]
    if request.get("transport"):
        fields["transport"] = request["transport"]
    client = request.get("client")
    if client:
        fields["client"] = client
    trace = request.get("trace")
    if trace:
        fields["trace"] = trace
    return fields


def record_for(request, **fields):
    record = request_metadata(request)
    record.update(fields)
    return record


def validate_envelope(request):
    if not isinstance(request, dict):
        raise ValueError("request must be a JSON object")
    version = request.get("schema_version", 0)
    if not isinstance(version, int) or version not in (0, SCHEMA_VERSION):
        raise ValueError("unsupported schema_version; install a matching ASIP client")
    key = request.get("request_key")
    if key is not None and (not isinstance(key, str) or not key.strip() or len(key) > 128):
        raise ValueError("request_key must be a non-empty string of at most 128 characters")
    standalone = request.get("standalone_reason")
    if standalone is not None and (
        not isinstance(standalone, str) or not standalone.strip() or len(standalone) > 500
    ):
        raise ValueError("standalone_reason must be a concise non-empty string")
    if request.get("change_id") and standalone:
        raise ValueError("use either change_id or standalone_reason, not both")
    client = request.get("client")
    if client is not None and (
        not isinstance(client, dict)
        or not isinstance(client.get("name"), str)
        or not isinstance(client.get("version"), str)
    ):
        raise ValueError("client must contain string name and version fields")
    sent_at = request.get("client_sent_at")
    if sent_at is not None:
        try:
            finite_timestamp = math.isfinite(sent_at)
        except (OverflowError, TypeError):
            finite_timestamp = False
        if isinstance(sent_at, bool) or not isinstance(sent_at, (int, float)) \
                or not finite_timestamp:
            raise ValueError("client_sent_at must be a Unix timestamp")
        current_time = time.time()
        if sent_at > current_time + 5:
            raise ValueError("client_sent_at cannot be in the future")
        if current_time - sent_at > MAX_QUEUED_REQUEST_AGE_SECONDS:
            raise StaleRequestError()


class StaleRequestError(ValueError):
    """A client request waited too long before the daemon could accept it."""

    def __init__(self):
        super().__init__(
            "request waited longer than %s seconds before ASIP could accept it"
            % MAX_QUEUED_REQUEST_AGE_SECONDS
        )


def validate_intent(request):
    """Require an explicit durable intent for every state-changing request."""
    if is_read_only(request):
        return
    if request.get("op") == "change":
        # Change lifecycle calls carry their intent or change ID in argv.
        return
    if request.get("op") == "note":
        if not request.get("change_id"):
            raise ValueError("note requires an open change_id")
        return
    if request.get("op") == "ask" and request.get("action") in ("answer", "supersede"):
        return
    if request.get("op") == "access" and request.get("action") in ("provision", "dismiss", "remove"):
        return
    if request.get("change_id"):
        validate_change(request)
        return
    if request.get("standalone_reason"):
        return
    raise ValueError(
        "mutation requires an open change_id or explicit standalone_reason; "
        "start a change or use --standalone for isolated work"
    )


def set_group_access(path, mode):
    os.chmod(path, mode)
    os.chown(path, 0, asip_gid())


def ensure_state():
    STATE.mkdir(mode=0o750, parents=True, exist_ok=True)
    BLOBS.mkdir(mode=0o750, exist_ok=True)
    set_group_access(STATE, 0o750)
    set_group_access(BLOBS, 0o750)


def prepare_state(read_only):
    if read_only:
        if not STATE.is_dir():
            raise SystemExit("ASIP state is missing; run the privileged installer first")
        return
    ensure_state()
    reconcile_interrupted_operations()


def fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def blob(data):
    """Content-address output. The journal remains useful without a size race."""
    ensure_state()
    digest = hashlib.sha256(data).hexdigest()
    path = BLOBS / digest
    if not path.exists():
        temporary = BLOBS / (".tmp-" + str(uuid.uuid4()))
        try:
            with temporary.open("xb") as handle:
                set_group_access(temporary, 0o640)
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
            fsync_directory(BLOBS)
        finally:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass
    return digest


def append_record(record):
    with JOURNAL_LOCK:
        ensure_state()
        journal_existed = JOURNAL.exists()
        flags = os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW
        descriptor = os.open(JOURNAL, flags, 0o640)
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode):
                raise ValueError("ASIP journal must be a regular file")
            if os.geteuid() == 0:
                os.fchown(descriptor, 0, asip_gid())
            os.fchmod(descriptor, 0o640)

            # A disk-full error can leave a torn final JSON line. Remove only
            # that incomplete tail before appending, so it cannot merge with
            # and hide later audit records. Earlier complete records remain.
            size = info.st_size
            if size and os.pread(descriptor, 1, size - 1) != b"\n":
                cursor = size
                truncate_at = 0
                while cursor:
                    start = max(0, cursor - 65536)
                    block = os.pread(descriptor, cursor - start, start)
                    newline = block.rfind(b"\n")
                    if newline >= 0:
                        truncate_at = start + newline + 1
                        break
                    cursor = start
                os.ftruncate(descriptor, truncate_at)
                os.fsync(descriptor)

            payload = (json.dumps(record, separators=(",", ":")) + "\n").encode("utf-8")
            offset = 0
            while offset < len(payload):
                try:
                    written = os.write(descriptor, payload[offset:])
                except InterruptedError:
                    continue
                if written <= 0:
                    raise OSError("ASIP journal append made no progress")
                offset += written
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        if not journal_existed:
            fsync_directory(STATE)


def journal_records():
    with JOURNAL_LOCK:
        if not JOURNAL.exists():
            return []
        records = []
        for line in JOURNAL.read_text(encoding="utf-8").splitlines():
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return records


def reconcile_interrupted_operations():
    """Close journal starts left behind by a daemon/process interruption.

    Command effects can be partial, so this records an uncertain outcome and
    never retries a mutation automatically. Detached access processes are
    included because a crash between Popen and the detached record leaves no
    reliable proof of their state.
    """
    records = journal_records()
    by_id = {}
    for record in records:
        if isinstance(record.get("id"), str):
            by_id.setdefault((record.get("op"), record["id"]), []).append(record)

    interrupted = []
    for record in records:
        if record.get("state") != "started" or record.get("op") in ("request", "change"):
            continue
        events = by_id.get((record.get("op"), record.get("id")), [])
        if any(event.get("state") in OPERATION_TERMINAL_STATES for event in events):
            continue
        event = dict(record)
        event.update({
            "at": now(),
            "state": "interrupted",
            "outcome_unknown": True,
            "error": "daemon restarted before the operation reached a terminal record; effects may be partial",
        })
        interrupted.append(event)

    # Finish the operation records first. Then make each abandoned idempotency
    # claim replay a stable uncertainty error rather than request_in_progress.
    for event in interrupted:
        append_record(event)

    records.extend(interrupted)
    terminal_request_ids = {
        record.get("id") for record in records
        if record.get("op") == "request" and record.get("state") != "started"
    }
    for record in records:
        if (record.get("op") != "request" or record.get("state") != "started"
                or record.get("id") in terminal_request_ids):
            continue
        linked = next((item for item in reversed(records)
                       if item.get("request_key") == record.get("request_key")
                       and item.get("op") != "request"), None)
        operation_id = linked.get("id") if linked else None
        response = structured_error(
            "operation_interrupted",
            "ASIP restarted before this request was recorded as complete; the change may have partially happened",
            exit_code=70,
            remediation="inspect the operation and actual system state before deciding whether to retry",
            details={"operation_id": operation_id, "request_id": record.get("id")},
        )
        response["id"] = operation_id or record.get("id", "")
        response["operation_id"] = operation_id
        append_record(dict(record, at=now(), state="finished", response=response,
                           operation_id=operation_id))


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def attach_change(record, request):
    change_id = request.get("change_id")
    if change_id:
        record["change_id"] = change_id
    return record


def change_start_record(change_id):
    return next((record for record in journal_records()
                 if record.get("id") == change_id
                 and record.get("op") == "change"
                 and record.get("action") == "start"), None)


def validate_change(request, change_id=None, require_open=True):
    change_id = change_id if change_id is not None else request.get("change_id")
    if change_id is None:
        return None
    if not isinstance(change_id, str) or not change_id:
        raise ValueError("change id must be a non-empty string")
    start = change_start_record(change_id)
    if start is None:
        raise ValueError("change not found")
    if start.get("uid") != request.get("_peer_uid", -1):
        raise ValueError("change belongs to another user")
    if require_open and any(record.get("op") == "change"
                            and record.get("change_id") == change_id
                            and record.get("action") in ("finish", "fail", "supersede")
                            for record in journal_records()):
        raise ValueError("change is already closed")
    if require_open and change_status(change_id) == "held" and not hold_allows(request):
        raise ValueError(
            "change is held; release it before mutating, or fail it. "
            "Inspect with: asip --json change show %s" % change_id
        )
    return start


def maintenance_completed_tasks(record):
    return maintenance.completed_tasks(record)


def maintenance_status():
    return maintenance.status(journal_records())


def maintenance_list():
    return maintenance.list_text(maintenance_status())


def maintenance_history_data(open_only=False):
    return maintenance.history_data(journal_records(), open_only=open_only)


def maintenance_history(open_only=False):
    projected = maintenance_history_data(open_only=open_only)
    return maintenance.history_text(projected, open_only=open_only)


def maintenance_request(request, ident, started):
    action = request.get("action") or "list"
    argv = request.get("argv", [])
    if not isinstance(argv, list) or not all(isinstance(arg, str) for arg in argv):
        raise ValueError("maintenance arguments must be strings")
    if action == "list":
        if argv:
            raise ValueError("maintenance list takes no arguments")
        output = maintenance_list()
        return {"id": ident, "exit": 0, "stdout": output, "stderr": "",
                "data": maintenance_status(),
                "duration_ms": int((time.monotonic() - started) * 1000)}
    if action in ("history", "open"):
        if argv:
            raise ValueError("maintenance %s takes no arguments" % action)
        output = maintenance_history(open_only=(action == "open"))
        return {"id": ident, "exit": 0, "stdout": output, "stderr": "",
                "data": maintenance_history_data(open_only=(action == "open")),
                "duration_ms": int((time.monotonic() - started) * 1000)}
    if action == "omit":
        if len(argv) < 2 or argv[0] not in MAINTENANCE_NAMES:
            raise ValueError("maintenance omit needs a known task and a reason")
        reason = " ".join(argv[1:]).strip()
        if not reason:
            raise ValueError("maintenance omit needs a reason")
        record = record_for(request, id=ident, at=now(), uid=request.get("_peer_uid", -1),
                            op="maintenance", action="omit", task=argv[0], reason=reason)
        append_record(attach_change(record, request))
        return {"id": ident, "exit": 0, "stdout": "", "stderr": "",
                "data": {"task": argv[0], "action": "omit", "reason": reason},
                "duration_ms": int((time.monotonic() - started) * 1000)}
    if action == "unomit":
        if len(argv) != 1 or argv[0] not in MAINTENANCE_NAMES:
            raise ValueError("maintenance unomit needs a known task")
        record = record_for(request, id=ident, at=now(), uid=request.get("_peer_uid", -1),
                            op="maintenance", action="unomit", task=argv[0])
        append_record(attach_change(record, request))
        return {"id": ident, "exit": 0, "stdout": "", "stderr": "",
                "data": {"task": argv[0], "action": "unomit"},
                "duration_ms": int((time.monotonic() - started) * 1000)}
    if action == "policy":
        if len(argv) != 2 or argv[0] not in MAINTENANCE_NAMES:
            raise ValueError("maintenance policy needs a known task and cadence in days")
        try:
            cadence = int(argv[1])
        except ValueError:
            raise ValueError("maintenance cadence must be a positive number of days")
        if cadence <= 0:
            raise ValueError("maintenance cadence must be a positive number of days")
        record = record_for(request, id=ident, at=now(), uid=request.get("_peer_uid", -1),
                            op="maintenance", action="policy", task=argv[0],
                            cadence_days=cadence)
        append_record(attach_change(record, request))
        return {"id": ident, "exit": 0, "stdout": "", "stderr": "",
                "duration_ms": int((time.monotonic() - started) * 1000)}
    if action == "backfill":
        if len(argv) < 3 or argv[0] not in MAINTENANCE_NAMES:
            raise ValueError("maintenance backfill needs a known task, ISO date, and note")
        try:
            observed = dt.datetime.fromisoformat(argv[1].replace("Z", "+00:00"))
        except ValueError:
            raise ValueError("maintenance backfill date must be ISO-8601")
        if observed.tzinfo is None:
            observed = observed.replace(tzinfo=dt.timezone.utc)
        if observed > dt.datetime.now(dt.timezone.utc):
            raise ValueError("maintenance backfill date cannot be in the future")
        record = record_for(request, id=ident, at=now(), uid=request.get("_peer_uid", -1),
                            op="maintenance", action="backfill", task=argv[0],
                            observed_at=observed.isoformat(), reason=" ".join(argv[2:]))
        append_record(attach_change(record, request))
        return {"id": ident, "exit": 0, "stdout": "", "stderr": "",
                "duration_ms": int((time.monotonic() - started) * 1000)}
    if action == "start":
        if not argv or any(task not in MAINTENANCE_NAMES for task in argv):
            raise ValueError("maintenance start needs known task names")
        record = record_for(request, id=ident, at=now(),
                            uid=request.get("_peer_uid", -1), op="maintenance",
                            action="start", tasks=argv)
        append_record(attach_change(record, request))
        guidance = ("Maintenance session %s started for: %s\n"
                    "Perform these roles on this host now. Read /etc/asip/MACHINE.md first. "
                    "Use appropriate native system tools, recommend useful missing tools, "
                    "record resulting changes through ASIP, then run maintenance finish or fail.\n" %
                    (ident, ", ".join(argv)))
        return {"id": ident, "exit": 0, "stdout": ident + "\n", "stderr": guidance,
                "data": {"session": ident, "action": "start", "tasks": list(argv)},
                "duration_ms": int((time.monotonic() - started) * 1000)}
    if action not in ("finish", "fail"):
        raise ValueError(
            "maintenance action must be list, history, open, policy, backfill, "
            "omit, unomit, start, finish, or fail"
        )
    if len(argv) < 2:
        raise ValueError("maintenance %s needs a session id and summary" % action)
    session = argv[0]
    start_record = next((record for record in journal_records()
                         if record.get("id") == session
                         and record.get("op") == "maintenance"
                         and record.get("action") == "start"), None)
    if start_record is None:
        raise ValueError("maintenance session not found")
    if any(record.get("op") == "maintenance"
           and record.get("session") == session
           and record.get("action") in ("finish", "fail")
           for record in journal_records()):
        raise ValueError("maintenance session is already closed")
    started_tasks = list(start_record.get("tasks") or [])
    covered_text = request.get("covered", "")
    if not isinstance(covered_text, str):
        raise ValueError("covered tasks must be a comma-separated string")
    covered = [task for task in covered_text.split(",") if task]
    if any(task not in MAINTENANCE_NAMES for task in covered):
        raise ValueError("covered contains an unknown maintenance task")
    if any(task not in started_tasks for task in covered):
        raise ValueError("covered tasks must be a subset of the started session")
    completed = covered if covered else started_tasks
    record = record_for(request, id=ident, at=now(),
                        uid=request.get("_peer_uid", -1), op="maintenance",
                        action=action, session=session,
                        tasks=started_tasks, reason=" ".join(argv[1:]))
    if action == "finish":
        record["covered"] = covered
        record["completed"] = completed
    append_record(attach_change(record, request))
    return {"id": ident, "exit": 0, "stdout": "", "stderr": "",
            "data": {"session": session, "action": action, "tasks": started_tasks,
                     "completed": completed if action == "finish" else []},
            "duration_ms": int((time.monotonic() - started) * 1000)}


def hold_allows(request):
    """Held work still accepts inspect, notes, verification, release, and fail."""
    op = request.get("op")
    action = request.get("action")
    if op == "change" and action in ("hold", "release", "fail", "show", "status"):
        return True
    if op in ("note", "log", "context", "brief", "doctor", "summary", "recovery"):
        return True
    if op == "verify" and action in ("list", "pass", "fail"):
        return True
    if op == "ask" and action in ("pose", "list", "show"):
        return True
    return False


def change_hold_record(change_id, records=None):
    records = records if records is not None else journal_records()
    if change_status(change_id, records) != "held":
        return None
    return next((record for record in reversed(records)
                 if record.get("op") == "change"
                 and record.get("change_id") == change_id
                 and record.get("action") == "hold"), None)


def hold_payload(record):
    if not record:
        return None
    return {
        "kind": record.get("kind") or "deferred",
        "reason": record.get("reason") or record.get("summary") or "",
        "unblock": record.get("unblock") or "",
        "predecessor": record.get("predecessor"),
        "observations": list(record.get("observations") or []),
        "held_at": record.get("at"),
        "hold_id": record.get("id"),
    }


def parse_snapper_backend_id(text):
    if not isinstance(text, str):
        return None
    digits = [word for word in text.replace("\n", " ").split() if word.isdigit()]
    return digits[-1] if digits else None


def recovery_identity(record):
    handle = record.get("id")
    backend = record.get("snapshotter") or "none"
    backend_id = record.get("backend_id")
    if backend_id is None and record.get("stdout_blob"):
        path = BLOBS / record["stdout_blob"]
        if path.is_file():
            backend_id = parse_snapper_backend_id(path.read_text(encoding="utf-8", errors="replace"))
    return {
        "recovery_handle": handle,
        "backend": backend,
        "backend_id": backend_id,
        "rollback_accepts": "recovery_handle",
        "rollback": ("asip rollback %s" % handle) if backend == "snapper" and handle else None,
        "change_id": record.get("change_id"),
        "operation_id": handle,
        "at": record.get("at"),
        "reason": excerpt(record.get("reason", ""), 160)[0],
    }




def facts_catalog(request):
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": now(),
        "available": ["kernel", "disk:/", "pkg:NAME", "unit:NAME", "unit-user:NAME",
                      "path:/ABS", "kmod:NAME"],
        "facts": {
            "kernel": fact_kernel(),
            "disk": fact_disk("/"),
        },
        "note": "Query a named fact with asip --json facts get SPEC. Held work is asip --json change show ID.",
    }


def facts_request(request, ident, started):
    action = request.get("action") or "catalog"
    argv = request.get("argv") or []
    if action in ("catalog", "list") and not argv:
        data = facts_catalog(request)
    elif action == "get":
        if len(argv) < 1:
            raise ValueError("facts get needs a spec such as kernel, disk:/, pkg:bash")
        spec = argv[0]
        if len(argv) == 2 and ":" not in spec:
            spec = "%s:%s" % (spec, argv[1])
        elif spec == "disk" and len(argv) == 1:
            spec = "disk:/"
        data = {"spec": spec, "generated_at": now(), "value": collect_fact(spec, request)}
    elif action == "check-hold":
        return fail("facts check-hold was removed; use asip --json change show ID")
    else:
        return fail("facts action must be catalog or get")
    return {"id": ident, "exit": 0, "stdout": json.dumps(data, separators=(",", ":")) + "\n",
            "stderr": "", "data": data,
            "duration_ms": int((time.monotonic() - started) * 1000)}


def current_boot_id():
    path = pathlib.Path("/proc/sys/kernel/random/boot_id")
    try:
        return path.read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def ask_gate_key(gate, change_id=None, standalone=None):
    if change_id:
        return "%s:%s" % (gate, change_id)
    return "%s:standalone:%s" % (gate, (standalone or "none").strip()[:80])


def ask_records(records=None):
    records = records if records is not None else journal_records()
    return [record for record in records if record.get("op") == "ask"]


def ask_answer_for(question_id, records=None):
    for record in reversed(ask_records(records)):
        if record.get("action") == "answer" and record.get("question_id") == question_id:
            return record
        if record.get("action") == "supersede" and record.get("question_id") == question_id:
            return record
    return None


def ask_fresh(pose, answer):
    if not answer or answer.get("action") != "answer":
        return False
    if pose.get("gate") == "reboot_window":
        boot = current_boot_id()
        if boot and answer.get("boot_id") and answer.get("boot_id") != boot:
            return False
    try:
        stamped = dt.datetime.fromisoformat(str(answer.get("at", "")).replace("Z", "+00:00"))
        if stamped.tzinfo is None:
            stamped = stamped.replace(tzinfo=dt.timezone.utc)
    except ValueError:
        return False
    return dt.datetime.now(dt.timezone.utc) - stamped < dt.timedelta(hours=ASK_FRESH_HOURS)


def ask_status(pose, records=None):
    records = records if records is not None else journal_records()
    closer = ask_answer_for(pose.get("id"), records)
    if closer is None:
        return "unanswered"
    if closer.get("action") == "supersede":
        return "superseded"
    return "answered"


def ask_asked_by(question_id, records=None):
    asked = []
    for record in ask_records(records):
        if record.get("id") == question_id and record.get("action") == "pose":
            asked.append({"uid": record.get("uid"), "at": record.get("at"),
                          "client": record.get("client")})
        elif record.get("action") == "also_asked" and record.get("question_id") == question_id:
            asked.append({"uid": record.get("uid"), "at": record.get("at"),
                          "client": record.get("client")})
    return asked


def ask_payload(pose, records=None):
    records = records if records is not None else journal_records()
    closer = ask_answer_for(pose.get("id"), records)
    status = ask_status(pose, records)
    answer = None
    if closer and closer.get("action") == "answer":
        answer = {
            "choice": closer.get("choice"),
            "note": closer.get("note") or "",
            "answered_at": closer.get("at"),
            "answered_by": {"uid": closer.get("uid"), "transport": closer.get("transport")},
            "boot_id": closer.get("boot_id"),
            "answer_id": closer.get("id"),
            "fresh": ask_fresh(pose, closer),
        }
    hold = None
    if pose.get("change_id"):
        try:
            hold = hold_payload(change_hold_record(pose.get("change_id"), records))
        except Exception:
            hold = None
    return {
        "question_id": pose.get("id"),
        "gate": pose.get("gate"),
        "gate_key": pose.get("gate_key"),
        "status": status,
        "question": pose.get("question"),
        "cannot": pose.get("cannot"),
        "choices": list(pose.get("choices") or []),
        "free_text": bool(pose.get("free_text")),
        "change_id": pose.get("change_id"),
        "hold": hold,
        "posed_at": pose.get("at"),
        "posed_by": {"uid": pose.get("uid"), "client": pose.get("client")},
        "asked_by": ask_asked_by(pose.get("id"), records),
        "answer": answer,
        "superseded_by": closer.get("superseded_by") if closer and closer.get("action") == "supersede" else None,
        "human_surface": dict(OPERATOR_QUESTIONS_SURFACE),
        "effects_on_answer": "none — does not reboot or release holds",
    }


def operator_questions(records=None):
    records = records if records is not None else journal_records()
    poses = [record for record in ask_records(records) if record.get("action") == "pose"]
    unanswered = []
    recent_answered = []
    for pose in poses:
        payload = ask_payload(pose, records)
        if payload["status"] == "unanswered":
            unanswered.append(payload)
        elif payload["status"] == "answered":
            recent_answered.append(payload)
    return {
        "unanswered": unanswered,
        "recent_answered": recent_answered[-8:],
        "pending": len(unanswered),
        "human_surface": dict(OPERATOR_QUESTIONS_SURFACE),
    }


def ask_request(request, ident, started):
    action = request.get("action") or "list"
    argv = request.get("argv") or []
    records = journal_records()
    if action in ("list", "pending"):
        data = operator_questions(records)
        if action == "pending":
            data = {
                "unanswered": data["unanswered"],
                "pending": data["pending"],
                "human_surface": dict(OPERATOR_QUESTIONS_SURFACE),
            }
        return {"id": ident, "exit": 0, "stdout": json.dumps(data, separators=(",", ":")) + "\n",
                "stderr": "", "data": data,
                "duration_ms": int((time.monotonic() - started) * 1000)}
    if action == "show":
        if len(argv) != 1:
            raise ValueError("ask show needs one question id")
        pose = next((record for record in records
                     if record.get("id") == argv[0] and record.get("op") == "ask"
                     and record.get("action") == "pose"), None)
        if pose is None:
            raise ValueError("operator question not found")
        data = ask_payload(pose, records)
        return {"id": ident, "exit": 0, "stdout": json.dumps(data, separators=(",", ":")) + "\n",
                "stderr": "", "data": data,
                "duration_ms": int((time.monotonic() - started) * 1000)}
    if action == "pose":
        if request.get("change_id"):
            validate_change(request)
        gate = request.get("gate") or ""
        if not isinstance(gate, str) or not ASK_GATE.match(gate):
            raise ValueError("ask pose needs --gate matching [a-z][a-z0-9_]{0,31}")
        cannot = request.get("cannot") or ""
        if not isinstance(cannot, str) or not cannot.strip() or len(cannot) > ASK_MAX_CANNOT:
            raise ValueError("ask pose needs --cannot (why the machine cannot answer), ≤ %s chars" % ASK_MAX_CANNOT)
        question = " ".join(argv).strip() if argv else ""
        if not question or len(question) > ASK_MAX_QUESTION:
            raise ValueError("ask pose needs a question of at most %s characters" % ASK_MAX_QUESTION)
        choices = request.get("choices") or []
        if not isinstance(choices, list) or not all(isinstance(item, str) for item in choices):
            raise ValueError("choices must be strings")
        free_text = bool(request.get("free_text"))
        if free_text:
            if choices:
                raise ValueError("free-text questions cannot also declare --choices")
        else:
            if len(choices) < 2 or len(choices) > 5:
                raise ValueError("ask pose needs 2–5 --choices, or --free-text")
            if any(not ASK_CHOICE.match(item) for item in choices):
                raise ValueError("choice tokens must match [a-z][a-z0-9-]{0,23}")
        change_id = request.get("change_id")
        gate_key = ask_gate_key(gate, change_id, request.get("standalone_reason"))
        overview = operator_questions(records)
        for payload in overview["unanswered"]:
            if payload.get("gate_key") == gate_key:
                also = record_for(request, id=ident, at=now(), uid=request.get("_peer_uid", -1),
                                  op="ask", action="also_asked", question_id=payload["question_id"],
                                  gate=gate, gate_key=gate_key)
                append_record(attach_change(also, request))
                payload = ask_payload(next(record for record in journal_records()
                                           if record.get("id") == payload["question_id"]),
                                      journal_records())
                payload["created"] = False
                return {"id": ident, "exit": 0,
                        "stdout": json.dumps(payload, separators=(",", ":")) + "\n",
                        "stderr": "", "data": payload,
                        "duration_ms": int((time.monotonic() - started) * 1000)}
        for payload in overview["recent_answered"]:
            if payload.get("gate_key") == gate_key and payload.get("answer") and payload["answer"].get("fresh"):
                payload = dict(payload)
                payload["created"] = False
                return {"id": ident, "exit": 0,
                        "stdout": json.dumps(payload, separators=(",", ":")) + "\n",
                        "stderr": "", "data": payload,
                        "duration_ms": int((time.monotonic() - started) * 1000)}
        if overview["pending"] >= ASK_MAX_UNANSWERED:
            raise ValueError("machine already has %s unanswered operator questions" % ASK_MAX_UNANSWERED)
        if change_id:
            same = sum(1 for item in overview["unanswered"] if item.get("change_id") == change_id)
            if same >= ASK_MAX_PER_CHANGE:
                raise ValueError("change already has %s unanswered operator questions" % ASK_MAX_PER_CHANGE)
        record = record_for(request, id=ident, at=now(), uid=request.get("_peer_uid", -1),
                            op="ask", action="pose", gate=gate, gate_key=gate_key,
                            question=question, cannot=cannot.strip(),
                            choices=choices, free_text=free_text)
        append_record(attach_change(record, request))
        data = ask_payload(record, journal_records())
        data["created"] = True
        return {"id": ident, "exit": 0,
                "stdout": json.dumps(data, separators=(",", ":")) + "\n",
                "stderr": "", "data": data,
                "duration_ms": int((time.monotonic() - started) * 1000)}
    if action == "answer":
        if len(argv) != 1:
            raise ValueError("ask answer needs a question id")
        pose = next((record for record in records
                     if record.get("id") == argv[0] and record.get("op") == "ask"
                     and record.get("action") == "pose"), None)
        if pose is None:
            raise ValueError("operator question not found")
        if ask_status(pose, records) != "unanswered":
            raise ValueError("operator question is already closed")
        note = request.get("note") or ""
        if not isinstance(note, str) or len(note) > ASK_MAX_NOTE:
            raise ValueError("answer note must be at most %s characters" % ASK_MAX_NOTE)
        if pose.get("free_text"):
            if not note.strip():
                raise ValueError("free-text questions need --note")
            choice = None
        else:
            choice = request.get("choice")
            if choice not in (pose.get("choices") or []):
                raise ValueError("choice must be one of: %s" % ", ".join(pose.get("choices") or []))
        record = record_for(request, id=ident, at=now(), uid=request.get("_peer_uid", -1),
                            op="ask", action="answer", question_id=pose["id"],
                            choice=choice, note=note.strip(),
                            transport=request.get("transport") or "cli",
                            boot_id=current_boot_id(),
                            released_hold=False, rebooted=False)
        append_record(attach_change(record, request) if request.get("change_id") else record)
        data = ask_payload(pose, journal_records())
        data["released_hold"] = False
        data["rebooted"] = False
        return {"id": ident, "exit": 0,
                "stdout": json.dumps(data, separators=(",", ":")) + "\n",
                "stderr": "", "data": data,
                "duration_ms": int((time.monotonic() - started) * 1000)}
    if action == "supersede":
        if len(argv) < 2:
            raise ValueError("ask supersede needs a question id and reason")
        pose = next((record for record in records
                     if record.get("id") == argv[0] and record.get("op") == "ask"
                     and record.get("action") == "pose"), None)
        if pose is None:
            raise ValueError("operator question not found")
        if ask_status(pose, records) != "unanswered":
            raise ValueError("operator question is already closed")
        record = record_for(request, id=ident, at=now(), uid=request.get("_peer_uid", -1),
                            op="ask", action="supersede", question_id=pose["id"],
                            reason=" ".join(argv[1:]), superseded_by=ident)
        append_record(attach_change(record, request) if request.get("change_id") else record)
        data = ask_payload(pose, journal_records())
        return {"id": ident, "exit": 0,
                "stdout": json.dumps(data, separators=(",", ":")) + "\n",
                "stderr": "", "data": data,
                "duration_ms": int((time.monotonic() - started) * 1000)}
    raise ValueError("ask action must be pose, list, show, answer, or supersede")


def change_status(change_id, records=None):
    records = records if records is not None else journal_records()
    terminal = next((record for record in reversed(records)
                     if record.get("op") == "change"
                     and record.get("change_id") == change_id
                     and record.get("action") in ("finish", "fail", "supersede")), None)
    if terminal:
        return {"finish": "finished", "fail": "failed",
                "supersede": "superseded"}[terminal.get("action")]
    latest_gate = next((record for record in reversed(records)
                        if record.get("op") == "change"
                        and record.get("change_id") == change_id
                        and record.get("action") in ("hold", "release")), None)
    if latest_gate and latest_gate.get("action") == "hold":
        return "held"
    return "open"


def _hold_observation_values(specs, request):
    values = []
    for spec in specs:
        try:
            values.append({"spec": spec, "ok": True, "value": collect_fact(spec, request)})
        except (OSError, ValueError) as exc:
            values.append({"spec": spec, "ok": False, "error": str(exc)})
    return values


def _enrich_hold(hold, records, request=None):
    if not hold:
        return None
    hold = dict(hold)
    predecessor = hold.get("predecessor")
    if predecessor:
        try:
            hold["predecessor_status"] = change_status(predecessor, records)
        except (ValueError, TypeError):
            hold["predecessor_status"] = "unknown"
    else:
        hold["predecessor_status"] = None
    specs = list(hold.get("observations") or [])
    if not specs:
        hold["observation_values"] = []
        hold["observations_note"] = "No observation specs were recorded for this hold."
    elif request is None:
        hold["observation_values"] = []
        hold["observations_note"] = (
            "Observation specs are recorded; live values are filled on change show."
        )
    else:
        hold["observation_values"] = _hold_observation_values(specs, request)
        hold["observations_note"] = (
            "Live values for explicitly recorded --observe specs. "
            "Inspect only; ASIP does not release holds."
        )
    hold["asip_does_not_release"] = True
    hold["agent_judgment"] = (
        "ASIP does not compute whether this hold is unblocked. "
        "Compare this evidence and decide whether to release, fail, or wait."
    )
    return hold


def change_payload(change_id, records=None, request=None):
    records = records if records is not None else journal_records()
    start = next((record for record in records
                  if record.get("id") == change_id
                  and record.get("op") == "change"
                  and record.get("action") == "start"), None)
    if start is None:
        raise ValueError("change not found")
    related = [record for record in records
               if record.get("id") == change_id or record.get("change_id") == change_id]
    status = change_status(change_id, records)
    terminal = next((record for record in reversed(related)
                     if record.get("op") == "change"
                     and record.get("action") in ("finish", "fail", "supersede")), None)
    notes = [{"id": record.get("id"), "at": record.get("at"),
              "subject": record.get("subject", ""), "reason": record.get("reason", "")}
             for record in related if record.get("op") == "note"]
    operations = []
    for record in related:
        if record.get("op") in ("change", "note") or record.get("state") == "started":
            continue
        operations.append({
            "id": record.get("id"),
            "op": record.get("op"),
            "at": record.get("at"),
            "detail": (record.get("target") or " ".join(record.get("argv", []))
                       or record.get("subject") or record.get("reason", "")),
            "exit": record.get("exit"),
            "state": record.get("state"),
            "references": list(record.get("references") or []),
        })
    verifications = [{
        "id": record.get("id"),
        "result": record.get("result", "unknown"),
        "tool": record.get("tool", "unknown"),
        "at": record.get("at", "unknown"),
        "reason": record.get("reason", ""),
        "references": list(record.get("references") or []),
    } for record in related if record.get("op") == "verify"]
    if verifications:
        latest = verifications[-1]["result"]
        if latest == "fail":
            close_readiness = "latest_verification_fail"
        elif latest == "pass":
            close_readiness = "latest_verification_pass"
        else:
            close_readiness = "recorded"
    elif status == "open":
        close_readiness = "unverified"
    else:
        close_readiness = None
    snapshots = [record for record in related
                 if record.get("op") == "snap" and record.get("snapshotter") == "snapper"
                 and record.get("state") == "finished" and record.get("exit") == 0]
    recoveries = [recovery_identity(record) for record in snapshots]
    return {
        "change_id": change_id,
        "intent": start.get("intent", ""),
        "status": status,
        "started_at": start.get("at"),
        "uid": start.get("uid"),
        "outcome": terminal.get("summary") if terminal else None,
        "terminal_action": terminal.get("action") if terminal else None,
        "finished_at": terminal.get("at") if terminal else None,
        "superseded_by": terminal.get("superseded_by") if terminal and terminal.get("action") == "supersede" else None,
        "hold": _enrich_hold(hold_payload(change_hold_record(change_id, records)),
                             records, request),
        "notes": notes,
        "verifications": verifications,
        "close_readiness": close_readiness,
        "operations": operations,
        "recovery": {
            "snapshots": recoveries,
            "journal_snapshot_ids": [item["recovery_handle"] for item in recoveries],
            "rollback_accepts": "recovery_handle",
            "rollback": ("asip rollback %s" % recoveries[-1]["recovery_handle"]) if recoveries else None,
        },
        "operator_questions": [
            ask_payload(record, records)
            for record in records
            if record.get("op") == "ask" and record.get("action") == "pose"
            and record.get("change_id") == change_id
        ],
    }


def change_summary(change_id, records=None, request=None):
    data = change_payload(change_id, records=records, request=request)
    return format_change_summary(data)


def format_change_summary(data):
    lines = ["Change: %s" % data["change_id"],
             "Intent: %s" % data["intent"],
             "Status: %s" % data["status"]]
    if data["status"] == "held" and data.get("hold"):
        hold = data["hold"]
        lines.append("Hold: %s — %s" % (hold["kind"], hold["reason"]))
        lines.append("Unblocks when: %s" % hold["unblock"])
        if hold.get("predecessor"):
            lines.append("Predecessor: %s status=%s" % (
                hold["predecessor"], hold.get("predecessor_status") or "unknown"))
        specs = hold.get("observations") or []
        if not specs:
            lines.append("Observations: none recorded")
        else:
            lines.append("Observations:")
            values = {item.get("spec"): item for item in hold.get("observation_values") or []}
            for spec in specs:
                item = values.get(spec) or {}
                if item.get("ok"):
                    lines.append("  %s = %s" % (spec, excerpt(json.dumps(item.get("value"),
                                                                        separators=(",", ":"),
                                                                        sort_keys=True), 160)[0]))
                elif item.get("error"):
                    lines.append("  %s error: %s" % (spec, item["error"]))
                else:
                    lines.append("  %s (recorded)" % spec)
        if hold.get("observations_note"):
            lines.append(hold["observations_note"])
        questions = data.get("operator_questions") or []
        if not questions:
            lines.append("Operator questions: none linked to this change")
        else:
            lines.append("Operator questions:")
            for item in questions:
                answer = item.get("answer") or {}
                if item.get("status") == "answered" and answer:
                    lines.append("  %s  %s  choice=%s fresh=%s  ASIP" % (
                        item.get("status"), item.get("question"),
                        answer.get("choice"), answer.get("fresh")))
                else:
                    lines.append("  %s  %s  ASIP" % (
                        item.get("status"), item.get("question")))
        lines.append("ASIP does not decide release. Remaining judgment is the agent's.")
    if data["outcome"]:
        lines.append("Outcome: %s" % data["outcome"])
        if data["superseded_by"]:
            lines.append("Superseded by: %s" % data["superseded_by"])
    if data["notes"]:
        lines.append("Notes:")
        lines.extend("  %s — %s" % (note["subject"], note["reason"]) for note in data["notes"])
    if data["verifications"]:
        lines.append("Verifications on this change:")
        for record in data["verifications"]:
            evidence = ""
            if record["references"]:
                evidence = " evidence=%s" % ",".join(record["references"])
            lines.append("  %s  %s  %s  %s%s" %
                         (record["result"], record["tool"], record["at"], record["reason"], evidence))
        if data["close_readiness"] == "latest_verification_fail":
            lines.append("Close readiness: latest verification is fail; "
                         "`asip change finish` will still record success.")
        elif data["close_readiness"] == "latest_verification_pass":
            lines.append("Close readiness: latest verification is pass.")
        else:
            lines.append("Close readiness: verification recorded without a pass/fail result.")
    elif data["status"] == "open":
        lines.append("Verifications on this change: none")
        lines.append("Close readiness: unverified. `verify pass|fail TOOL NOTE` records the check result; "
                     "fail means the check was unsuccessful.")
    if data["operations"]:
        lines.append("Operations:")
        for record in data["operations"]:
            suffix = " exit=%s" % record["exit"] if record["exit"] is not None else ""
            if record["references"]:
                suffix += " evidence=%s" % ",".join(record["references"])
            lines.append("  %s  %s  %s%s" %
                         (record["id"] or "unknown", record["op"] or "unknown",
                          record["detail"], suffix))
    if data["recovery"]["snapshots"]:
        handles = ", ".join(item["recovery_handle"] for item in data["recovery"]["snapshots"])
        lines.append("Recovery: asip rollback accepts recovery_handle %s "
                     "(not the Snapper number)." % handles)
    else:
        lines.append("Recovery: no ASIP-managed rollback snapshot is recorded; use the noted paths, "
                     "configuration before blobs, ordinary version control, and MACHINE.md recovery policy.")
    return "\n".join(lines) + "\n"


def _group_names(gids):
    names = []
    for gid in gids:
        try:
            names.append(grp.getgrgid(int(gid)).gr_name)
        except (KeyError, TypeError, ValueError):
            names.append(str(gid))
    return names


def peer_process_groups(request):
    """Prefer the connecting process token over account membership.

    /proc/pid/status Groups: is supplementary only. SO_PEERCRED gid is EGID
    (`sg asip` is typically EGID-only), so union them.
    """
    names = []
    source = "unknown"
    pid = request.get("_peer_pid")
    if isinstance(pid, int) and pid > 0:
        try:
            for line in pathlib.Path("/proc/%s/status" % pid).read_text(encoding="utf-8").splitlines():
                if line.startswith("Groups:"):
                    names.extend(_group_names(line.split()[1:]))
                    source = "effective"
                    break
        except OSError:
            pass
    gid = request.get("_peer_gid")
    if isinstance(gid, int) and gid >= 0:
        for name in _group_names([gid]):
            if name not in names:
                names.append(name)
        if source == "unknown":
            source = "effective"
    if names:
        return names, source
    uid = request.get("_peer_uid")
    if isinstance(uid, int) and uid >= 0:
        try:
            pw = pwd.getpwuid(uid)
            return _group_names(os.getgrouplist(pw.pw_name, pw.pw_gid)), "account"
        except (KeyError, OSError):
            pass
    return [], "unknown"


def caller_identity(request):
    """State the calling process's inspectable privilege, not a guessed role."""
    uid = request.get("_peer_uid")
    user = None
    if isinstance(uid, int) and uid >= 0:
        try:
            user = pwd.getpwuid(uid).pw_name
        except KeyError:
            pass
    groups, source = peer_process_groups(request)
    in_asip = "asip" in groups
    in_read = "asip-read" in groups
    elevation = []
    if not in_read:
        elevation.append(
            "start a fresh login or harness with the asip-read group in its process token"
        )
    if not in_asip:
        elevation.append(
            "start a fresh login or harness with the asip group in its process token"
        )
    return {
        "uid": uid,
        "user": user,
        "groups": groups,
        "group_source": source,
        "sockets": {
            "privileged": {"path": SOCKET, "accessible": in_asip},
            "read": {"path": READ_SOCKET, "accessible": in_read},
        },
        "elevation": elevation,
    }


def associated_change_data(request, records=None):
    records = records if records is not None else journal_records()
    change_id = request.get("change_id")
    if not change_id:
        return {
            "change_id": None,
            "status": None,
            "intent": None,
            "inferred": False,
            "note": ("No change ID was supplied. ASIP does not infer a current "
                     "change from the Unix user. Pass --change ID or ASIP_CHANGE_ID."),
        }
    start = next((record for record in records
                  if record.get("id") == change_id
                  and record.get("op") == "change"
                  and record.get("action") == "start"), None)
    if start is None:
        return {
            "change_id": change_id,
            "status": "unknown",
            "intent": None,
            "inferred": False,
            "note": "The supplied change ID was not found in the journal.",
        }
    return {
        "change_id": change_id,
        "status": change_status(change_id, records),
        "intent": excerpt(start.get("intent", ""), 256)[0],
        "inferred": False,
        "note": "This ID was supplied by the caller; it was not inferred.",
    }


RECOVERY_TIMELINE_LIMIT = 20


def _snapper_entries(payload):
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        if isinstance(payload.get("root"), list):
            return payload["root"]
        for value in payload.values():
            if isinstance(value, list):
                return value
    return []


def snapper_timeline(limit=RECOVERY_TIMELINE_LIMIT):
    """Bounded read-only Snapper catalog. The daemon is already root."""
    if limit < 1:
        limit = 1
    if not shutil.which("snapper"):
        return {
            "available": False,
            "source": None,
            "error": "snapper not installed",
            "snapshots": [],
        }
    try:
        proc = subprocess.run(
            ["snapper", "--no-dbus", "--jsonout", "--utc", "--iso", "-c", "root", "list"],
            capture_output=True, text=True, timeout=8, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"available": False, "source": "snapper-list", "error": str(exc), "snapshots": []}
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "snapper list failed").strip()
        return {"available": False, "source": "snapper-list",
                "error": excerpt(err, 240)[0], "snapshots": []}
    try:
        payload = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError:
        return {"available": False, "source": "snapper-list",
                "error": "snapper JSON was unreadable", "snapshots": []}
    snapshots = []
    for entry in _snapper_entries(payload)[-limit:]:
        if not isinstance(entry, dict):
            continue
        number = entry.get("number", entry.get("#"))
        description = excerpt(str(entry.get("description") or ""), 160)[0]
        snapshots.append({
            "number": number,
            "type": entry.get("type") or entry.get("snapshot-type"),
            "date": entry.get("date"),
            "user": entry.get("user"),
            "cleanup": entry.get("cleanup"),
            "description": description,
            "default": bool(entry.get("default")),
            "active": bool(entry.get("active")),
        })
    return {
        "available": True,
        "source": "snapper-list",
        "config": "root",
        "limit": limit,
        "error": None,
        "snapshots": snapshots,
    }


def recovery_data(records=None, timeline_limit=RECOVERY_TIMELINE_LIMIT):
    records = records if records is not None else journal_records()
    snapshotter = snapshot_command("ASIP recovery inspect")[1]
    snaps = [record for record in records
             if record.get("op") == "snap" and record.get("state") == "finished"
             and record.get("exit") == 0]
    journal_snapshots = [recovery_identity(record) for record in snaps[-5:]]
    for item in journal_snapshots:
        item["journal_id"] = item["recovery_handle"]
        item["snapshotter"] = item["backend"]
    timeline = snapper_timeline(limit=timeline_limit)
    handles_by_backend = {}
    for record in snaps:
        identity = recovery_identity(record)
        if identity.get("backend_id"):
            handles_by_backend[str(identity["backend_id"])] = identity["recovery_handle"]
    for item in timeline.get("snapshots") or []:
        number = item.get("number")
        item["recovery_handle"] = handles_by_backend.get(str(number))
        item["rollback_accepts"] = "recovery_handle"
    supported = snapshotter == "snapper"
    return {
        "snapshotter": snapshotter,
        "supported": supported,
        "timeline": timeline,
        "journal_snapshots": journal_snapshots,
        "recent_snapshots": journal_snapshots,
        "rollback": "asip rollback RECOVERY-HANDLE" if supported else None,
        "rollback_accepts": "recovery_handle",
        "note": (
            "asip rollback accepts recovery_handle from journal_snapshots, "
            "never the Snapper backend_id. timeline is the live read-only "
            "catalog and does not grant rollback."
            if supported else
            "No ASIP-managed snapshotter is configured."
        ),
    }


def recovery_brief(records=None):
    return recovery_data(records=records, timeline_limit=3)


def recovery_request(request, ident, started):
    data = recovery_data()
    lines = [
        "snapshotter: %s" % data["snapshotter"],
        "supported: %s" % ("yes" if data["supported"] else "no"),
        "rollback: %s" % (data["rollback"] or "none"),
    ]
    timeline = data["timeline"]
    if not timeline.get("available"):
        lines.append("timeline: unavailable (%s)" % (timeline.get("error") or "unknown"))
    else:
        lines.append("timeline: last %d Snapper snapshots (config %s)" %
                     (len(timeline.get("snapshots") or []), timeline.get("config") or "root"))
        for item in timeline.get("snapshots") or []:
            lines.append("  #%s  %s  %s  %s" %
                         (item.get("number"), item.get("date") or "unknown",
                          item.get("type") or "unknown", item.get("description") or ""))
    if data["journal_snapshots"]:
        lines.append("journal snapshots:")
        for item in data["journal_snapshots"]:
            lines.append("  %s  %s  %s" %
                         (item.get("journal_id"), item.get("at"), item.get("reason")))
    lines.append(data["note"])
    return {"id": ident, "exit": 0, "stdout": "\n".join(lines) + "\n", "stderr": "",
            "data": data, "duration_ms": int((time.monotonic() - started) * 1000)}


def change_request(request, ident, started):
    action = request.get("action") or "list"
    argv = request.get("argv", [])
    if not isinstance(argv, list) or not all(isinstance(arg, str) for arg in argv):
        raise ValueError("change arguments must be strings")
    if action == "start":
        if len(argv) != 1 or not argv[0].strip():
            raise ValueError("change start needs one non-empty intent")
        intent = argv[0].strip()
        records = journal_records()
        duplicate = next((record for record in records
                          if record.get("op") == "change"
                          and record.get("action") == "start"
                          and record.get("uid") == request.get("_peer_uid", -1)
                          and record.get("intent", "").casefold() == intent.casefold()
                          and change_status(record.get("id"), records) == "open"), None)
        record = record_for(request, id=ident, at=now(), uid=request.get("_peer_uid", -1),
                            op="change", action="start", intent=argv[0].strip())
        append_record(record)
        warning = ("warning: open change %s has the same intent; use it or supersede it explicitly\n" %
                   duplicate["id"]) if duplicate else ""
        data = {"change_id": ident, "action": "start", "intent": intent, "status": "open"}
        if duplicate:
            data["duplicate_open_change_id"] = duplicate["id"]
        return {"id": ident, "exit": 0, "stdout": ident + "\n", "stderr": warning,
                "data": data, "duration_ms": int((time.monotonic() - started) * 1000)}
    if action in ("finish", "fail"):
        if len(argv) != 2 or not argv[1].strip():
            raise ValueError("change %s needs an id and concise summary" % action)
        change_id = argv[0]
        if action == "finish" and change_status(change_id) == "held":
            raise ValueError("change is held; release it before finish, or fail it")
        start = validate_change(request, change_id)
        record = record_for(request, id=ident, at=now(), uid=request.get("_peer_uid", -1),
                            op="change", action=action, change_id=change_id,
                            intent=start.get("intent", ""), summary=argv[1].strip())
        append_record(record)
        status = "finished" if action == "finish" else "failed"
        return {"id": ident, "exit": 0, "stdout": "", "stderr": "",
                "data": {"change_id": change_id, "action": action, "status": status,
                         "summary": argv[1].strip()},
                "duration_ms": int((time.monotonic() - started) * 1000)}
    if action == "hold":
        if len(argv) != 2 or not argv[1].strip():
            raise ValueError("change hold needs an id and a reason")
        change_id = argv[0]
        start = validate_change(request, change_id)
        kind = request.get("kind") or "deferred"
        if kind not in HOLD_KINDS:
            raise ValueError("hold kind must be one of: %s" % ", ".join(HOLD_KINDS))
        unblock = request.get("unblock")
        if not isinstance(unblock, str) or not unblock.strip():
            raise ValueError("change hold needs --unblock describing what would allow the work")
        predecessor = None
        if kind == "predecessor":
            predecessor = unblock.strip()
        observations = request.get("observations") or []
        if not isinstance(observations, list) or not all(isinstance(item, str) and item
                                                         for item in observations):
            raise ValueError("hold observations must be strings")
        if any(not _observation_name(item) for item in observations):
            raise ValueError(
                "hold --observe must be kernel, disk:MOUNT, pkg:NAME, path:ABS, "
                "unit:NAME, unit-user:NAME, or kmod:NAME"
            )
        record = record_for(request, id=ident, at=now(), uid=request.get("_peer_uid", -1),
                            op="change", action="hold", change_id=change_id,
                            intent=start.get("intent", ""), reason=argv[1].strip(),
                            kind=kind, unblock=unblock.strip(), predecessor=predecessor,
                            observations=observations)
        append_record(record)
        data = {"change_id": change_id, "action": "hold", "status": "held",
                "hold": hold_payload(record)}
        return {"id": ident, "exit": 0, "stdout": "", "stderr": "",
                "data": data, "duration_ms": int((time.monotonic() - started) * 1000)}
    if action == "release":
        if len(argv) != 2 or not argv[1].strip():
            raise ValueError("change release needs an id and a note")
        change_id = argv[0]
        if change_status(change_id) != "held":
            raise ValueError("change is not held")
        start = validate_change(request, change_id)
        record = record_for(request, id=ident, at=now(), uid=request.get("_peer_uid", -1),
                            op="change", action="release", change_id=change_id,
                            intent=start.get("intent", ""), reason=argv[1].strip())
        append_record(record)
        return {"id": ident, "exit": 0, "stdout": "", "stderr": "",
                "data": {"change_id": change_id, "action": "release", "status": "open",
                         "reason": argv[1].strip()},
                "duration_ms": int((time.monotonic() - started) * 1000)}
    if action == "supersede":
        if len(argv) != 3 or not argv[2].strip():
            raise ValueError("change supersede needs OLD-ID NEW-ID and a reason")
        old_id, new_id, summary = argv
        old = validate_change(request, old_id)
        if old_id == new_id:
            raise ValueError("a change cannot supersede itself")
        validate_change(request, new_id, require_open=False)
        record = record_for(request, id=ident, at=now(), uid=request.get("_peer_uid", -1),
                            op="change", action="supersede", change_id=old_id,
                            intent=old.get("intent", ""), superseded_by=new_id,
                            summary=summary.strip())
        append_record(record)
        return {"id": ident, "exit": 0, "stdout": "", "stderr": "",
                "data": {"change_id": old_id, "action": "supersede", "status": "superseded",
                         "superseded_by": new_id, "summary": summary.strip()},
                "duration_ms": int((time.monotonic() - started) * 1000)}
    if action == "show":
        if len(argv) != 1:
            raise ValueError("change show needs one id")
        validate_change(request, argv[0], require_open=False)
        data = change_payload(argv[0], request=request)
        output = format_change_summary(data)
        return {"id": ident, "exit": 0, "stdout": output, "stderr": "", "data": data,
                "duration_ms": int((time.monotonic() - started) * 1000)}
    if action == "status":
        return fail(
            "change status was removed; use asip --json change show ID for one "
            "change, asip --json change open for status=open work, asip --json "
            "change list for history, asip --json brief for open/held counts, "
            "asip --json context to bind this invocation"
        )
    if action in ("list", "open"):
        if argv:
            raise ValueError("change %s takes no arguments" % action)
        records = journal_records()
        starts = [record for record in records
                  if record.get("op") == "change" and record.get("action") == "start"
                  and record.get("uid") == request.get("_peer_uid", -1)]
        if action == "open":
            starts = [record for record in starts
                      if change_status(record["id"], records) == "open"]
        items = []
        for record in starts:
            change_id = record["id"]
            related = [item for item in records
                       if item.get("id") == change_id or item.get("change_id") == change_id]
            terminal = next((item for item in reversed(related)
                             if item.get("op") == "change"
                             and item.get("action") in ("finish", "fail", "supersede")), None)
            items.append({
                "change_id": change_id,
                "status": change_status(change_id, records),
                "intent": record.get("intent", ""),
                "started_at": record.get("at", "unknown"),
                "finished_at": terminal.get("at") if terminal else None,
                "outcome": terminal.get("summary") if terminal else None,
                "hold": hold_payload(change_hold_record(change_id, records)),
            })
        output = "".join("%s  %-6s  %s  %s\n" %
                         (item["started_at"], item["status"],
                          item["change_id"], item["intent"]) for item in items)
        if not output:
            output = "No %schanges.\n" % ("open " if action == "open" else "")
        return {"id": ident, "exit": 0, "stdout": output, "stderr": "",
                "data": {"changes": items},
                "duration_ms": int((time.monotonic() - started) * 1000)}
    raise ValueError("change action must be start, finish, fail, hold, release, supersede, show, status, list, or open")


def note_request(request, ident, started):
    validate_change(request)
    argv = request.get("argv", [])
    if not isinstance(argv, list) or len(argv) != 1 or not isinstance(argv[0], str) or not argv[0]:
        raise ValueError("note needs one path or subject")
    reason = request.get("reason", "")
    if not isinstance(reason, str) or not reason.strip():
        raise ValueError("note needs a description")
    record = attach_change(record_for(
        request, id=ident, at=now(), uid=request.get("_peer_uid", -1),
        op="note", subject=argv[0], reason=reason.strip()), request)
    append_record(record)
    return {"id": ident, "exit": 0, "stdout": "", "stderr": "",
            "data": {"note_id": ident, "change_id": request.get("change_id"),
                     "subject": argv[0]},
            "duration_ms": int((time.monotonic() - started) * 1000)}


def audit_event_summaries(raw):
    events = {}
    for line in raw.splitlines():
        match = re.search(r"msg=audit\([^:()]+:(\d+)\)", line)
        if not match:
            continue
        serial = match.group(1)
        event = events.setdefault(serial, {"types": [], "lines": []})
        event["lines"].append(line)
        type_match = re.search(r"(?:^|\s)type=([A-Z0-9_]+)", line)
        if type_match and type_match.group(1) not in event["types"]:
            event["types"].append(type_match.group(1))
        for field in ("auid", "uid", "exe", "comm", "name", "key", "op"):
            value = re.search(r'(?:^|\s)%s=("[^"]*"|\S+)' % field, line)
            if value and field not in event:
                event[field] = value.group(1).strip('"')
    summaries = {}
    for serial, event in events.items():
        actor = event.get("auid")
        if actor in (None, "-1", "4294967295", "unset"):
            actor = event.get("uid", "unknown")
        executable = event.get("exe") or event.get("comm") or "unknown"
        target = event.get("name") or event.get("key") or event.get("op") or "unknown"
        event_type = ",".join(event["types"]) or "UNKNOWN"
        self_event = ("CONFIG_CHANGE" in event["types"] and
                      any("asip_mode" in line for line in event["lines"]))
        summaries[serial] = "%s actor=%s exe=%s target=%s%s" % (
            event_type, actor, executable, target,
            " [ASIP rule lifecycle]" if self_event else ""
        )
    return summaries


def audit_pending(ident, started):
    proc = subprocess.run(["ausearch", "-k", "asip_mode", "--raw"], text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode not in (0, 1):
        raise OSError(proc.stderr.strip() or "ausearch failed")
    integrated = {record.get("evidence") for record in journal_records()
                  if record.get("op") == "observe" and record.get("evidence")}
    summaries = audit_event_summaries(proc.stdout)
    serials = list(summaries)
    pending = [serial for serial in serials if "audit:" + serial not in integrated]
    items = [{"id": "audit:%s" % serial, "summary": summaries[serial]}
             for serial in pending]
    if not items:
        output = "No pending ASIP audit events.\n"
    else:
        output = "".join("audit:%s  %s\n" % (serial, summaries[serial]) for serial in pending)
    return {"id": ident, "exit": 0, "stdout": output, "stderr": "",
            "data": {"pending": items},
            "duration_ms": int((time.monotonic() - started) * 1000)}


def verification_request(request, ident, started):
    action = request.get("action") or "list"
    argv = request.get("argv", [])
    if not isinstance(argv, list) or not all(isinstance(arg, str) for arg in argv):
        raise ValueError("verification arguments must be strings")
    if action == "list":
        if argv:
            raise ValueError("verify list takes no arguments")
        latest = {}
        for record in journal_records():
            if record.get("op") == "verify":
                latest[record.get("tool", "unknown")] = record
        items = [{"tool": tool, "result": record.get("result"),
                  "at": record.get("at"), "reason": record.get("reason", ""),
                  "id": record.get("id"),
                  "change_id": record.get("change_id"),
                  "references": list(record.get("references") or [])}
                 for tool, record in sorted(latest.items())]
        if items:
            output = "".join("%-24s %-4s %s  %s\n" %
                             (item["tool"], item["result"] or "?",
                              item["at"] or "unknown", item["reason"])
                             for item in items)
        else:
            output = "No in-situ verifications recorded.\n"
        return {"id": ident, "exit": 0, "stdout": output, "stderr": "",
                "data": {"verifications": items},
                "duration_ms": int((time.monotonic() - started) * 1000)}
    if action not in ("pass", "fail") or len(argv) < 2:
        raise ValueError("verify pass|fail needs a tool name and note")
    references = request.get("references", [])
    if not isinstance(references, list) or not all(isinstance(item, str) and item
                                                   for item in references):
        raise ValueError("verification references must be journal ids")
    known_ids = {record.get("id") for record in journal_records()}
    missing = [item for item in references if item not in known_ids]
    if missing:
        raise ValueError("verification references unknown journal id: %s" % missing[0])
    record = record_for(request, id=ident, at=now(),
                        uid=request.get("_peer_uid", -1), op="verify",
                        tool=argv[0], result=action, reason=" ".join(argv[1:]))
    if references:
        record["references"] = references
    append_record(attach_change(record, request))
    return {"id": ident, "exit": 0, "stdout": "", "stderr": "",
            "data": {"verify_id": ident, "tool": argv[0], "result": action,
                     "change_id": request.get("change_id")},
            "duration_ms": int((time.monotonic() - started) * 1000)}


def log_request(request, ident, started):
    argv = request.get("argv", [])
    if not isinstance(argv, list) or len(argv) > 1 or not all(isinstance(arg, str) for arg in argv):
        raise ValueError("log takes at most one journal id")
    records = journal_records()
    pose = None
    if not argv:
        output = "".join(json.dumps(record, separators=(",", ":")) + "\n"
                         for record in records)
    else:
        needle = argv[0]
        selected = [item for item in records
                    if item.get("id") == needle
                    or item.get("change_id") == needle
                    or item.get("question_id") == needle]
        pose = next((record for record in records
                     if record.get("op") == "ask" and record.get("action") == "pose"
                     and record.get("id") == needle), None)
        if pose is not None:
            related = [record for record in records
                       if record.get("op") == "ask"
                       and (record.get("id") == pose["id"]
                            or record.get("question_id") == pose["id"])]
            seen = set()
            merged = []
            for record in selected + related:
                key = record.get("id")
                if key in seen:
                    continue
                seen.add(key)
                merged.append(record)
            selected = merged
        if not selected:
            raise ValueError("journal id not found")
        parts = []
        for index, record in enumerate(selected):
            if index:
                parts.append("\n")
            parts.extend([json.dumps(record, indent=2, sort_keys=True), "\n"])
            for field, label in (("stdout_blob", "stdout"), ("stderr_blob", "stderr"),
                                 ("before_blob", "before"), ("after_blob", "after")):
                digest = record.get(field)
                if digest:
                    path = BLOBS / digest
                    data = path.read_bytes().decode("utf-8", errors="replace") if path.exists() else "[blob missing]\n"
                    parts.extend(["\n--- %s ---\n" % label, data if data else "[empty]\n"])
        output = "".join(parts)
    result = {"id": ident, "exit": 0, "stdout": output, "stderr": "",
              "duration_ms": int((time.monotonic() - started) * 1000)}
    if pose is not None:
        result["data"] = ask_payload(pose, records)
    return result


def _markdown_section(text, heading):
    match = re.search(
        r"^##\s+%s\s*$\n(.*?)(?=^##\s|\Z)" % re.escape(heading),
        text,
        re.MULTILINE | re.DOTALL,
    )
    return match.group(1).strip() if match else ""


def _project_entries():
    entries = []
    if not PROJECTS.exists():
        return entries
    for line in PROJECTS.read_text(encoding="utf-8").splitlines():
        match = PROJECT_PATTERN.match(line)
        if match:
            entries.append({"name": match.group(1), "path": match.group(2),
                            "description": match.group(3)})
    return entries


def _platform_summary():
    release = {}
    try:
        for line in pathlib.Path("/etc/os-release").read_text(encoding="utf-8").splitlines():
            key, separator, value = line.partition("=")
            if separator and key in {"ID", "ID_LIKE", "NAME", "PRETTY_NAME", "VERSION_ID"}:
                release[key] = value.strip().strip('"')
    except OSError:
        pass
    family = (release.get("ID_LIKE") or release.get("ID") or "unknown").split()[0].lower()
    return {
        "distribution": release.get("PRETTY_NAME") or release.get("NAME") or "unknown",
        "distro_family": family,
        "version_id": release.get("VERSION_ID", "unknown"),
        "kernel": platform.release(),
        "architecture": platform.machine(),
    }


def _machine_fact_health(machine_text):
    stale = 0
    incomplete = 0
    today = dt.datetime.now(dt.timezone.utc)
    for line in machine_text.splitlines():
        if "asip:fact " not in line:
            continue
        observed = re.search(r"observed-at=([0-9-]+)", line)
        max_age = re.search(r"max-age-days=([0-9]+)", line)
        checked = "checked-by=" in line
        if not observed or not checked:
            incomplete += 1
            continue
        if max_age:
            try:
                observed_date = dt.datetime.fromisoformat(observed.group(1)).replace(
                    tzinfo=dt.timezone.utc
                )
                if today > observed_date + dt.timedelta(days=int(max_age.group(1))):
                    stale += 1
            except ValueError:
                incomplete += 1
    return {"stale_facts": stale, "incomplete_facts": incomplete}


def _unique_records(records, operations):
    seen = set()
    selected = []
    for record in records:
        if record.get("op") not in operations or record.get("id") in seen:
            continue
        seen.add(record.get("id"))
        selected.append(record)
    return selected


def product_summary_data(request):
    """Build a bounded product view without exposing raw operations or blobs."""
    records = journal_records()
    starts = {
        record.get("id"): record for record in records
        if record.get("op") == "change" and record.get("action") == "start"
        and record.get("uid") == request.get("_peer_uid", -1)
    }
    recent_changes = []
    for start in list(starts.values())[-12:]:
        change_id = start.get("id")
        related = [record for record in records
                   if record.get("id") == change_id or record.get("change_id") == change_id]
        terminal = next((record for record in reversed(related)
                         if record.get("op") == "change"
                         and record.get("action") in ("finish", "fail", "supersede")), None)
        recent_changes.append({
            "change_id": change_id,
            "intent": excerpt(start.get("intent", ""), 256)[0],
            "status": change_status(change_id, records),
            "started_at": start.get("at"),
            "finished_at": terminal.get("at") if terminal else None,
            "outcome": excerpt(terminal.get("summary", ""), 256)[0] if terminal else None,
        })

    terminal_ids = {
        record.get("id") for record in records
        if record.get("state") in OPERATION_TERMINAL_STATES
    }
    incomplete = {
        record.get("id") for record in records
        if record.get("state") == "started" and record.get("id") not in terminal_ids
    }
    privileged = _unique_records(
        records, {"do", "pkg", "svc", "conf", "snap", "rollback"}
    )
    configurations = _unique_records(records, {"conf"})
    snapshots = _unique_records(records, {"snap"})
    rollbacks = _unique_records(records, {"rollback"})
    verifications = [record for record in records if record.get("op") == "verify"]
    latest = {}
    for record in verifications:
        latest[record.get("tool", "unknown")] = {
            "tool": record.get("tool", "unknown"),
            "result": record.get("result", "unknown"),
            "at": record.get("at"),
            "reason": excerpt(record.get("reason", ""), 256)[0],
        }
    machine_text = MACHINE.read_text(encoding="utf-8") if MACHINE.exists() else ""
    facts = _machine_fact_health(machine_text)
    snapshotter = snapshot_command("ASIP product summary")[1]
    stats = {
        "completed_changes": sum(1 for record in records
                                if record.get("op") == "change" and record.get("action") == "finish"
                                and record.get("uid") == request.get("_peer_uid", -1)),
        "failed_changes": sum(1 for record in records
                              if record.get("op") == "change" and record.get("action") == "fail"
                              and record.get("uid") == request.get("_peer_uid", -1)),
        "open_changes": sum(1 for change_id in starts
                            if change_status(change_id, records) == "open"),
        "held_changes": sum(1 for change_id in starts
                            if change_status(change_id, records) == "held"),
        "unanswered_questions": operator_questions(records)["pending"],
        "privileged_operations": len(privileged),
        "configuration_changes": len(configurations),
        "snapshots": len(snapshots),
        "rollbacks": len(rollbacks),
        "verification_pass": sum(1 for record in verifications if record.get("result") == "pass"),
        "verification_fail": sum(1 for record in verifications if record.get("result") == "fail"),
        "incomplete_operations": len(incomplete),
    }
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": now(),
        "version": VERSION,
        "product": product_versions(request),
        "platform": _platform_summary(),
        "health": {
            "read_socket": "healthy",
            "snapshotter": snapshotter,
            "recovery": "supported" if snapshotter == "snapper" else "not configured",
            "machine": "healthy" if MACHINE.exists() and not (facts["stale_facts"] or facts["incomplete_facts"])
            else "attention",
            "machine_facts": facts,
        },
        "statistics": stats,
        "recent_changes": recent_changes,
        "latest_verification": list(latest.values())[-10:],
    }


def summary_request(request, ident, started):
    data = product_summary_data(request)
    output = json.dumps(data, separators=(",", ":"), sort_keys=True) + "\n"
    return {"id": ident, "exit": 0, "stdout": output, "stderr": "", "data": data,
            "duration_ms": int((time.monotonic() - started) * 1000)}


def machine_policy_identity():
    """Locator and freshness for MACHINE.md. Never an excerpt."""
    exists = MACHINE.exists()
    last_modified = None
    digest = None
    size = None
    if exists:
        raw = MACHINE.read_bytes()
        size = len(raw)
        digest = hashlib.sha256(raw).hexdigest()
        last_modified = dt.datetime.fromtimestamp(
            MACHINE.stat().st_mtime, dt.timezone.utc).isoformat()
    return {
        "path": str(MACHINE),
        "uri": "asip://machine/policy",
        "cli": "asip --json policy",
        "exists": exists,
        "last_modified": last_modified,
        "sha256": digest,
        "bytes": size,
        "note": "Read the complete file before system work. Do not trust excerpts.",
    }


def machine_policy_payload():
    identity = machine_policy_identity()
    text = MACHINE.read_text(encoding="utf-8") if identity["exists"] else ""
    identity["text"] = text
    return identity


def context_data(request):
    """Bind this invocation to ASIP. Not a cold-entry dump of other surfaces."""
    cwd = request.get("cwd", "/")
    if not isinstance(cwd, str) or not cwd.startswith("/"):
        raise ValueError("context cwd must be an absolute path")
    records = journal_records()
    projects = _project_entries()
    matched = [entry for entry in projects
               if cwd == entry["path"] or cwd.startswith(entry["path"].rstrip("/") + "/")]
    matched.sort(key=lambda entry: len(entry["path"]), reverse=True)
    return {
        "schema_version": SCHEMA_VERSION,
        "document": "context",
        "version": VERSION,
        "product": product_versions(request),
        "generated_at": now(),
        "cwd": cwd,
        "project": ({**matched[0], "description": excerpt(matched[0]["description"], 512)[0]}
                    if matched else None),
        "associated_change": associated_change_data(request, records),
        "caller": caller_identity(request),
        "policy": machine_policy_identity(),
        "surfaces": {
            "brief": "asip --json brief",
            "held_work": "asip --json change show ID",
            "facts": "asip --json facts get SPEC",
            "ask": "asip --json ask list",
            "recovery": "asip --json recovery",
            "maintenance": "asip --json maintenance list",
            "policy": "asip --json policy",
        },
    }


def context_request(request, ident, started):
    data = context_data(request)
    output = json.dumps(data, separators=(",", ":"), sort_keys=True) + "\n"
    return {"id": ident, "exit": 0, "stdout": output, "stderr": "", "data": data,
            "duration_ms": int((time.monotonic() - started) * 1000)}


BRIEF_MAX_BYTES = 4096
BRIEF_DISK_PERCENT = 90
BRIEF_PRIVILEGED_OPS = {"do", "pkg", "svc", "conf", "snap", "rollback"}


def brief_caller(request):
    raw = caller_identity(request)
    sockets = raw["sockets"]
    return {
        "uid": raw["uid"],
        "user": raw["user"],
        "group_source": raw["group_source"],
        "authority": {
            "privileged": sockets["privileged"]["accessible"],
            "read": sockets["read"]["accessible"],
        },
        "sockets": sockets,
        "elevation": raw["elevation"],
    }


def brief_incomplete(records):
    terminal_ids = {record.get("id") for record in records
                    if record.get("state") in OPERATION_TERMINAL_STATES}
    items = []
    for record in records:
        if record.get("state") != "started":
            continue
        if record.get("id") in terminal_ids:
            continue
        if record.get("op") not in BRIEF_PRIVILEGED_OPS:
            continue
        items.append({
            "operation_id": record.get("id"),
            "op": record.get("op"),
            "started_at": record.get("at"),
            "command": excerpt(" ".join(record.get("argv", [])), 160)[0],
        })
    return items


def brief_blocking(request, records):
    starts = [record for record in records
              if record.get("op") == "change" and record.get("action") == "start"
              and record.get("uid") == request.get("_peer_uid", -1)]
    items = []
    open_n = 0
    held_n = 0
    for record in starts:
        status = change_status(record["id"], records)
        if status not in ("open", "held"):
            continue
        if status == "open":
            open_n += 1
        else:
            held_n += 1
        hold = hold_payload(change_hold_record(record["id"], records)) if status == "held" else None
        slim_hold = None
        if hold:
            slim_hold = {
                "kind": hold.get("kind"),
                "unblock": excerpt(hold.get("unblock") or "", 200)[0],
            }
        items.append({
            "change_id": record["id"],
            "status": status,
            "intent": excerpt(record.get("intent", ""), 160)[0],
            "hold": slim_hold,
        })
    items.sort(key=lambda item: (0 if item["status"] == "held" else 1, item["change_id"]))
    return {
        "open": open_n,
        "held": held_n,
        "items": items[:5],
        "truncated": len(items) > 5,
    }


def brief_attention(asks, incomplete, access=None):
    attention = []
    pending = int(asks.get("pending") or 0)
    if pending > 0:
        unanswered = asks.get("unanswered") or []
        attention.append({
            "id": "ask:pending",
            "audience": "operator",
            "priority": "high",
            "kind": "operator_question",
            "summary": "%s operator question%s need an answer in ASIP" % (
                pending, "" if pending == 1 else "s"),
            "count": pending,
            "human_surface": dict(OPERATOR_QUESTIONS_SURFACE),
            "refs": {"question_ids": [item.get("question_id") for item in unanswered[:5]]},
        })
    if incomplete:
        attention.append({
            "id": "ops:incomplete",
            "audience": "agent",
            "priority": "high",
            "kind": "incomplete_operation",
            "summary": "%s incomplete ASIP operation%s" % (
                len(incomplete), "" if len(incomplete) == 1 else "s"),
            "count": len(incomplete),
            "refs": {"operation_ids": [item.get("operation_id") for item in incomplete[:3]]},
        })
    pending_access = (access or {}).get("operator_action_required") or []
    if pending_access:
        attention.append({
            "id": "access:pending",
            "audience": "operator",
            "priority": "high",
            "kind": "access_provisioning",
            "summary": "%s connected service%s need setup in ASIP" % (
                len(pending_access), "" if len(pending_access) == 1 else "s"),
            "count": len(pending_access),
            "human_surface": dict(ACCESS_SURFACE),
            "refs": {"authorities": pending_access[:5]},
        })
    return attention


def brief_facts(blocking, records=None):
    facts = {}
    kernel = fact_kernel()
    reboot_hold = any(
        item.get("hold") and item["hold"].get("kind") == "reboot_window"
        for item in blocking.get("items") or []
    )
    if kernel.get("reboot_pending") or reboot_hold:
        facts["kernel"] = {
            "running": kernel.get("running"),
            "newest_installed": kernel.get("newest_installed"),
            "reboot_pending": bool(kernel.get("reboot_pending")),
        }
    disk = fact_disk("/")
    if int(disk.get("used_percent") or 0) >= BRIEF_DISK_PERCENT:
        facts["disk"] = {"mount": disk.get("mount"), "used_percent": disk.get("used_percent")}
    return facts


def brief_data(request):
    """Deterministic agent entry. ASIP, not the model, fills attention[]."""
    records = journal_records()
    asks = operator_questions(records)
    incomplete = brief_incomplete(records)
    blocking = brief_blocking(request, records)
    questions = {
        "pending": asks["pending"],
        "human_surface": dict(OPERATOR_QUESTIONS_SURFACE),
        "items": [
            {
                "question_id": item["question_id"],
                "gate": item.get("gate"),
                "question": excerpt(item.get("question") or "", 280)[0],
                "change_id": item.get("change_id"),
            }
            for item in asks["unanswered"][:5]
        ],
        "truncated": asks["pending"] > 5,
    }
    access = access_catalog()
    data = {
        "schema_version": SCHEMA_VERSION,
        "document": "brief",
        "generated_at": now(),
        "version": VERSION,
        "product": product_versions(request),
        "attention": brief_attention(asks, incomplete, access),
        "caller": brief_caller(request),
        "blocking": blocking,
        "operator_questions": questions,
        "access": {"available": access["available"],
                   "operator_action_required": access["operator_action_required"],
                   "human_surface": dict(ACCESS_SURFACE)},
        "incomplete_operations": incomplete[:3],
        "facts": brief_facts(blocking, records),
        "policy": machine_policy_identity(),
    }
    if request.get("change_id"):
        associated = associated_change_data(request, records)
        data["associated"] = {
            "change_id": associated.get("change_id"),
            "status": associated.get("status"),
            "inferred": False,
        }
    encoded = json.dumps(data, separators=(",", ":"), sort_keys=True).encode()
    if len(encoded) > BRIEF_MAX_BYTES:
        data["facts"] = {}
        encoded = json.dumps(data, separators=(",", ":"), sort_keys=True).encode()
    if len(encoded) > BRIEF_MAX_BYTES:
        data["blocking"]["items"] = data["blocking"]["items"][:3]
        data["blocking"]["truncated"] = True
        encoded = json.dumps(data, separators=(",", ":"), sort_keys=True).encode()
    if len(encoded) > BRIEF_MAX_BYTES:
        for item in data["incomplete_operations"]:
            item.pop("command", None)
    return data


def brief_request(request, ident, started):
    data = brief_data(request)
    output = json.dumps(data, separators=(",", ":"), sort_keys=True) + "\n"
    return {"id": ident, "exit": 0, "stdout": output, "stderr": "", "data": data,
            "duration_ms": int((time.monotonic() - started) * 1000)}


def doctor_request(request, ident, started):
    records = journal_records()
    terminal_ids = {record.get("id") for record in records
                    if record.get("state") in OPERATION_TERMINAL_STATES}
    incomplete = sorted({record.get("id") for record in records
                         if record.get("state") == "started"
                         and record.get("id") not in terminal_ids})
    data = {
        "schema_version": SCHEMA_VERSION,
        "version": VERSION,
        "product": product_versions(request),
        "generated_at": now(),
        "role": "read-only" if request.get("_read_only") else "privileged",
        "machine": {"path": str(MACHINE), "readable": os.access(MACHINE, os.R_OK)},
        "journal": {"path": str(JOURNAL), "readable": os.access(JOURNAL, os.R_OK),
                    "records": len(records), "incomplete_operations": incomplete},
        "snapshotter": snapshot_command("ASIP doctor probe")[1],
        "status": "attention" if incomplete or not os.access(MACHINE, os.R_OK) else "ok",
    }
    return {"id": ident, "exit": 0, "stdout": json.dumps(data, separators=(",", ":")) + "\n",
            "stderr": "", "data": data,
            "duration_ms": int((time.monotonic() - started) * 1000)}


def operation_request(request, ident, started):
    argv = request.get("argv", [])
    if len(argv) != 1 or not isinstance(argv[0], str) or not argv[0]:
        raise ValueError("operation get needs one operation id")
    selected = [record for record in journal_records() if record.get("id") == argv[0]]
    if not selected:
        raise ValueError("operation id not found")
    terminal = next((record for record in reversed(selected)
                     if record.get("state") in OPERATION_TERMINAL_STATES), None)
    started_record = next((record for record in selected if record.get("state") == "started"), None)
    data = {
        "operation_id": argv[0],
        "status": terminal.get("state") if terminal else "running",
        "started_at": started_record.get("at") if started_record else None,
        "completed_at": terminal.get("at") if terminal else None,
        "operation": terminal or started_record or selected[-1],
    }
    return {"id": ident, "exit": 0, "stdout": json.dumps(data, separators=(",", ":")) + "\n",
            "stderr": "", "data": data,
            "duration_ms": int((time.monotonic() - started) * 1000)}


def journal_search_request(request, ident, started):
    limit = request.get("limit", 50)
    cursor = request.get("cursor", 0)
    if not isinstance(limit, int) or limit < 1 or limit > 200:
        raise ValueError("journal search limit must be between 1 and 200")
    if not isinstance(cursor, int) or cursor < 0:
        raise ValueError("journal search cursor must be a non-negative integer")
    records = journal_records()
    filters = {key: request.get(key) for key in ("change_id", "operation", "state")
               if request.get(key) is not None}
    selected = []
    for record in reversed(records):
        # A change start is the defining record for the change: its UUID is
        # the record id, while every later record refers to that UUID through
        # change_id.  Search is an evidence API, so omitting the intent record
        # here would make a complete change look like an orphaned transcript.
        is_defining_change = (record.get("op") == "change"
                              and record.get("action") == "start"
                              and record.get("id") == filters.get("change_id"))
        if filters.get("change_id") and record.get("change_id") != filters["change_id"] \
                and not is_defining_change:
            continue
        if filters.get("operation") and record.get("op") != filters["operation"]:
            continue
        if filters.get("state") and record.get("state") != filters["state"]:
            continue
        selected.append(record)
    page = selected[cursor:cursor + limit]
    data = {"records": page,
            "next_cursor": cursor + limit if cursor + limit < len(selected) else None,
            "total": len(selected)}
    return {"id": ident, "exit": 0, "stdout": json.dumps(data, separators=(",", ":")) + "\n",
            "stderr": "", "data": data,
            "duration_ms": int((time.monotonic() - started) * 1000)}


def _eval_evidence_record(record):
    """Return bounded, output-free facts suitable for an eval grader.

    This is deliberately not a generic journal export.  In particular it
    excludes argv, CWD, reasons, notes, captured streams, blobs, and arbitrary
    client fields.  The normal journal/log API remains the forensic interface.
    """
    data = {key: record[key] for key in (
        "id", "op", "action", "state", "exit", "at", "change_id", "target",
        "snapshotter", "result", "tool", "references", "affects", "uid",
    ) if key in record}
    client = record.get("client")
    if isinstance(client, dict):
        safe_client = {key: client[key] for key in ("name", "version")
                       if isinstance(client.get(key), str)}
        if safe_client:
            data["client"] = safe_client
    if (record.get("op") == "conf" and isinstance(record.get("before_blob"), str)
            and isinstance(record.get("after_blob"), str)):
        # Expose only whether ASIP observed a change. Blob hashes can reveal
        # low-entropy configuration contents through guessing, so they remain
        # outside this bounded evaluator surface.
        data["changed"] = record["before_blob"] != record["after_blob"]
    return data


def eval_evidence_request(request, ident, started):
    """Return only the selected change's typed lifecycle facts for grading."""
    argv = request.get("argv", [])
    if len(argv) != 1 or not isinstance(argv[0], str) or not argv[0]:
        raise ValueError("eval evidence needs one change id")
    change_id = argv[0]
    records = journal_records()
    start_record = next((record for record in records
                         if record.get("id") == change_id and record.get("op") == "change"
                         and record.get("action") == "start"), None)
    if start_record is None:
        raise ValueError("change not found")
    related = [record for record in records
               if record.get("id") == change_id or record.get("change_id") == change_id]
    terminal = next((record for record in reversed(related)
                     if record.get("op") == "change"
                     and record.get("action") in ("finish", "fail", "supersede")), None)
    terminal_ids = {record.get("id") for record in related
                    if record.get("state") in OPERATION_TERMINAL_STATES}
    incomplete = [_eval_evidence_record(record) for record in related
                  if record.get("state") == "started" and record.get("id") not in terminal_ids]
    operations = [_eval_evidence_record(record) for record in related
                  if record.get("op") not in ("change", "verify", "note")
                  and record.get("state") != "started"]
    verifications = [_eval_evidence_record(record) for record in related
                     if record.get("op") == "verify"]
    data = {
        "schema_version": 1,
        "change": {
            "id": change_id,
            "intent": start_record.get("intent", ""),
            "status": change_status(change_id, records),
            "started_at": start_record.get("at"),
            "terminal_action": terminal.get("action") if terminal else None,
            "finished_at": terminal.get("at") if terminal else None,
        },
        "operations": operations[:100],
        "verifications": verifications[:100],
        "incomplete_operations": incomplete[:100],
        "observability": {
            "direct_privilege_escape": "not_observable_from_asip_evidence",
            "unrelated_change_use": "not_observable_without_fixture_or_harness_scope",
        },
    }
    return {"id": ident, "exit": 0,
            "stdout": json.dumps(data, separators=(",", ":")) + "\n", "stderr": "", "data": data,
            "duration_ms": int((time.monotonic() - started) * 1000)}


def blob_request(request, ident, started):
    argv = request.get("argv", [])
    if len(argv) != 1 or not re.fullmatch(r"[0-9a-f]{64}", argv[0]):
        raise ValueError("blob read needs one SHA-256 digest")
    path = BLOBS / argv[0]
    if not path.is_file():
        raise ValueError("blob not found")
    offset = request.get("offset", 0)
    limit = request.get("limit", 65536)
    if not isinstance(offset, int) or offset < 0:
        raise ValueError("blob offset must be non-negative")
    if not isinstance(limit, int) or limit < 1 or limit > 65536:
        raise ValueError("blob limit must be between 1 and 65536")
    raw = path.read_bytes()
    chunk = raw[offset:offset + limit]
    data = {"sha256": argv[0], "offset": offset, "total_bytes": len(raw),
            "next_offset": offset + len(chunk) if offset + len(chunk) < len(raw) else None,
            "text": chunk.decode("utf-8", errors="replace")}
    return {"id": ident, "exit": 0, "stdout": data["text"], "stderr": "", "data": data,
            "duration_ms": int((time.monotonic() - started) * 1000)}


def snapshot_command(reason):
    if shutil.which("snapper"):
        return ["snapper", "create", "--print-number", "--description", reason], "snapper"
    return None, "none"


def update_machine(package, reason):
    """Package provenance is a record, not an optional afterthought."""
    MACHINE.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    parent = MACHINE.parent.lstat()
    if not stat.S_ISDIR(parent.st_mode) or stat.S_ISLNK(parent.st_mode):
        raise ValueError("MACHINE.md parent must be a real directory")
    try:
        descriptor = os.open(MACHINE, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        text = "# MACHINE.md\n\n## Package Provenance\n\n"
        previous = None
    except OSError as exc:
        raise ValueError("MACHINE.md must be a regular file, not a symlink") from exc
    else:
        try:
            previous = os.fstat(descriptor)
            if not stat.S_ISREG(previous.st_mode):
                raise ValueError("MACHINE.md must be a regular file, not a symlink")
            with os.fdopen(descriptor, "r", encoding="utf-8") as handle:
                descriptor = -1
                text = handle.read()
        finally:
            if descriptor >= 0:
                os.close(descriptor)

    def policy_value(value):
        # This prose is later included in model context. Keep untrusted package
        # metadata on one literal line and prevent it from opening Markdown
        # code spans or links in the machine policy.
        value = " ".join(str(value).split())
        return (value.replace("\\", "\\\\").replace("`", "&#96;")
                .replace("[", "&#91;").replace("]", "&#93;"))

    line = "- `%s` — %s\n" % (
        policy_value(package), policy_value(reason or "installed through asip"))
    heading = "## Package Provenance"
    if heading not in text:
        text += "\n" + heading + "\n\n"
    index = text.index(heading) + len(heading)
    end = text.find("\n## ", index)
    if end < 0:
        end = len(text)
    text = text[:end].rstrip() + "\n" + line + text[end:]

    mode = stat.S_IMODE(previous.st_mode) if previous else 0o644
    owner = ((previous.st_uid, previous.st_gid) if previous else
             (os.geteuid(), os.getegid()))
    temporary = MACHINE.parent / (".%s-%s.tmp" % (MACHINE.name, uuid.uuid4()))
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    fd = os.open(temporary, flags, mode)
    try:
        if (owner != (os.geteuid(), os.getegid())):
            os.fchown(fd, *owner)
        os.fchmod(fd, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            fd = -1
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, MACHINE)
        fsync_directory(MACHINE.parent)
    finally:
        if fd >= 0:
            os.close(fd)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


PROJECT_PATTERN = re.compile(r"^- \*\*(.+)\*\* — `([^`]+)` — (.*)$")


def write_projects(lines):
    PROJECTS.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    temporary = PROJECTS.parent / (".projects-%s.tmp" % uuid.uuid4())
    try:
        with temporary.open("x", encoding="utf-8") as handle:
            handle.write("\n".join(lines).rstrip() + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, PROJECTS)
        fsync_directory(PROJECTS.parent)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def project(request):
    action = request.get("action") or "set"
    argv = request.get("argv", [])
    existing_lines = (PROJECTS.read_text(encoding="utf-8").splitlines()
                      if PROJECTS.exists() else ["# ASIP projects", ""])
    parsed = [(index, PROJECT_PATTERN.match(line))
              for index, line in enumerate(existing_lines)]
    if action == "set":
        if len(argv) != 2:
            raise ValueError("project set needs a name and absolute path")
        name, path = argv
        reason = request.get("reason") or "project registered through asip"
        if (not name or "\n" in name or "**" in name or not path.startswith("/")
                or "`" in path or "\n" in path or "\n" in reason):
            raise ValueError("project needs a safe name, absolute path, and one-line description")
        matches = [index for index, match in parsed if match and
                   (match.group(1).casefold() == name.casefold() or match.group(2) == path)]
        lines = [line for index, line in enumerate(existing_lines) if index not in matches]
        while lines and not lines[-1]:
            lines.pop()
        lines.extend(["", "- **%s** — `%s` — %s" % (name, path, reason)])
        write_projects(lines)
        verb = "updated" if matches else "registered"
        return subprocess.CompletedProcess([], 0, "%s %s\n" % (verb, name), "")
    if action == "remove":
        if len(argv) != 1 or not argv[0]:
            raise ValueError("project remove needs a name or path")
        key = argv[0]
        matches = [index for index, match in parsed if match and
                   (match.group(1).casefold() == key.casefold() or match.group(2) == key)]
        if not matches:
            raise ValueError("project not found")
        write_projects([line for index, line in enumerate(existing_lines)
                        if index not in matches])
        return subprocess.CompletedProcess([], 0, "removed %s\n" % key, "")
    raise ValueError("project action must be set or remove")


def drift_decision(request):
    action = request.get("action")
    argv = request.get("argv", [])
    if action not in ("ignore", "documented", "managed-by-project"):
        raise ValueError("drift decision must be ignore, documented, or managed-by-project")
    if len(argv) != 1 or not argv[0] or "`" in argv[0] or "\n" in argv[0]:
        raise ValueError("drift decision needs one safe package name or absolute path")
    reason = request.get("reason", "")
    if not reason or "\n" in reason:
        raise ValueError("drift decision needs a one-line reason")
    lines = (DRIFT_DECISIONS.read_text(encoding="utf-8").splitlines()
             if DRIFT_DECISIONS.exists() else ["# ASIP drift decisions", ""])
    marker = "`%s`" % argv[0]
    retained = [line for line in lines if marker not in line]
    while retained and not retained[-1]:
        retained.pop()
    retained.extend(["", "- **%s** — `%s` — %s" % (action, argv[0], reason)])
    DRIFT_DECISIONS.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    temporary = DRIFT_DECISIONS.parent / (".drift-%s.tmp" % uuid.uuid4())
    try:
        with temporary.open("x", encoding="utf-8") as handle:
            handle.write("\n".join(retained).rstrip() + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, DRIFT_DECISIONS)
        fsync_directory(DRIFT_DECISIONS.parent)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
    return subprocess.CompletedProcess([], 0, "recorded %s for %s\n" % (action, argv[0]), "")


def access_identity(request):
    name = request.get("name") or ((request.get("argv") or [""])[0])
    if not isinstance(name, str) or not ACCESS_NAME.fullmatch(name):
        raise ValueError("access name must match [a-z][a-z0-9._-]{0,63}")
    return name


def access_path(name):
    return ACCESS_DIR / (name + ".json")


def access_profile(name):
    path = access_path(name)
    if not path.is_file():
        return None
    try:
        profile = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return profile if isinstance(profile, dict) and isinstance(profile.get("value"), str) else None


def access_records(name=None):
    return [record for record in journal_records()
            if record.get("op") == "access"
            and (name is None or record.get("authority") == name)]


def access_metadata(name):
    records = access_records(name)
    latest = records[-1] if records else {}
    request = next((record for record in reversed(records)
                    if record.get("action") == "request"), {})
    profile = access_profile(name)
    available = profile is not None
    state = "available" if available else (
        "removed" if latest.get("action") == "remove" else
        "not_requested" if latest.get("action") == "dismiss" else
        "operator_action_required"
    )
    return {
        "name": name,
        "label": (profile or {}).get("label") or request.get("label") or name,
        "env_var": (profile or {}).get("env_var") or request.get("env_var"),
        "state": state,
        "available": available,
        "revision": (profile or {}).get("revision"),
        "updated_at": (profile or {}).get("updated_at") or latest.get("at"),
        "last_event": latest.get("action"),
        "human_surface": dict(ACCESS_SURFACE),
    }


def access_catalog():
    names = {record.get("authority") for record in access_records()
             if isinstance(record.get("authority"), str)}
    if ACCESS_DIR.is_dir():
        names.update(path.stem for path in ACCESS_DIR.glob("*.json")
                     if ACCESS_NAME.fullmatch(path.stem))
    items = [access_metadata(name) for name in sorted(names)]
    return {"access": items, "available": [item["name"] for item in items if item["available"]],
            "operator_action_required": [item["name"] for item in items
                                         if item["state"] == "operator_action_required"],
            "human_surface": dict(ACCESS_SURFACE)}


def access_request(request, ident, started):
    action = request.get("action", "list")
    if action == "list":
        data = access_catalog()
        return {"id": ident, "exit": 0, "stdout": json.dumps(data, separators=(",", ":")) + "\n",
                "stderr": "", "data": data,
                "duration_ms": int((time.monotonic() - started) * 1000)}
    name = access_identity(request)
    if action == "show":
        data = access_metadata(name)
        return {"id": ident, "exit": 0, "stdout": json.dumps(data, separators=(",", ":")) + "\n",
                "stderr": "", "data": data,
                "duration_ms": int((time.monotonic() - started) * 1000)}
    if action == "request":
        label = request.get("label") or name
        env_var = request.get("env_var")
        if not isinstance(label, str) or not label.strip() or len(label) > ACCESS_MAX_LABEL:
            raise ValueError("access label must be a non-empty string of at most %s characters" % ACCESS_MAX_LABEL)
        if not isinstance(env_var, str) or not ACCESS_ENV.fullmatch(env_var):
            raise ValueError("access env_var must be an uppercase environment name")
        current = access_profile(name)
        if current:
            data = access_metadata(name)
            data["requested"] = False
            return {"id": ident, "exit": 0, "stdout": "", "stderr": "", "data": data,
                    "duration_ms": int((time.monotonic() - started) * 1000)}
        history = access_records(name)
        latest = history[-1] if history else None
        prior = latest if latest and latest.get("action") == "request" \
            and latest.get("env_var") == env_var else None
        if not prior:
            append_record(record_for(request, id=ident, at=now(), uid=request.get("_peer_uid", -1),
                                     op="access", action="request", authority=name,
                                     label=label.strip(), env_var=env_var, state="operator_action_required"))
        data = access_metadata(name)
        data.update({"requested": not bool(prior), "remediation":
                     "The operator can provision this authority in ASIP, "
                     "Settings → Connected services. Retry after its state is available."})
        result = structured_error("operator_action_required",
                                  "Access %s requires operator provisioning" % name,
                                  exit_code=75, retryable=True,
                                  remediation=data["remediation"], details=data)
        result.update({"id": prior.get("id") if prior else ident, "data": data})
        return result
    if action == "provision":
        value = request.get("value")
        label = request.get("label") or name
        env_var = request.get("env_var")
        if not isinstance(value, str) or not value or len(value.encode()) > ACCESS_MAX_VALUE:
            raise ValueError("access value must contain 1–%s UTF-8 bytes" % ACCESS_MAX_VALUE)
        if not isinstance(label, str) or not label.strip() or len(label) > ACCESS_MAX_LABEL:
            raise ValueError("access label is invalid")
        if not isinstance(env_var, str) or not ACCESS_ENV.fullmatch(env_var):
            raise ValueError("access env_var must be an uppercase environment name")
        ACCESS_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(ACCESS_DIR, 0o700)
        previous = access_profile(name)
        revision = str(uuid.uuid4())
        profile = {"name": name, "label": label.strip(), "env_var": env_var,
                   "value": value, "revision": revision, "updated_at": now()}
        temporary = ACCESS_DIR / (".%s-%s.tmp" % (name, uuid.uuid4()))
        try:
            with temporary.open("x", encoding="utf-8") as handle:
                os.chmod(temporary, 0o600)
                json.dump(profile, handle, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, access_path(name))
            fsync_directory(ACCESS_DIR)
        finally:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass
        event = "replace" if previous else "provision"
        append_record(record_for(request, id=ident, at=now(), uid=request.get("_peer_uid", -1),
                                 op="access", action=event, authority=name, label=label.strip(),
                                 env_var=env_var, revision=revision, state="available"))
        data = access_metadata(name)
        return {"id": ident, "exit": 0, "stdout": "", "stderr": "", "data": data,
                "duration_ms": int((time.monotonic() - started) * 1000)}
    if action == "remove":
        existed = access_path(name).is_file()
        try:
            access_path(name).unlink()
            fsync_directory(ACCESS_DIR)
        except FileNotFoundError:
            pass
        append_record(record_for(request, id=ident, at=now(), uid=request.get("_peer_uid", -1),
                                 op="access", action="remove", authority=name,
                                 state="removed"))
        data = access_metadata(name)
        data["removed"] = existed
        return {"id": ident, "exit": 0, "stdout": "", "stderr": "", "data": data,
                "duration_ms": int((time.monotonic() - started) * 1000)}
    if action == "dismiss":
        if access_profile(name) is not None:
            raise ValueError("available access cannot be dismissed; remove it explicitly")
        previous = access_metadata(name)
        append_record(record_for(
            request, id=ident, at=now(), uid=request.get("_peer_uid", -1),
            op="access", action="dismiss", authority=name, state="not_requested",
        ))
        data = access_metadata(name)
        data["dismissed"] = previous.get("state") == "operator_action_required"
        return {"id": ident, "exit": 0, "stdout": "", "stderr": "", "data": data,
                "duration_ms": int((time.monotonic() - started) * 1000)}
    raise ValueError("access action must be list, show, request, provision, dismiss, remove, use, or start")


def access_environment(request, profile, run_uid):
    try:
        account = pwd.getpwuid(run_uid)
    except KeyError:
        raise ValueError("access operation requires a local calling user")
    env = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
           "HOME": account.pw_dir, "USER": account.pw_name,
           "LOGNAME": account.pw_name, "SHELL": account.pw_shell or "/bin/sh"}
    supplied = request.get("env") or {}
    if not isinstance(supplied, dict) or not all(isinstance(k, str) and isinstance(v, str)
                                                 for k, v in supplied.items()):
        raise ValueError("env must be a string map")
    env.update(supplied)
    runtime_dir = "/run/user/%s" % run_uid
    if os.path.isdir(runtime_dir):
        env["XDG_RUNTIME_DIR"] = runtime_dir
    env[profile["env_var"]] = profile["value"]
    return account, env


def detached_access_command(request, command, profile, ident):
    """Start one credential-bound user process without retaining its pipes."""
    started = time.monotonic()
    run_uid = request.get("_peer_uid", -1)
    account, env = access_environment(request, profile, run_uid)
    cwd = request.get("cwd", "/")
    if not isinstance(cwd, str) or not os.path.isdir(cwd):
        raise ValueError("cwd must name an existing directory")
    fields = {"authority": profile["name"], "env_var": profile["env_var"],
              "revision": profile["revision"], "run_as_uid": run_uid,
              "capture": "detached"}
    append_record(operation_record(request, ident, command, "started", fields))
    try:
        proc = subprocess.Popen(
            command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            user=account.pw_uid, group=account.pw_gid,
            extra_groups=os.getgrouplist(account.pw_name, account.pw_gid),
            start_new_session=True,
        )
    except (OSError, ValueError) as exc:
        append_record(operation_record(
            request, ident, command, "failed",
            dict(fields, exit=127, error=str(exc),
                 duration_ms=int((time.monotonic() - started) * 1000))))
        return structured_error("command_failed", "background access process failed to start",
                                remediation="inspect the command and retry")
    duration = int((time.monotonic() - started) * 1000)
    append_record(operation_record(request, ident, command, "detached",
                                   dict(fields, pid=proc.pid, duration_ms=duration)))
    return {"schema_version": SCHEMA_VERSION, "ok": True, "id": ident,
            "operation_id": ident, "exit": 0, "stdout": "", "stderr": "",
            "duration_ms": duration, "data": {"operation_id": ident,
            "op": "access", "state": "detached", "pid": proc.pid,
            "authority": profile["name"], "change_id": request.get("change_id")}}


def rollback_command(entry_id):
    if not JOURNAL.exists():
        raise ValueError("journal is empty")
    records = journal_records()
    chosen = None
    for record in records:
        if (record.get("id") == entry_id and record.get("op") == "snap"
                and record.get("state") in ("finished", None)):
            chosen = record
    if not chosen and isinstance(entry_id, str) and entry_id.isdigit():
        matches = []
        for record in records:
            if record.get("op") != "snap" or record.get("state") not in ("finished", None):
                continue
            identity = recovery_identity(record)
            if identity.get("backend_id") == entry_id:
                matches.append(identity)
        if matches:
            handle = matches[-1]["recovery_handle"]
            raise ValueError(
                "%s is a Snapper backend_id; asip rollback accepts recovery_handle %s"
                % (entry_id, handle)
            )
        raise ValueError(
            "%s looks like a Snapper number; asip rollback accepts recovery_handle "
            "from asip --json recovery (journal_snapshots[].recovery_handle)"
            % entry_id
        )
    if not chosen:
        raise ValueError(
            "rollback needs a recovery_handle (the ASIP snap operation id), "
            "not a Snapper snapshot number"
        )
    snapshotter = chosen.get("snapshotter")
    if snapshotter is None and chosen.get("argv"):
        snapshotter = chosen["argv"][0]
    if snapshotter != "snapper":
        raise ValueError("ASIP rollback is implemented only for Snapper snapshots")
    backend_id = chosen.get("backend_id") or parse_snapper_backend_id(
        (BLOBS / chosen["stdout_blob"]).read_text(encoding="utf-8")
        if chosen.get("stdout_blob") and (BLOBS / chosen["stdout_blob"]).exists()
        else ""
    )
    if not backend_id:
        raise ValueError("could not find a Snapper snapshot id")
    if not shutil.which("snapper"):
        raise ValueError("Snapper is not installed")
    return ["snapper", "rollback", backend_id]


def command_for(request):
    op = request.get("op")
    argv = request.get("argv")
    if not isinstance(argv, list) or not all(isinstance(arg, str) for arg in argv):
        raise ValueError("argv must be an array of strings")
    if not argv:
        raise ValueError("argv is empty")
    managers = {
        "pacman": ["pacman", "-S", "--noconfirm"],
        "apt-get": ["apt-get", "install", "-y"],
        "dnf": ["dnf", "install", "-y"],
        "zypper": ["zypper", "--non-interactive", "install"],
        "emerge": ["emerge"],
        "xbps-install": ["xbps-install", "-y"],
        "apk": ["apk", "add"],
    }
    if op == "do" or op == "conf" or op == "svc":
        return argv
    if op == "pkg":
        manager = request.get("manager")
        if manager not in managers:
            raise ValueError("unsupported package manager")
        action = request.get("action")
        if action == "install":
            return managers[manager] + argv
        if action == "remove":
            removal = {
                "pacman": ["pacman", "-R", "--noconfirm"], "apt-get": ["apt-get", "remove", "-y"],
                "dnf": ["dnf", "remove", "-y"], "zypper": ["zypper", "--non-interactive", "remove"],
                "emerge": ["emerge", "--deselect"], "xbps-install": ["xbps-remove", "-y"],
                "apk": ["apk", "del"],
            }
            return removal[manager] + argv
        raise ValueError("package action must be install or remove")
    raise ValueError("unknown operation")


def execute(command, cwd, env, emit, *, run_uid=None, redactions=None,
            timeout_seconds=None):
    """Run one bounded command, stream partial output, and retain its text."""
    if timeout_seconds is None:
        timeout_seconds = COMMAND_TIMEOUT_SECONDS
    popen_identity = {}
    if run_uid is not None and not (os.geteuid() != 0 and run_uid == os.getuid()):
        account = pwd.getpwuid(run_uid)
        popen_identity = {"user": account.pw_uid, "group": account.pw_gid,
                          "extra_groups": os.getgrouplist(account.pw_name, account.pw_gid)}
    proc = subprocess.Popen(command, cwd=cwd, env=env, **popen_identity,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            start_new_session=True)
    selector = selectors.DefaultSelector()
    selector.register(proc.stdout, selectors.EVENT_READ, "stdout")
    selector.register(proc.stderr, selectors.EVENT_READ, "stderr")
    captured = {"stdout": [], "stderr": []}
    decoders = {name: codecs.getincrementaldecoder("utf-8")(errors="replace")
                for name in captured}
    pending = {name: "" for name in captured}
    secrets = sorted((secret for secret in redactions or [] if secret),
                     key=len, reverse=True)
    redaction_lookbehind = max((len(secret) for secret in secrets), default=1) - 1
    connected = True
    timed_out = False
    deadline = time.monotonic() + timeout_seconds

    def publish(name, chunk, *, final=False):
        nonlocal connected
        value = pending[name] + chunk
        limit = len(value) if final else max(0, len(value) - redaction_lookbehind)
        safe = []
        cursor = 0
        while cursor < limit:
            match = next((secret for secret in secrets
                          if value.startswith(secret, cursor)), None)
            if match:
                safe.append("[ASIP ACCESS VALUE REDACTED]")
                cursor += len(match)
            else:
                safe.append(value[cursor])
                cursor += 1
        pending[name] = value[cursor:]
        chunk = "".join(safe)
        if chunk:
            captured[name].append(chunk)
            if connected:
                try:
                    emit({"stream": name, "data": chunk})
                except (OSError, ValueError):
                    # Output delivery is not command ownership. A vanished or
                    # stalled reader cannot keep the mutation lane indefinitely.
                    connected = False

    try:
        while selector.get_map() or proc.poll() is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                if timed_out:
                    # An escaped or uninterruptible descendant must not keep
                    # the administrative server hostage after the kill grace.
                    break
                timed_out = True
                _terminate_process_group(proc)
                deadline = time.monotonic() + COMMAND_TERMINATE_GRACE_SECONDS
                continue
            # Continue watching the process even if it closes both output
            # streams and then hangs. Conversely, continue draining pipes
            # after the session leader exits because descendants may still
            # hold them open.
            ready = selector.select(timeout=min(remaining, 0.1)) if selector.get_map() else []
            if not ready:
                continue
            for key, _ in ready:
                try:
                    data = os.read(key.fileobj.fileno(), 65536)
                except BlockingIOError:
                    continue
                if data:
                    publish(key.data, decoders[key.data].decode(data))
                    continue
                publish(key.data, decoders[key.data].decode(b"", final=True), final=True)
                selector.unregister(key.fileobj)
                key.fileobj.close()
    finally:
        for key in list(selector.get_map().values()):
            try:
                selector.unregister(key.fileobj)
            except (KeyError, ValueError):
                pass
            try:
                key.fileobj.close()
            except OSError:
                pass
        selector.close()
        if not timed_out and proc.poll() is None:
            _terminate_process_group(proc)
            timed_out = True
    if proc.poll() is None:
        # The kernel may keep a process in an uninterruptible wait even after
        # SIGKILL. Do not hold the serialized mutation lane waiting for it.
        threading.Thread(target=proc.wait, name="asip-command-reaper", daemon=True).start()
    else:
        proc.wait()
    result = subprocess.CompletedProcess(
        command, 124 if timed_out else proc.returncode, "".join(captured["stdout"]),
        "".join(captured["stderr"]))
    result.timed_out = timed_out
    result.timeout_seconds = timeout_seconds
    return result


def _terminate_process_group(proc):
    """Stop the command and same-session descendants after its deadline."""
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    deadline = time.monotonic() + COMMAND_TERMINATE_GRACE_SECONDS
    while time.monotonic() < deadline:
        proc.poll()  # Reap the session leader while descendants wind down.
        try:
            os.killpg(proc.pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.05)
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        proc.wait(timeout=COMMAND_TERMINATE_GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        # A process stuck in an uninterruptible kernel wait can outlive SIGKILL.
        # Reap it when the kernel permits, without keeping the ASIP lane locked.
        threading.Thread(target=proc.wait, name="asip-command-reaper", daemon=True).start()


def operation_record(request, ident, command, state, fields=None):
    record = record_for(
        request,
        id=ident,
        at=now(),
        uid=request.get("_peer_uid", -1),
        op=request.get("op"),
        state=state,
        argv=command,
        cwd=request.get("cwd", "/"),
        reason=request.get("reason", ""),
    )
    attach_change(record, request)
    if fields:
        record.update(fields)
    return record


def recorded_command(request, command, emit, ident=None, fields=None, before=None,
                     after_target=None, post_success=None, run_uid=None, redactions=None,
                     timeout_seconds=None):
    """Persist start before Popen, then append exactly one terminal event."""
    if timeout_seconds is None:
        timeout_seconds = COMMAND_TIMEOUT_SECONDS
    ident = ident or str(uuid.uuid4())
    started = time.monotonic()
    started_fields = dict(fields or {}, timeout_seconds=timeout_seconds)
    append_record(operation_record(request, ident, command, "started", started_fields))
    timed_out = False
    try:
        env = {"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}
        supplied = request.get("env", {})
        if not isinstance(supplied, dict) or not all(isinstance(k, str) and isinstance(v, str)
                                                     for k, v in supplied.items()):
            raise ValueError("env must be a string map")
        env.update(supplied)
        cwd = request.get("cwd", "/")
        if not isinstance(cwd, str) or not os.path.isdir(cwd):
            raise ValueError("cwd must name an existing directory")
        if run_uid is None and not redactions:
            proc = execute(command, cwd, env, emit, timeout_seconds=timeout_seconds)
        else:
            proc = execute(command, cwd, env, emit, run_uid=run_uid, redactions=redactions,
                           timeout_seconds=timeout_seconds)
        out, err = proc.stdout or "", proc.stderr or ""
        timed_out = bool(getattr(proc, "timed_out", False))
        if timed_out:
            err += "\nasip command timed out after %s seconds and its process group was terminated\n" % (
                getattr(proc, "timeout_seconds", COMMAND_TIMEOUT_SECONDS))
        exit_code = proc.returncode
        terminal_fields = {"exit": exit_code,
                           "duration_ms": int((time.monotonic() - started) * 1000)}
        if timed_out:
            terminal_fields.update({"timed_out": True,
                                    "timeout_seconds": getattr(
                                        proc, "timeout_seconds", COMMAND_TIMEOUT_SECONDS),
                                    "error": "command exceeded its time limit; effects may be partial"})
        if request.get("sensitive"):
            terminal_fields.update({
                "capture": "sensitive",
                "stdout_sha256": hashlib.sha256(out.encode()).hexdigest(),
                "stderr_sha256": hashlib.sha256(err.encode()).hexdigest(),
            })
        else:
            terminal_fields.update({"stdout_blob": blob(out.encode()),
                                    "stderr_blob": blob(err.encode())})
        if before:
            terminal_fields["before_blob"] = before
        if after_target and os.path.isfile(after_target):
            terminal_fields["after_blob"] = blob(pathlib.Path(after_target).read_bytes())
        if proc.returncode == 0 and post_success:
            try:
                post_success()
            except (OSError, ValueError) as exc:
                terminal_fields["command_exit"] = proc.returncode
                terminal_fields["error"] = str(exc)
                exit_code = 70
                terminal_fields["exit"] = exit_code
                err += "asip post-operation recording failed: %s\n" % exc
                if request.get("sensitive"):
                    terminal_fields["stderr_sha256"] = hashlib.sha256(err.encode()).hexdigest()
                else:
                    terminal_fields["stderr_blob"] = blob(err.encode())
        state = "finished" if exit_code == 0 else "failed"
    except (OSError, ValueError) as exc:
        out, err, exit_code, state = "", str(exc) + "\n", 127, "failed"
        terminal_fields = {"exit": exit_code,
                           "duration_ms": int((time.monotonic() - started) * 1000),
                           "error": str(exc)}
        if request.get("sensitive"):
            terminal_fields.update({
                "capture": "sensitive", "stdout_sha256": hashlib.sha256(b"").hexdigest(),
                "stderr_sha256": hashlib.sha256(err.encode()).hexdigest(),
            })
        else:
            terminal_fields.update({"stdout_blob": blob(b""),
                                    "stderr_blob": blob(err.encode())})
        if before:
            terminal_fields["before_blob"] = before
    if request.get("op") == "snap" and "backend_id" not in terminal_fields:
        backend_id = parse_snapper_backend_id(out)
        if backend_id:
            terminal_fields["backend_id"] = backend_id
    append_record(operation_record(request, ident, command, state,
                                   dict(fields or {}, **terminal_fields)))
    if request.get("sensitive"):
        stdout_excerpt, stdout_truncated = "", bool(out)
        stderr_excerpt, stderr_truncated = "", bool(err)
    else:
        stdout_excerpt, stdout_truncated = excerpt(out)
        stderr_excerpt, stderr_truncated = excerpt(err)
    result = {
        "schema_version": SCHEMA_VERSION,
        "ok": exit_code == 0,
        "id": ident,
        "operation_id": ident,
        "exit": exit_code,
        "stdout": stdout_excerpt,
        "stderr": stderr_excerpt,
        "stdout_truncated": stdout_truncated,
        "stderr_truncated": stderr_truncated,
        "duration_ms": terminal_fields["duration_ms"],
        "output_bytes": len(out.encode()) + len(err.encode()),
    }
    data = {
        "operation_id": ident,
        "op": request.get("op"),
        "exit": exit_code,
        "ok": exit_code == 0,
        "change_id": request.get("change_id"),
    }
    if request.get("op") == "snap":
        snap_record = {
            "id": ident,
            "op": "snap",
            "snapshotter": (fields or {}).get("snapshotter") or "snapper",
            "backend_id": terminal_fields.get("backend_id") or parse_snapper_backend_id(out),
            "change_id": request.get("change_id"),
            "reason": request.get("reason", ""),
            "at": now(),
        }
        data.update(recovery_identity(snap_record))
    if request.get("op") == "rollback":
        data["recovery_handle"] = (request.get("argv") or [None])[0]
        data["rollback_accepts"] = "recovery_handle"
    if request.get("op") == "conf":
        data["target"] = request.get("target")
        data["changed"] = terminal_fields.get("before_blob") != terminal_fields.get("after_blob") \
            if terminal_fields.get("before_blob") and terminal_fields.get("after_blob") else None
        data["before_blob"] = terminal_fields.get("before_blob")
        data["after_blob"] = terminal_fields.get("after_blob")
    result["data"] = data
    if exit_code != 0:
        result["error"] = {
            "code": "command_timeout" if timed_out else "command_failed",
            "message": ("privileged command exceeded its %s-second time limit; effects may be partial" %
                        terminal_fields["timeout_seconds"] if timed_out else
                        "privileged command exited with status %s" % exit_code),
            "retryable": False,
            "remediation": ("inspect the operation and actual system state before deciding whether to retry" if timed_out else
                            "inspect the output excerpt or blob resources before choosing a corrective command"),
        }
    for field in ("capture", "stdout_sha256", "stderr_sha256",
                  "stdout_blob", "stderr_blob"):
        if field in terminal_fields:
            result[field] = terminal_fields[field]
    return result


def perform_snapshot(request, reason, emit, parent_id=None):
    command, snapshotter = snapshot_command(reason)
    ident = str(uuid.uuid4())
    snapshot_request = dict(request, op="snap", reason=reason)
    fields = {"snapshotter": snapshotter}
    if parent_id:
        fields["parent_id"] = parent_id
    if command is None:
        record = operation_record(snapshot_request, ident, [], "skipped", fields)
        record.update({"exit": 0, "duration_ms": 0,
                       "message": "no ASIP-managed snapshotter available"})
        append_record(record)
        return {"id": ident, "exit": 0, "stdout": "no ASIP-managed snapshotter available\n",
                "stderr": "",
                "data": {"operation_id": ident, "op": "snap", "backend": "none",
                         "recovery_handle": ident, "rollback": None,
                         "rollback_accepts": "recovery_handle",
                         "change_id": request.get("change_id")},
                "duration_ms": 0}
    return recorded_command(snapshot_request, command, emit, ident=ident, fields=fields)


def _handle(request, emit=lambda _frame: None):
    started = time.monotonic()
    ident = str(uuid.uuid4())
    reason = request.get("reason", "")
    if not isinstance(reason, str):
        return fail("reason must be a string")
    try:
        if request.get("op") == "context":
            return context_request(request, ident, started)
        if request.get("op") == "brief":
            return brief_request(request, ident, started)
        if request.get("op") == "doctor":
            return doctor_request(request, ident, started)
        if request.get("op") == "summary":
            return summary_request(request, ident, started)
        if request.get("op") == "recovery":
            return recovery_request(request, ident, started)
        if request.get("op") == "facts":
            return facts_request(request, ident, started)
        if request.get("op") == "ask":
            return ask_request(request, ident, started)
        if request.get("op") == "access" and request.get("action") in ("list", "show", "request", "provision", "dismiss", "remove"):
            return access_request(request, ident, started)
        if request.get("op") == "operation":
            return operation_request(request, ident, started)
        if request.get("op") == "journal-search":
            return journal_search_request(request, ident, started)
        if request.get("op") == "eval-evidence":
            return eval_evidence_request(request, ident, started)
        if request.get("op") == "blob":
            return blob_request(request, ident, started)
        if request.get("op") in ("project-list", "drift-list"):
            path = PROJECTS if request.get("op") == "project-list" else DRIFT_DECISIONS
            output = path.read_text(encoding="utf-8") if path.exists() else ""
            return {"id": ident, "exit": 0, "stdout": output, "stderr": "",
                    "data": {"path": str(path), "text": output},
                    "duration_ms": int((time.monotonic() - started) * 1000)}
        if request.get("op") == "machine-policy":
            data = machine_policy_payload()
            output = data.get("text") or ""
            return {"id": ident, "exit": 0, "stdout": output, "stderr": "",
                    "data": data,
                    "duration_ms": int((time.monotonic() - started) * 1000)}
        if request.get("op") == "change":
            return change_request(request, ident, started)
        if request.get("op") == "note":
            return note_request(request, ident, started)
        if request.get("change_id") is not None:
            validate_change(request)
        affects = request.get("affects", [])
        sensitive = request.get("sensitive", False)
        if not isinstance(affects, list) or not all(isinstance(path, str) and path.startswith("/")
                                                    for path in affects):
            raise ValueError("affects must contain absolute paths")
        if not isinstance(sensitive, bool):
            raise ValueError("sensitive must be a boolean")
        if (affects or sensitive) and request.get("op") != "do":
            raise ValueError("affects and sensitive mode are supported only by asip do")
        if request.get("op") == "maintenance":
            return maintenance_request(request, ident, started)
        if request.get("op") == "audit-pending":
            return audit_pending(ident, started)
        if request.get("op") == "verify":
            return verification_request(request, ident, started)
        if request.get("op") == "log":
            return log_request(request, ident, started)
        if request.get("op") == "observe":
            argv = request.get("argv", [])
            source = request.get("source", "inspection")
            evidence = request.get("evidence", "")
            if not isinstance(argv, list) or len(argv) != 1 or not isinstance(argv[0], str) or not argv[0]:
                raise ValueError("observe needs one subject")
            if not isinstance(source, str) or not source:
                raise ValueError("observe source must be a non-empty string")
            if not isinstance(evidence, str):
                raise ValueError("observe evidence must be a string")
            if not reason:
                raise ValueError("observe needs a description of the change")
            if evidence:
                existing = next((record for record in journal_records()
                                 if record.get("op") == "observe"
                                 and record.get("evidence") == evidence), None)
                if existing:
                    return {"id": existing["id"], "exit": 0,
                            "stdout": "already integrated: %s\n" % existing["id"],
                            "stderr": "",
                            "duration_ms": int((time.monotonic() - started) * 1000)}
            record = record_for(request, id=ident, at=now(),
                                uid=request.get("_peer_uid", -1), op="observe",
                                subject=argv[0], source=source, evidence=evidence,
                                reason=reason)
            append_record(attach_change(record, request))
            return {"id": ident, "exit": 0, "stdout": "", "stderr": "",
                    "duration_ms": int((time.monotonic() - started) * 1000)}
        if request.get("op") == "snap":
            return perform_snapshot(request, reason or "asip snapshot", emit)
        elif request.get("op") == "access" and request.get("action") in ("use", "start"):
            name = access_identity(request)
            profile = access_profile(name)
            if profile is None:
                request_result = access_request(dict(request, action="request",
                                                     label=request.get("label") or name,
                                                     env_var=request.get("env_var") or "ASIP_ACCESS_VALUE"),
                                                ident, started)
                return request_result
            command = command_for(dict(request, op="do"))
            run_uid = request.get("_peer_uid", -1)
            _, access_env = access_environment(request, profile, run_uid)
            use_request = dict(request, env=access_env)
            if request.get("action") == "start":
                return detached_access_command(request, command, profile, ident)
            fields = {"authority": name, "env_var": profile["env_var"],
                      "revision": profile["revision"], "run_as_uid": run_uid}
            return recorded_command(use_request, command, emit, ident=ident, fields=fields,
                                    run_uid=run_uid, redactions=[profile["value"]],
                                    timeout_seconds=ACCESS_USE_TIMEOUT_SECONDS)
        elif request.get("op") == "project":
            proc = project(request)
            command = ["project", request.get("action") or "set"] + request["argv"]
        elif request.get("op") == "drift-decision":
            proc = drift_decision(request)
            command = ["drift", "decide", request.get("action", "")] + request["argv"]
        elif request.get("op") == "rollback":
            if len(request.get("argv", [])) != 1:
                raise ValueError("rollback needs one snapshot journal id")
            command = rollback_command(request["argv"][0])
            return recorded_command(request, command, emit, ident=ident,
                                    fields={"snapshot_id": request["argv"][0]})
        else:
            command = command_for(request)
            before = None
            target = request.get("target")
            if request.get("op") == "conf":
                if not isinstance(target, str) or not target.startswith("/"):
                    raise ValueError("conf needs an absolute target path")
                if os.path.isfile(target):
                    before = blob(pathlib.Path(target).read_bytes())
            if request.get("op") == "pkg":
                snap_result = perform_snapshot(
                    request, "before package %s: %s" %
                    (request.get("action", "change"), " ".join(request.get("argv", []))),
                    emit, parent_id=ident)
                if snap_result["exit"] != 0:
                    return snap_result
            post_success = None
            if request.get("op") == "pkg" and request.get("action") == "install":
                def post_success():
                    for package in request["argv"]:
                        update_machine(package, reason)
            record_fields = {}
            if affects:
                record_fields["affects"] = list(dict.fromkeys(affects))
            if sensitive:
                record_fields["capture"] = "sensitive"
            if request.get("op") == "conf":
                record_fields["target"] = target
            if request.get("op") == "pkg":
                record_fields.update({"manager": request.get("manager"),
                                      "action": request.get("action")})
            return recorded_command(request, command, emit, ident=ident,
                                    fields=record_fields, before=before,
                                    after_target=target if request.get("op") == "conf" else None,
                                    post_success=post_success)
        out, err = proc.stdout or "", proc.stderr or ""
        result = {"id": ident, "exit": proc.returncode, "stdout": out, "stderr": err,
                  "duration_ms": int((time.monotonic() - started) * 1000)}
        record = record_for(
            request, id=ident, at=now(), uid=request.get("_peer_uid", -1),
            op=request.get("op"), argv=command, cwd=request.get("cwd", "/"),
            reason=reason, exit=proc.returncode, duration_ms=result["duration_ms"],
            stdout_blob=blob(out.encode()), stderr_blob=blob(err.encode()))
        if request.get("op") == "conf":
            record["target"] = request.get("target")
            if before:
                record["before_blob"] = before
            if request.get("target") and os.path.isfile(request["target"]):
                record["after_blob"] = blob(pathlib.Path(request["target"]).read_bytes())
        append_record(attach_change(record, request))
        return result
    except (OSError, ValueError) as exc:
        result = fail(str(exc), 64)
        result["id"] = ident
        return result


def _idempotency_replay(request):
    key = request.get("request_key")
    if not key or is_read_only(request):
        return None
    claims = [record for record in journal_records()
              if record.get("op") == "request"
              and record.get("request_key") == key
              and record.get("uid") == request.get("_peer_uid", -1)]
    fingerprint = request_fingerprint(request)
    conflict = next((record for record in claims
                     if record.get("request_fingerprint") != fingerprint), None)
    if conflict:
        return structured_error(
            "request_key_conflict",
            "request_key was already used for a different mutation",
            remediation="generate a new request_key or resend the original request unchanged",
            details={"request_id": conflict.get("id"),
                     "original_operation": conflict.get("request_op")},
        )
    terminal = next((record for record in reversed(claims)
                     if record.get("state") == "finished"), None)
    if terminal:
        response = normalize_response(terminal.get("response", {}))
        response["idempotent_replay"] = True
        return response
    started = next((record for record in claims if record.get("state") == "started"), None)
    if started:
        operation = next((record for record in reversed(journal_records())
                          if record.get("request_key") == key
                          and record.get("op") != "request"), None)
        response = structured_error(
            "request_in_progress",
            "a request with this request_key is already in progress",
            exit_code=75,
            retryable=True,
            remediation="query operation_get before deciding whether to retry",
            details={"request_id": started["id"],
                     "operation_id": operation.get("id") if operation else None},
        )
        response["id"] = operation.get("id", started["id"]) if operation else started["id"]
        return response
    return None


def request_fingerprint(request):
    semantic = {key: value for key, value in request.items()
                if not str(key).startswith("_peer_")
                and key not in ("client", "protocol_version", "schema_version",
                               "trace", "transport", "client_sent_at")}
    return hashlib.sha256(json.dumps(semantic, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _claim_request(request):
    key = request.get("request_key")
    if not key or is_read_only(request):
        return None
    ident = str(uuid.uuid4())
    append_record(record_for(
        request, id=ident, at=now(), uid=request.get("_peer_uid", -1),
        op="request", request_op=request.get("op"),
        request_fingerprint=request_fingerprint(request), state="started"))
    return ident


def _finish_claim(request, claim_id, response):
    if not claim_id:
        return
    retained = {key: value for key, value in normalize_response(response).items()
                if key not in ("stdout", "stderr", "data")}
    retained["stdout"] = ""
    retained["stderr"] = response.get("error", {}).get("message", "") + (
        "\n" if response.get("error") else "")
    append_record(record_for(
        request, id=claim_id, at=now(), uid=request.get("_peer_uid", -1),
        op="request", request_op=request.get("op"), state="finished",
        request_fingerprint=request_fingerprint(request),
        operation_id=response.get("id"), response=retained))


def handle(request, emit=lambda _frame: None):
    # The lock is the transaction boundary. In particular, no other privileged
    # request can run between a package snapshot and its package subprocess.
    try:
        validate_envelope(request)
    except StaleRequestError as exc:
        return structured_error(
            "stale_request", str(exc), exit_code=75, retryable=True,
            remediation="inspect the operation state, then submit a fresh request",
        )
    except ValueError as exc:
        return structured_error(
            "invalid_request", str(exc),
            remediation="correct the request and retry",
        )
    if not SERIAL_LOCK.acquire(timeout=SERIAL_LANE_WAIT_SECONDS):
        return structured_error(
            "mutation_lane_busy",
            "another ASIP request is still using the serialized administration lane",
            exit_code=75, retryable=True,
            remediation="inspect the active operation through the read-only interface and retry",
        )
    try:
        try:
            # Recheck age after lock acquisition; the request can become stale
            # while it waits for another operation to finish.
            validate_envelope(request)
        except StaleRequestError as exc:
            return structured_error(
                "stale_request", str(exc), exit_code=75, retryable=True,
                remediation="inspect the operation state, then submit a fresh request",
            )
        except ValueError as exc:
            return structured_error(
                "invalid_request",
                str(exc),
                remediation="correct the request and retry",
            )
        replay = _idempotency_replay(request)
        if replay:
            return replay
        try:
            validate_intent(request)
        except ValueError as exc:
            return structured_error(
                "intent_required" if "mutation requires" in str(exc) else "invalid_request",
                str(exc),
                remediation="start an ASIP change or pass standalone_reason" if
                "mutation requires" in str(exc) else "correct the request and retry",
            )
        claim_id = None if request.get("_read_only") else _claim_request(request)
        response = normalize_response(_handle(request, emit))
        _finish_claim(request, claim_id, response)
        return response
    finally:
        SERIAL_LOCK.release()


def handle_read_only(request):
    op = request.get("op")
    action = request.get("action")
    allowed = (
        (op == "change" and action in ("list", "open", "show", "status")) or
        (op == "maintenance" and action in ("list", "history", "open")) or
        (op == "ask" and action in ("list", "show")) or
        (op == "access" and action in ("list", "show")) or
        (op == "audit-pending") or
        (op == "verify" and action == "list") or
        (op in ("log", "brief", "context", "doctor", "summary", "recovery", "facts", "operation", "journal-search", "eval-evidence", "blob", "machine-policy",
                "project-list", "drift-list"))
    )
    if not allowed:
        return fail("operation is not available through the read-only socket")
    forwarded = dict(request, _read_only=True)
    return handle(forwarded)


def protocol_failure(peer_uid, message):
    ident = str(uuid.uuid4())
    record = {"schema_version": SCHEMA_VERSION,
              "id": ident, "at": now(), "uid": peer_uid, "op": "protocol",
              "state": "failed", "error": message}
    append_record(record)
    result = fail(message)
    result["id"] = ident
    return result

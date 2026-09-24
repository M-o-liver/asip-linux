"""Pure projections and presentation for Core maintenance records.

Mutation and journaling stay in the privileged daemon. This module owns the
maintenance vocabulary and converts an explicit record sequence into bounded
status/history views, so those rules are testable without socket or root state.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Iterable, Mapping
from typing import Any


MAINTENANCE = (
    (0, "journal-review"),
    (1, "errata"),
    (1, "project-discovery"),
    (2, "system-health"),
    (2, "package-maintenance"),
    (3, "security-overview"),
    (3, "recovery-review"),
)
MAINTENANCE_NAMES = {name for _, name in MAINTENANCE}
MAINTENANCE_WHY = {
    "journal-review": "Review the ASIP journal for incomplete work and forgotten intent.",
    "errata": "Check distribution advisories relevant to this installed system.",
    "project-discovery": "Find durable projects that should be registered or updated.",
    "system-health": "Inspect failed units, logs, and live resource pressure.",
    "package-maintenance": "Review pending package updates and leftover packages.",
    "security-overview": "Review exposure, auth, and host-specific security state.",
    "recovery-review": "Confirm snapshotter, recent snapshots, and rollback route.",
}


def completed_tasks(record: Mapping[str, Any]) -> list[str]:
    """Return only the roles a finish record actually completed."""
    if record.get("action") != "finish":
        return []
    explicit = record.get("completed")
    if isinstance(explicit, list) and explicit:
        return [task for task in explicit if task in MAINTENANCE_NAMES]
    covered = record.get("covered") or []
    started = record.get("tasks") or []
    if covered:
        return [task for task in covered if task in MAINTENANCE_NAMES]
    return [task for task in started if task in MAINTENANCE_NAMES]


def status(records: Iterable[Mapping[str, Any]], *, current: dt.datetime | None = None) -> dict[str, Any]:
    """Project journal records into structured obligation state, not a planner."""
    completed: dict[str, Any] = {}
    policies: dict[str, Any] = {}
    omitted: dict[str, dict[str, Any]] = {}
    for record in records:
        if record.get("op") != "maintenance":
            continue
        action = record.get("action")
        if action == "finish":
            for task in completed_tasks(record):
                completed[task] = record.get("at", "unknown")
        elif action == "backfill":
            task = record.get("task")
            if task in MAINTENANCE_NAMES:
                completed[task] = record.get("observed_at", "unknown")
        elif action == "policy":
            task = record.get("task")
            if task in MAINTENANCE_NAMES:
                policies[task] = record.get("cadence_days")
                omitted.pop(task, None)
        elif action == "omit":
            task = record.get("task")
            if task in MAINTENANCE_NAMES:
                omitted[task] = {"reason": record.get("reason", ""), "at": record.get("at", "unknown")}
        elif action == "unomit":
            omitted.pop(record.get("task"), None)
    current = current or dt.datetime.now(dt.timezone.utc)
    tasks = []
    for tier, task in MAINTENANCE:
        last = completed.get(task)
        cadence = policies.get(task)
        due_at = None
        omit = omitted.get(task)
        if omit:
            due_state = "omitted"
        elif cadence is None:
            due_state = "unconfigured"
        elif not last:
            due_state = "due"
        else:
            try:
                observed = dt.datetime.fromisoformat(str(last).replace("Z", "+00:00"))
                if observed.tzinfo is None:
                    observed = observed.replace(tzinfo=dt.timezone.utc)
                due_at = (observed + dt.timedelta(days=cadence)).date().isoformat()
                due_state = "due" if current.date().isoformat() >= due_at else "ok"
                if due_state == "due" and last != "never":
                    due_state = "overdue" if current >= observed + dt.timedelta(days=cadence) else "due"
            except ValueError:
                due_state = "invalid"
        tasks.append({
            "name": task, "tier": tier, "last_completed": last,
            "cadence_days": cadence, "due_at": due_at, "due_state": due_state,
            "why": MAINTENANCE_WHY[task],
            "start": f"asip --change ID maintenance start {task}",
            "omit_reason": omit.get("reason") if omit else None,
            "omitted_at": omit.get("at") if omit else None,
        })
    return {
        "tasks": tasks,
        "due_now": [item["name"] for item in tasks if item["due_state"] in {"due", "overdue"}],
        "overdue": [item["name"] for item in tasks if item["due_state"] == "overdue"],
        "unconfigured": [item["name"] for item in tasks if item["due_state"] == "unconfigured"],
        "omitted": [item["name"] for item in tasks if item["due_state"] == "omitted"],
        "semantics": {
            "start": "Opens a session for the named roles. Does not mark them complete.",
            "finish": "Closes the session. Completes --covered roles if supplied, otherwise every started role.",
            "fail": "Closes the session without completing any role.",
            "omit": "Durable decision that a role is not an obligation, with a reason.",
            "unomit": "Clears an omit decision. The role becomes unconfigured unless a policy exists.",
            "unconfigured": "No cadence and not omitted. The obligation has not been decided.",
            "omitted": "Intentionally not an obligation. Distinct from unconfigured.",
            "session_handoff": "Any asip member may finish or fail an open session. Chat history is not required.",
        },
    }


def list_text(projected: Mapping[str, Any]) -> str:
    lines = [
        "Maintenance tasks are ordered by expected token cost.",
        "Higher tiers generally require more inspection and judgment.",
        "Perform selected roles on this host. ASIP records the work; it is not the subject of the review.",
        "Use the live system and MACHINE.md. Recommend native tools that materially improve recurring work.",
        "When operator policy permits, install them through ASIP and record their package provenance.",
        "Advance a role with: asip --change ID maintenance start TASK", "",
    ]
    for item in projected["tasks"]:
        last = item["last_completed"] or "never"
        if item["due_state"] == "omitted":
            due = "omitted — %s" % (item["omit_reason"] or "no reason")
        elif item["due_state"] == "unconfigured":
            due = "not configured"
        elif item["due_state"] == "due" and not item["last_completed"]:
            due = "now (every %sd)" % item["cadence_days"]
        elif item["due_state"] == "overdue":
            due = "%s (overdue)" % (item["due_at"] or "now")
        elif item["due_state"] == "due":
            due = "%s (due)" % (item["due_at"] or "now")
        elif item["due_state"] == "invalid":
            due = "invalid completion date"
        else:
            due = item["due_at"] or "ok"
        lines.append("[%d] %-20s Last completed: %-25s Due: %s" %
                     (item["tier"], item["name"], last, due))
    return "\n".join(lines) + "\n"


def history_data(records: Iterable[Mapping[str, Any]], *, open_only: bool = False) -> dict[str, Any]:
    records = list(records)
    closed = {record.get("session") for record in records
              if record.get("op") == "maintenance" and record.get("action") in ("finish", "fail")}
    items, open_sessions = [], []
    for record in records:
        if record.get("op") != "maintenance":
            continue
        action = record.get("action", "unknown")
        session = record.get("session", record.get("id"))
        item = {
            "id": record.get("id"), "at": record.get("at", "unknown"),
            "action": action, "session": session, "task": record.get("task"),
            "tasks": list(record.get("tasks") or []),
            "completed": completed_tasks(record) if action == "finish" else [],
            "reason": record.get("reason", ""), "cadence_days": record.get("cadence_days"),
            "observed_at": record.get("observed_at"), "change_id": record.get("change_id"),
            "uid": record.get("uid"),
        }
        if action == "start" and record.get("id") not in closed:
            open_sessions.append({
                "session": record.get("id"), "at": record.get("at", "unknown"),
                "tasks": list(record.get("tasks") or []), "change_id": record.get("change_id"),
                "uid": record.get("uid"),
                "finish": "asip --change ID maintenance finish %s [--covered TASK,...] SUMMARY" % record.get("id"),
                "fail": "asip --change ID maintenance fail %s REASON" % record.get("id"),
            })
        if open_only and (action != "start" or record.get("id") in closed):
            continue
        items.append(item)
    return {"records": items, "open_sessions": open_sessions}


def history_text(projected: Mapping[str, Any], *, open_only: bool = False) -> str:
    lines = []
    for item in projected["records"]:
        if item["action"] in ("policy", "backfill", "omit", "unomit"):
            if item["action"] == "policy":
                detail = "every %sd" % item["cadence_days"]
            elif item["action"] == "backfill":
                detail = "%s — %s" % (item["observed_at"], item["reason"])
            else:
                detail = item["reason"]
            lines.append("%s  %-8s  %-20s  %s" %
                         (item["at"], item["action"], item["task"] or "unknown", detail))
            continue
        tasks = ",".join(item["tasks"])
        extra = ""
        if item["action"] == "finish" and item["completed"]:
            extra = " completed=%s" % ",".join(item["completed"])
        lines.append("%s  %-6s  %s  %s  %s%s" %
                     (item["at"], item["action"], item["session"], tasks, item["reason"], extra))
    if not lines:
        return "No open maintenance sessions.\n" if open_only else "No maintenance history.\n"
    return "\n".join(lines) + "\n"

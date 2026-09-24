"""Optional MCP v2 adapter for ASIP's Unix-socket protocol.

The adapter is deliberately unprivileged.  The selected ASIP socket remains
the authorization boundary, and the daemon remains the only root process.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import uuid
from typing import Any, Literal

from mcp import types
from mcp.server import CacheHint, MCPServer
from mcp.server.mcpserver.context import Context
from mcp.server.mcpserver.exceptions import ResourceError

from core.protocol import (
    PRIVILEGED_SOCKET,
    READ_ONLY_SOCKET,
    SCHEMA_VERSION,
    VERSION,
    UnixClient,
    structured_error,
)


ADAPTER_INSTANCE = uuid.uuid4().hex[:12]

READ_ONLY = types.ToolAnnotations(
    readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False
)
MUTATING = types.ToolAnnotations(
    readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False
)
ROOT_MUTATING = types.ToolAnnotations(
    readOnlyHint=False, destructiveHint=True, idempotentHint=False, openWorldHint=True
)
EXTERNAL_MUTATING = types.ToolAnnotations(
    readOnlyHint=False, destructiveHint=True, idempotentHint=False, openWorldHint=True
)
RESOURCE_ANNOTATIONS = types.Annotations(audience=["assistant", "user"], priority=0.8)


def _client_context(ctx: Context) -> dict[str, Any]:
    meta = ctx.request_context.meta or {}
    info = meta.get(types.CLIENT_INFO_META_KEY) or {}
    client = {
        "name": str(info.get("name", "unknown-mcp-client")),
        "version": str(info.get("version", "unknown")),
    }
    trace = {key: meta[key] for key in ("traceparent", "tracestate", "baggage") if key in meta}
    return {
        "client": client,
        "transport": "mcp",
        "protocol_version": ctx.request_context.protocol_version,
        "trace": trace or None,
    }


def _request_key(ctx: Context, supplied: str | None) -> str:
    if supplied:
        return supplied
    client = _client_context(ctx)["client"]
    request_id = ctx.request_context.request_id
    return ("mcp:%s:%s:%s" % (client["name"], ADAPTER_INSTANCE, request_id)
            if request_id is not None else "mcp:%s:%s" % (client["name"], uuid.uuid4().hex))


def _service_argv(action: str, unit: str) -> list[str]:
    """Mirror the CLI's real init-system dispatch, without adding authority.

    The resulting argv is still submitted to the normal privileged ASIP
    socket; this helper only keeps the semantic MCP adapter honest.
    """
    if shutil.which("systemctl") and os.path.isdir("/run/systemd/system"):
        return ["systemctl", action, unit]
    if shutil.which("rc-service"):
        return ["rc-service", unit, action]
    if shutil.which("service"):
        return ["service", unit, action]
    raise ValueError("no known init system found; use asip_do with the host's supported service command")


def _envelope(ctx: Context, **fields: Any) -> dict[str, Any]:
    request = {"schema_version": SCHEMA_VERSION, **_client_context(ctx), **fields}
    if request.get("trace") is None:
        request.pop("trace", None)
    return request


async def _call(socket_path: str, request: dict[str, Any]) -> dict[str, Any]:
    try:
        reply = await asyncio.to_thread(UnixClient(socket_path).call, request)
        response = dict(reply.response)
    except (ConnectionError, OSError, ValueError) as exc:
        return structured_error(
            "adapter_unavailable", str(exc), exit_code=69, retryable=True,
            remediation="check ASIP socket permissions and run asip doctor --json",
        )
    if response.get("id"):
        if request.get("op") == "change" and request.get("action") == "start":
            response.setdefault("change_id", response["id"])
        elif request.get("op") not in {
            "audit-pending", "blob", "brief", "context", "doctor", "summary", "recovery", "facts", "ask", "drift-list",
            "journal-search", "eval-evidence", "log", "machine-policy", "operation", "project-list",
        } and not (request.get("op") == "change" and request.get("action") in ("list", "open", "show", "status")) \
                and not (request.get("op") == "access" and request.get("action") in ("list", "show")) \
                and not (request.get("op") == "maintenance" and request.get("action") in ("list", "history", "open")):
            response.setdefault("operation_id", response["id"])
    for stream in ("stdout", "stderr"):
        digest = response.get(stream + "_blob")
        if digest:
            response[stream + "_resource"] = "asip://blobs/%s" % digest
    return response


async def _read(ctx: Context, op: str, **fields: Any) -> dict[str, Any]:
    request_fields = {"op": op, "argv": [], "cwd": "/", "reason": ""}
    request_fields.update(fields)
    return await _call(READ_ONLY_SOCKET, _envelope(ctx, **request_fields))


async def _resource_call(ctx: Context, op: str, **fields: Any) -> str:
    response = await _read(ctx, op, **fields)
    if not response.get("ok"):
        raise ResourceError(response.get("error", {}).get("message", "ASIP resource unavailable"))
    if "data" in response:
        return json.dumps(response["data"], separators=(",", ":"), sort_keys=True)
    return response.get("stdout", "")


async def _static_resource_call(op: str, **fields: Any) -> str:
    request = {
        "schema_version": SCHEMA_VERSION,
        "client": {"name": "asip-mcp-resource", "version": VERSION},
        "transport": "mcp",
        "op": op,
        "argv": [],
        "cwd": "/",
        "reason": "",
        **fields,
    }
    response = await _call(READ_ONLY_SOCKET, request)
    if not response.get("ok"):
        raise ResourceError(response.get("error", {}).get("message", "ASIP resource unavailable"))
    if "data" in response:
        return json.dumps(response["data"], separators=(",", ":"), sort_keys=True)
    return response.get("stdout", "")


def _manager() -> str:
    for candidate in ("dnf", "apt-get", "pacman", "zypper", "emerge", "apk", "xbps-install"):
        if shutil.which(candidate):
            return candidate
    return "unknown"


def create_server(privileged: bool = False) -> MCPServer:
    role = "admin" if privileged else "inspect"
    instructions = (
        "ASIP is the continuity and recovery boundary for this Linux machine. "
        "Call asip_brief at Linux/sysadmin entry. Surface operator-visible attention; "
        "if attention is empty, skip generic installed/refreshed announcements. "
        "Use asip_context only to bind cwd/project and a supplied change ID. "
        "On the admin server, use asip_do for every root command without a semantic tool; "
        "never invoke or ask the operator to invoke sudo. Prefer package, service, and "
        "configuration tools when they fit because they add recovery records. Ordinary "
        "unprivileged commands, including normal Git work, remain outside ASIP. "
        "Use ASIP access tools when an external task needs a credential; refer to the "
        "authority by name and never ask for or handle its stored value. Missing access "
        "becomes operator_action_required in ASIP Settings → Connected services. "
        "Operator questions are answered in ASIP Computer → Operator questions. "
        "asip-admin / group asip is root-equivalent. asip-inspect cannot mutate."
    )
    server = MCPServer(
        name="asip-%s" % role,
        title="ASIP %s" % role.capitalize(),
        description=(
            "ASIP inspect is read-only. ASIP admin is root-equivalent: the asip "
            "Unix-socket group can submit arbitrary root commands. Not a sandbox."
            if privileged else
            "Read-only ASIP inspect. Cannot execute commands or mutate the journal. "
            "Admin/root-equivalent access is a separate stdio server and socket."
        ),
        instructions=instructions,
        version=VERSION,
        cache_hints={
            "server/discover": CacheHint(ttl_ms=300_000, scope="private"),
            "tools/list": CacheHint(ttl_ms=300_000, scope="private"),
            "resources/list": CacheHint(ttl_ms=60_000, scope="private"),
            "resources/templates/list": CacheHint(ttl_ms=60_000, scope="private"),
            "resources/read": CacheHint(ttl_ms=0, scope="private"),
        },
    )

    @server.tool(name="asip_brief", annotations=READ_ONLY)
    async def asip_brief(ctx: Context) -> dict[str, Any]:
        """Deterministic agent entry: attention, caller, blocking, pending asks."""
        return await _read(ctx, "brief")

    @server.tool(name="asip_context", annotations=READ_ONLY)
    async def asip_context(ctx: Context, cwd: str = "/") -> dict[str, Any]:
        """Bind cwd/project, caller, and a supplied change ID. Not a dump of other surfaces."""
        return await _read(ctx, "context", cwd=cwd)

    @server.tool(name="asip_summary", annotations=READ_ONLY)
    async def asip_summary(ctx: Context) -> dict[str, Any]:
        """Get bounded product health and aggregate statistics for ASIP."""
        return await _read(ctx, "summary")

    @server.tool(name="change_list", annotations=READ_ONLY)
    async def change_list(ctx: Context, status: Literal["all", "open"] = "open") -> dict[str, Any]:
        """List this Unix user's changes. status=open is literally status=open; all is history."""
        return await _read(ctx, "change", action="open" if status == "open" else "list")

    @server.tool(name="change_get", annotations=READ_ONLY)
    async def change_get(ctx: Context, change_id: str) -> dict[str, Any]:
        """Get one change. This is the inspect for a known change ID."""
        return await _read(ctx, "change", action="show", argv=[change_id])

    @server.tool(name="operation_get", annotations=READ_ONLY)
    async def operation_get(ctx: Context, operation_id: str) -> dict[str, Any]:
        """Recover the status and journal metadata for a durable ASIP operation handle."""
        return await _read(ctx, "operation", argv=[operation_id])

    @server.tool(name="journal_search", annotations=READ_ONLY)
    async def journal_search(
        ctx: Context,
        change_id: str | None = None,
        operation: str | None = None,
        state: str | None = None,
        cursor: int = 0,
        limit: int = 50,
    ) -> dict[str, Any]:
        """Search recent structured records with bounded, cursor-based output."""
        return await _read(ctx, "journal-search", change_id=change_id, operation=operation,
                           state=state, cursor=cursor, limit=limit)

    @server.tool(name="eval_evidence", annotations=READ_ONLY)
    async def eval_evidence(ctx: Context, change_id: str) -> dict[str, Any]:
        """Get bounded, output-free lifecycle facts for one ASIP eval change."""
        return await _read(ctx, "eval-evidence", argv=[change_id])

    @server.tool(name="asip_recovery", annotations=READ_ONLY)
    async def asip_recovery(ctx: Context) -> dict[str, Any]:
        """Get the live Snapper timeline and journal snapshot IDs. Read-only."""
        return await _read(ctx, "recovery")

    @server.tool(name="asip_ask", annotations=READ_ONLY)
    async def asip_ask(
        ctx: Context,
        action: Literal["list", "show"] = "list",
        question_id: str = "",
    ) -> dict[str, Any]:
        """List or show operator questions. Answering is a human action, not an MCP tool."""
        if action == "show":
            return await _read(ctx, "ask", action="show", argv=[question_id] if question_id else [])
        return await _read(ctx, "ask", action="list")

    @server.tool(name="access_list", annotations=READ_ONLY)
    async def access_list(ctx: Context, name: str = "") -> dict[str, Any]:
        """Discover named external authority without exposing stored credential values."""
        if name:
            return await _read(ctx, "access", action="show", argv=[name], name=name)
        return await _read(ctx, "access", action="list")

    @server.tool(name="asip_facts", annotations=READ_ONLY)
    async def asip_facts(
        ctx: Context,
        action: Literal["catalog", "get"] = "catalog",
        spec: str = "",
    ) -> dict[str, Any]:
        """Get bounded live machine facts. Held work is change_get, not facts."""
        if action == "get":
            return await _read(ctx, "facts", action="get", argv=[spec] if spec else [])
        return await _read(ctx, "facts", action="catalog")

    @server.tool(name="asip_maintenance", annotations=READ_ONLY)
    async def asip_maintenance(
        ctx: Context,
        action: Literal["list", "history", "open"] = "list",
    ) -> dict[str, Any]:
        """Get maintenance obligation state, history, or open sessions."""
        return await _read(ctx, "maintenance", action=action)

    @server.resource("asip://machine/brief", annotations=RESOURCE_ANNOTATIONS)
    async def machine_brief() -> str:
        """Deterministic agent brief. Same reducer as asip_brief."""
        return await _static_resource_call("brief")

    @server.resource("asip://machine/policy", annotations=RESOURCE_ANNOTATIONS)
    async def machine_policy() -> str:
        """Full canonical machine policy and durable decision log."""
        return await _static_resource_call("machine-policy")

    @server.resource("asip://changes/open", annotations=RESOURCE_ANNOTATIONS)
    async def open_changes() -> str:
        """Changes whose daemon status is open. Held work is not included."""
        return await _static_resource_call("change", action="open")

    @server.resource("asip://changes/{change_id}", annotations=RESOURCE_ANNOTATIONS)
    async def change_resource(change_id: str, ctx: Context) -> str:
        return await _resource_call(ctx, "change", action="show", argv=[change_id])

    @server.resource("asip://operations/{operation_id}", annotations=RESOURCE_ANNOTATIONS)
    async def operation_resource(operation_id: str, ctx: Context) -> str:
        return await _resource_call(ctx, "operation", argv=[operation_id])

    @server.resource("asip://audit/pending", annotations=RESOURCE_ANNOTATIONS)
    async def pending_audit() -> str:
        return await _static_resource_call("audit-pending")

    @server.resource("asip://maintenance/status", annotations=RESOURCE_ANNOTATIONS)
    async def maintenance_status() -> str:
        return await _static_resource_call("maintenance", action="list")

    @server.resource("asip://recovery", annotations=RESOURCE_ANNOTATIONS)
    async def recovery_resource() -> str:
        return await _static_resource_call("recovery")

    @server.resource("asip://ask/pending", annotations=RESOURCE_ANNOTATIONS)
    async def ask_pending() -> str:
        return await _static_resource_call("ask", action="list")

    @server.resource("asip://access", annotations=RESOURCE_ANNOTATIONS)
    async def access_catalog_resource() -> str:
        """Named external authority states. Credential values are never returned."""
        return await _static_resource_call("access", action="list")

    @server.resource("asip://facts", annotations=RESOURCE_ANNOTATIONS)
    async def facts_resource() -> str:
        return await _static_resource_call("facts", action="catalog")

    @server.resource("asip://projects/index", annotations=RESOURCE_ANNOTATIONS)
    async def projects_index() -> str:
        return await _static_resource_call("project-list")

    @server.resource("asip://drift", annotations=RESOURCE_ANNOTATIONS)
    async def drift() -> str:
        return await _static_resource_call("drift-list")

    @server.resource("asip://blobs/{digest}", annotations=RESOURCE_ANNOTATIONS)
    async def blob_resource(digest: str, ctx: Context) -> str:
        return await _resource_call(ctx, "blob", argv=[digest], offset=0, limit=65536)

    if not privileged:
        return server

    async def mutate(ctx: Context, op: str, *, change_id: str | None,
                     standalone_reason: str | None, request_key: str | None,
                     **fields: Any) -> dict[str, Any]:
        request = _envelope(
            ctx, op=op, cwd=fields.pop("cwd", "/"), reason=fields.pop("reason", ""),
            argv=fields.pop("argv", []), request_key=_request_key(ctx, request_key),
            **fields,
        )
        if change_id:
            request["change_id"] = change_id
        if standalone_reason:
            request["standalone_reason"] = standalone_reason
        return await _call(PRIVILEGED_SOCKET, request)

    @server.tool(name="change_start", annotations=MUTATING)
    async def change_start(ctx: Context, intent: str,
                           request_key: str | None = None) -> dict[str, Any]:
        """Start coherent machine work and return the explicit change_id handle."""
        request = _envelope(ctx, op="change", action="start", argv=[intent], cwd="/", reason="",
                            request_key=_request_key(ctx, request_key))
        return await _call(PRIVILEGED_SOCKET, request)

    @server.tool(name="change_close", annotations=MUTATING)
    async def change_close(
        ctx: Context,
        change_id: str,
        status: Literal["finish", "fail", "supersede"],
        summary: str,
        replacement_change_id: str | None = None,
        request_key: str | None = None,
    ) -> dict[str, Any]:
        """Finish, fail, or explicitly supersede a durable change."""
        argv = ([change_id, replacement_change_id, summary]
                if status == "supersede" and replacement_change_id
                else [change_id, summary])
        request = _envelope(ctx, op="change", action=status, argv=argv, cwd="/", reason="",
                            request_key=_request_key(ctx, request_key))
        return await _call(PRIVILEGED_SOCKET, request)

    @server.tool(name="change_gate", annotations=MUTATING)
    async def change_gate(
        ctx: Context,
        change_id: str,
        action: Literal["hold", "release"],
        reason: str,
        kind: Literal["reboot_window", "operator", "predecessor", "deferred"] | None = None,
        unblock: str | None = None,
        request_key: str | None = None,
    ) -> dict[str, Any]:
        """Hold or release known work. ASIP records the gate and never decides actionability."""
        request = _envelope(ctx, op="change", action=action,
                            argv=[change_id, reason], cwd="/", reason="",
                            request_key=_request_key(ctx, request_key))
        if action == "hold":
            request.update({"kind": kind, "unblock": unblock})
        return await _call(PRIVILEGED_SOCKET, request)

    @server.tool(name="asip_do", annotations=ROOT_MUTATING)
    async def asip_do(
        ctx: Context,
        argv: list[str],
        change_id: str | None = None,
        standalone_reason: str | None = None,
        cwd: str = "/",
        env: dict[str, str] | None = None,
        affects: list[str] | None = None,
        sensitive: bool = False,
        request_key: str | None = None,
    ) -> dict[str, Any]:
        """Run every otherwise-unsupported root command through ASIP; never use sudo."""
        return await mutate(ctx, "do", change_id=change_id, standalone_reason=standalone_reason,
                            request_key=request_key, argv=argv, cwd=cwd, env=env or {},
                            affects=affects or [], sensitive=sensitive,
                            reason=standalone_reason or "privileged command through MCP")

    @server.tool(name="access_request", annotations=MUTATING)
    async def access_request_tool(
        ctx: Context,
        name: str,
        label: str,
        env_var: str,
        change_id: str | None = None,
        standalone_reason: str | None = None,
        request_key: str | None = None,
    ) -> dict[str, Any]:
        """Request named external authority. The operator supplies its value locally; the model never does."""
        return await mutate(ctx, "access", change_id=change_id,
                            standalone_reason=standalone_reason, request_key=request_key,
                            action="request", name=name, label=label, env_var=env_var,
                            argv=[name], reason="request external authority %s" % name)

    @server.tool(name="access_use", annotations=EXTERNAL_MUTATING)
    async def access_use(
        ctx: Context,
        name: str,
        argv: list[str],
        change_id: str | None = None,
        standalone_reason: str | None = None,
        cwd: str = "/",
        request_key: str | None = None,
    ) -> dict[str, Any]:
        """Run one userland operation with named external authority attached only to that child process."""
        return await mutate(ctx, "access", change_id=change_id,
                            standalone_reason=standalone_reason, request_key=request_key,
                            action="use", name=name, argv=argv, cwd=cwd,
                            reason="use external authority %s" % name)

    @server.tool(name="access_start", annotations=EXTERNAL_MUTATING)
    async def access_start(
        ctx: Context,
        name: str,
        argv: list[str],
        change_id: str | None = None,
        standalone_reason: str | None = None,
        cwd: str = "/",
        request_key: str | None = None,
    ) -> dict[str, Any]:
        """Start a long-lived userland process with named authority and return promptly without captured pipes."""
        return await mutate(ctx, "access", change_id=change_id,
                            standalone_reason=standalone_reason, request_key=request_key,
                            action="start", name=name, argv=argv, cwd=cwd,
                            reason="start with external authority %s" % name)

    @server.tool(name="package_manage", annotations=ROOT_MUTATING)
    async def package_manage(
        ctx: Context,
        action: Literal["install", "remove"],
        packages: list[str],
        change_id: str | None = None,
        standalone_reason: str | None = None,
        request_key: str | None = None,
    ) -> dict[str, Any]:
        """Install or remove packages with snapshot and provenance semantics."""
        return await mutate(ctx, "pkg", change_id=change_id, standalone_reason=standalone_reason,
                            request_key=request_key, argv=packages, manager=_manager(), action=action,
                            reason="package %s: %s" % (action, " ".join(packages)))

    @server.tool(name="service_manage", annotations=ROOT_MUTATING)
    async def service_manage(
        ctx: Context,
        action: str,
        unit: str,
        change_id: str | None = None,
        standalone_reason: str | None = None,
        request_key: str | None = None,
    ) -> dict[str, Any]:
        """Manage a service through the recorded privileged boundary."""
        return await mutate(ctx, "svc", change_id=change_id, standalone_reason=standalone_reason,
                            request_key=request_key, argv=_service_argv(action, unit),
                            reason="service %s: %s" % (action, unit))

    @server.tool(name="configuration_apply", annotations=ROOT_MUTATING)
    async def configuration_apply(
        ctx: Context,
        target: str,
        argv: list[str],
        change_id: str | None = None,
        standalone_reason: str | None = None,
        request_key: str | None = None,
    ) -> dict[str, Any]:
        """Run a root command and capture the target configuration before and after."""
        return await mutate(ctx, "conf", change_id=change_id, standalone_reason=standalone_reason,
                            request_key=request_key, argv=argv, target=target,
                            reason="configuration change: %s" % target)

    @server.tool(name="note_record", annotations=MUTATING)
    async def note_record(ctx: Context, change_id: str, subject: str, why: str,
                          request_key: str | None = None) -> dict[str, Any]:
        """Attach one important userland path or effect to an open change."""
        return await mutate(ctx, "note", change_id=change_id, standalone_reason=None,
                            request_key=request_key, argv=[subject], reason=why)

    @server.tool(name="observation_record", annotations=MUTATING)
    async def observation_record(ctx: Context, change_id: str, subject: str,
                                 description: str, source: str = "inspection",
                                 evidence: str = "", request_key: str | None = None) -> dict[str, Any]:
        """Record one already-observed external effect without elevating the underlying userland work."""
        return await mutate(ctx, "observe", change_id=change_id, standalone_reason=None,
                            request_key=request_key, argv=[subject], reason=description,
                            source=source, evidence=evidence)

    @server.tool(name="verification_record", annotations=MUTATING)
    async def verification_record(
        ctx: Context,
        result: Literal["pass", "fail"],
        tool: str,
        note: str,
        evidence_ids: list[str] | None = None,
        change_id: str | None = None,
        standalone_reason: str | None = None,
        request_key: str | None = None,
    ) -> dict[str, Any]:
        """Record an in-situ result with optional journal evidence handles."""
        return await mutate(ctx, "verify", change_id=change_id, standalone_reason=standalone_reason,
                            request_key=request_key, argv=[tool, note], action=result,
                            references=evidence_ids or [])

    @server.tool(name="snapshot_create", annotations=ROOT_MUTATING)
    async def snapshot_create(ctx: Context, reason: str, change_id: str | None = None,
                              standalone_reason: str | None = None,
                              request_key: str | None = None) -> dict[str, Any]:
        """Create an ASIP-recorded recovery snapshot when Snapper is available."""
        return await mutate(ctx, "snap", change_id=change_id, standalone_reason=standalone_reason,
                            request_key=request_key, argv=["snapshot"], reason=reason)

    @server.tool(name="snapshot_rollback", annotations=ROOT_MUTATING)
    async def snapshot_rollback(ctx: Context, snapshot_operation_id: str,
                                change_id: str | None = None,
                                standalone_reason: str | None = None,
                                request_key: str | None = None) -> dict[str, Any]:
        """Run the Snapper-only rollback referenced by an ASIP snapshot operation."""
        return await mutate(ctx, "rollback", change_id=change_id,
                            standalone_reason=standalone_reason, request_key=request_key,
                            argv=[snapshot_operation_id], reason="rollback snapshot %s" % snapshot_operation_id)

    @server.tool(name="maintenance_update", annotations=MUTATING)
    async def maintenance_update(ctx: Context, action: str, arguments: list[str],
                                 change_id: str | None = None,
                                 standalone_reason: str | None = None,
                                 request_key: str | None = None) -> dict[str, Any]:
        """Start, close, backfill, or set policy for a maintenance role."""
        return await mutate(ctx, "maintenance", change_id=change_id,
                            standalone_reason=standalone_reason, request_key=request_key,
                            argv=arguments, action=action)

    @server.tool(name="project_update", annotations=MUTATING)
    async def project_update(ctx: Context, action: Literal["set", "remove"], arguments: list[str],
                             description: str = "project registered through ASIP",
                             change_id: str | None = None,
                             standalone_reason: str | None = None,
                             request_key: str | None = None) -> dict[str, Any]:
        """Set or remove an idempotent project registry entry."""
        return await mutate(ctx, "project", change_id=change_id,
                            standalone_reason=standalone_reason, request_key=request_key,
                            argv=arguments, action=action, reason=description)

    @server.tool(name="drift_decide", annotations=MUTATING)
    async def drift_decide(ctx: Context, decision: Literal["ignore", "documented", "managed-by-project"],
                           item: str, why: str, change_id: str | None = None,
                           standalone_reason: str | None = None,
                           request_key: str | None = None) -> dict[str, Any]:
        """Record a durable decision for an accepted drift finding."""
        return await mutate(ctx, "drift-decision", change_id=change_id,
                            standalone_reason=standalone_reason, request_key=request_key,
                            argv=[item], action=decision, reason=why)

    return server


def inspect_main() -> None:
    create_server(privileged=False).run(transport="stdio")


def admin_main() -> None:
    create_server(privileged=True).run(transport="stdio")


if __name__ == "__main__":
    admin_main() if os.environ.get("ASIP_MCP_ROLE") == "admin" else inspect_main()

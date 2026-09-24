# ASIP architecture

ASIP is a single-host Linux privileged execution and continuity layer. It
records agent-requested work and invokes host tools under an explicit local
authority boundary. ASIP is not a sandbox or policy-enforced command allowlist;
admin socket access is root-equivalent.

## Process and trust map

| Component | User | Boundary and role |
|---|---|---|
| `asip` CLI | Login user | Unprivileged local client for administration and inspection |
| `asip-inspect` | Login user | Unprivileged read-only client |
| MCP adapter | Login user | Stdio-only adapter that forwards typed requests to a Core socket |
| `asipd` admin service | Root | Validates and serializes privileged operations from `/run/asip/sock` |
| Read-only daemon | Root | Handles a fixed inspection request set from `/run/asip/read.sock` |
| systemd socket units | systemd/root | Own and create the Unix sockets with their configured group and mode |
| Snapper | Root/system tool | Optional snapshot and rollback backend |
| Linux Audit | Kernel/auditd | Optional process/file-mode evidence collected by the installer |

The normal admin socket is `root:asip` mode `0660`. Membership in `asip` grants
arbitrary root authority. The read-only socket is normally `root:asip-read`
mode `0660`; `asip-read` permits inspection of potentially sensitive records
but not command execution or journal mutation. The daemon reads peer PID, UID,
and primary GID using `SO_PEERCRED` for attribution. Socket DAC is the
authorization boundary.

MCP is local stdio and does not expose a Core network listener. An agent with
admin socket access can nevertheless request arbitrary root commands through
`asip_do`, so the MCP adapter is not a sandbox.

## Persistent state

| Path | Contents and owner |
|---|---|
| `/etc/asip/MACHINE.md` | Root-owned machine instructions, safety context, and recovery facts |
| `/etc/asip/projects.md`, `/etc/asip/drift.md` | Root-owned local project and drift context |
| `/var/lib/asip/journal.jsonl` | Root-owned, group-readable append-oriented changes and operation events |
| `/var/lib/asip/blobs/` | Content-addressed command output and configuration copies |
| `/var/lib/asip/access/` | Root-owned, mode-restricted external authority records |
| `/run/asip/sock`, `/run/asip/read.sock` | systemd-owned local admin and read-only sockets |
| User XDG directories | MCP adapter and agent harness configuration |

Journal records are individually appended and fsynced. They are not a
cryptographic chain and root can alter or remove them. Captured command output
can contain secrets; administrators should choose `do --sensitive` when raw
output must not be retained.

## Mutation path

```text
human or agent
   │
   ├── CLI ─────────────┐
   └── stdio MCP ───────┤
                       ▼
               unprivileged client
                       │ JSON line, local Unix socket
                /run/asip/sock
                       │ systemd DAC + SO_PEERCRED attribution
                       ▼
              root asipd service
                       │ validate intent, serialize, journal start
                       ▼
        package/service/config/do/snapshot command
                       │ output capture, fsync terminal record
                       ▼
             journal and blob store
```

The request frame is JSON terminated by a newline and is limited to 1 MiB.
Socket reads have a deadline. The daemon accepts a bounded number of IPC
connections concurrently, while one serialized execution lane protects
operations such as “snapshot, then package command.” A request that cannot get
the lane within five seconds receives a retryable busy response. Standard ASIP
clients attach their send time; requests left queued for over 60 seconds,
including across a daemon restart, are rejected as stale instead of being run
after the caller may have given up.

A foreground child runs directly from an argv array; ASIP does not invoke a
shell on its behalf. Its environment starts with a fixed system `PATH` and can
include caller-supplied entries. The request can select an existing working
directory. Since the caller is root-equivalent, these are execution details,
not a security sandbox.

Foreground commands are limited to 15 minutes; synchronous `access_use`
commands have a five-minute limit. On expiry ASIP signals the command's process
group, records a failed operation with `timed_out=true`, preserves captured
output, and releases the request lane. `access_start` is the detached path for
long-lived credential-bound processes. Operating system states that cannot be
killed immediately, or descendants that leave that process group, can outlive
the timeout; effects may be partial. The service does not automatically roll
those effects back. systemd restarts either Core daemon after a process
failure; a timeout is recorded as an operation failure and does not require a
daemon restart.

If the daemon restarts with an operation still in `started`, it appends an
`interrupted` event with an uncertain outcome. A request-key claim is closed
with a stable uncertainty response so retries do not automatically repeat the
command. Inspect the operation and actual host state before deciding whether
to retry.

## Recovery and audit

Package changes create a pre-change Snapper snapshot when `snapper` is
available. Configuration operations capture a before/after file copy when a
regular file exists at the requested target. These aids are not transactional:
package managers, services, network requests, and arbitrary commands may have
effects outside a snapshot or captured file.

The automated `rollback` command accepts only the ASIP journal handle for a
successful Snapper snapshot and invokes `snapper rollback`. ASIP does not
provide generic undo. Without Snapper, operations can still be journaled and
verified, but automatic filesystem rollback is unavailable. Linux Audit
integration records selected file-mode changes when the installer and host
audit policy support it.

## Source layout

| Path | Purpose |
|---|---|
| `core/server.py`, `core/daemon.py` | Unix transports, validation, journal, and operation dispatch |
| `core/protocol.py`, `core/client.py` | Request/response contract and Unix client |
| `asip`, `asip-inspect`, `cli/asip.sh` | Human-facing CLI entrypoints |
| `asip_mcp.py` | Stdio MCP adapter; no independent privilege authority |
| `installer/`, `install.sh` | User-level release staging and explicit privileged installation |
| `systemd/` | Core socket and service units |
| `tests/` | Unit, contract, installer, and optional live-host coverage |

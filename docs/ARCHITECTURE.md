# Architecture

ASIP is a local Linux operation and continuity layer. Socket permissions are
the authority boundary; the admin group is root-equivalent.

| Component | Role |
|---|---|
| `core/server.py` | Root Unix-socket servers, bounded connections, kernel peer identity |
| `core/daemon.py` | Validation, serialization, execution, journal, recovery and named access |
| `core/facts.py`, `core/maintenance.py` | Focused inspection and durable maintenance state |
| `core/protocol.py`, `core/client.py` | Bounded newline JSON IPC and unprivileged client |
| `cli/asip.sh` | Human CLI; `asip-inspect` restricts it to inspection |
| `asip_mcp.py` | Two local stdio adapters: ten inspection tools and eighteen mutation tools |
| `desktop/` | User GTK4/WebKit application, Codex runtime and credential broker |
| `scripts/install_system.sh`, `scripts/install_user.py` | Source installation and optional user environments |
| `systemd/` | Two socket units and two daemon services |

## State

`/etc/asip/MACHINE.md` holds machine-specific instructions and recovery facts.
Project registrations and drift decisions also live under `/etc/asip`.
`/var/lib/asip/journal.jsonl` records changes, operation events, holds, notes,
verification and maintenance. Blobs store captured output/configuration copies.
Authority records live in a separate root-only access directory.

Socket results use short journal references such as `j9ad4c53d`. They resolve
to the unchanged full IDs in the journal. Colliding prefixes expand; ambiguous
input fails. Full IDs remain valid. References carry no authority.

User runtimes live under `$XDG_DATA_HOME/asip` (normally `~/.local/share/asip`).
The application's private state, cached conversations and separate Codex homes
live under `$XDG_STATE_HOME/asip/desktop` (normally `~/.local/state/asip/desktop`).
Git contains software, not this machine's policy, credentials or journal.

## Operation lifecycle

An unprivileged CLI, MCP or application client sends a bounded JSON request to
one socket. The admin daemon validates intent and claims a UID-scoped retry
key before entering its serialized mutation lane. Commands run from argv with
stdin closed, bounded deadlines and process-group cancellation. Capture uses
disk spools with short excerpts and explicit truncation metadata.

Read requests do not claim retry keys or write the journal. They can proceed
while a mutation runs. A caller-bound path probe drops privilege before reading
file content. Cancellation bypasses the mutation queue. Nested mutations from
an active command child fail promptly rather than deadlocking the lane.

Terminal state is fsynced. A caller disconnect does not undo accepted work.
On startup, unfinished claims/operations are reconciled with uncertainty, not
replayed. A self-restart is recorded and replied to before its systemd job is
submitted. Detached authority children retain PID/start identity and acquire
an exit record when reaped; an unknown result after restart remains unknown.

## Agent and application surfaces

MCP emits one compact JSON result and short errors. Change/operation summaries
and ten-entry history pages expand only when requested. Output is retrieved
by operation ID in bounded chunks. Full policy remains a resource, with an
index and exact-heading subresources for focused later recovery.

The application has Ask, This computer, History and Settings. It displays
literal open/held work, questions, recovery, maintenance, verification and
operation details. Conversation state is provider-specific and saved before
turn execution. Provider reconnect is transactional: a failed candidate leaves
the old connection intact. The Gemini Chat Completions adapter supports function
tools; unsupported hosted web-search/namespace tools are disabled for it.

Installation backs up existing installed payloads, stages source and writes
four units. It does not fetch system packages or schedule a delayed restart.
Optional user runtimes are fingerprinted, prepared under a lock, then activated
with atomic launcher replacement. Running services need an explicit restart
when their source changes.

See [the security model](../SECURITY.md) for authority and recovery limits.

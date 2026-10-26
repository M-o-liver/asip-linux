# Local architecture

This guide describes the current Beacon implementation. [Setup](ALPHA.md) owns
installation steps; [cloud architecture](cloud/README.md) owns hosted behavior.

## Code map

| Component            | Source                                                                                                             | Responsibility                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Desktop process      | [main.cjs](beacon/main.cjs), [desktop.cjs](beacon/desktop.cjs), [startup.cjs](beacon/startup.cjs)                  | Electron lifecycle, encrypted storage, native windows, login startup         |
| Local service        | [runtime.mjs](beacon/runtime.mjs)                                                                                  | Account storage, plugin grants, record/recall, local HTTP service, API audit |
| Native plugins       | [plugins.mjs](scripts/plugins.mjs), [main.go](plugin-helper/main.go), [transcript.go](plugin-helper/transcript.go) | Bundles, MCP tools, lifecycle hooks, native conversation evidence            |
| Managed installation | [agent-plugins.mjs](beacon/agent-plugins.mjs), [plugin-archive.mjs](beacon/plugin-archive.mjs)                     | Provider installation and ZIP generation                                     |
| Records              | [trace.mjs](beacon/trace.mjs), [project.mjs](beacon/project.mjs)                                                   | Trace redaction, project identity                                            |
| API connections      | [connections.mjs](beacon/connections.mjs)                                                                          | Encrypted credentials, provider requests, connection checks                  |
| History              | [recovery.mjs](beacon/recovery.mjs), [import-history.mjs](beacon/import-history.mjs)                               | Checkpoints and previous-history import                                      |

## Accounts and connection

Beacon's local account uses the provider's stable subject; email and handles are
display fields. Its account-specific activity database is SQLite with WAL and
full synchronous writes. Credential and sign-in persistence use Electron
`safeStorage`; the desktop rejects unavailable encryption and Linux's
`basic_text` backend for protected credential storage.

The compiled Go helper talks to Beacon over loopback. First MCP startup starts a
bounded background connection flow. Per-agent leases coordinate concurrent
discovery processes. An existing signed-in account requires approval in Beacon;
a pending request can also complete after sign-in. Disconnect revokes the
agent's connections and pending approval. A disconnected plugin reconnects through
its setup flow or `asip_connect`.

Beacon maintains stable managed plugin paths. Native plugin managers own their
installed copies and hook-review state. Antigravity also has native desktop
registration; Windows uses a real directory and refreshes owned files during
upgrades. Claude's ZIP has its manifest under `.claude-plugin/` and helper under
`libexec/`. See the setup guide for the corresponding user actions.

## Records and project identity

Records contain an immutable ID, native timestamp, agent, session, project,
kind, summary, and structured evidence. Trace processing bounds and redacts
captured input/output. Redaction is a best-effort filter; captured work can
still contain private information.

Hooks retain native call IDs, observed results, Git revision/worktree evidence,
and transcript references or source hashes where available. Antigravity's Stop
handling can capture a completed final reply from its supported native JSONL
transcript. Missing or unsupported transcripts retain available metadata.

Codex MCP metadata supplies the native session and calling thread. The calling
thread takes precedence; root-session details remain evidence. Other clients
receive native context through hooks. Requests use that context rather than
another conversation's most recent session.

Project association uses the working directory, Git root, and normalized origin
repository. SSH and HTTPS forms normalize to one identity. Other work retains
local path evidence; ambiguous observations remain available for later review.
Probabilistic project classification is outside the implemented association path.

## Native MCP tools

The schemas and dispatch live in [main.go](plugin-helper/main.go).

| Tool               | Behavior                                               |
| ------------------ | ------------------------------------------------------ |
| `asip_status`      | Inspect Beacon connection/account state                |
| `asip_connect`     | Open the account-connection flow                       |
| `asip_projects`    | List recorded projects                                 |
| `asip_recall`      | Search recorded project work                           |
| `asip_record`      | Append intent, result, evidence, or other work records |
| `asip_connections` | List available named API metadata                      |
| `asip_api_request` | Call a named provider connection through Beacon        |

Connection and native hook capture are independent checks. Qualification must
exercise actual agent turns on the relevant application surface.

## Named API requests

Connection names are account-local. Each entry specifies a provider origin,
authentication, credential, and optional project restrictions. The helper receives
metadata and request results; Beacon supplies the stored credential to the
provider. Import refuses duplicate names and verifies encrypted round trips.
Stored signing secrets are retained separately from usable HTTP connections.

`connections.mjs` accepts GET, HEAD, POST, PUT, PATCH, and DELETE. Paths stay on
the configured origin, redirects are rejected, and requests time out after
60 seconds. JSON request bodies and returned responses are each bounded to
64 KiB. An oversized response returns `truncated: true` with no body. Streaming
and file uploads are outside this request interface.

`runtime.mjs` records the request before dispatch and the result afterward,
including HTTP status, provider request ID, and response hash. API audit records
omit credential headers, query strings, and request/response bodies. Native tool
capture is a separate path and may contain redacted tool arguments or returned
content. An interrupted provider request remains unresolved: inspect the audit
and provider state before retrying a write.

## Recovery and previous history

Recovery saves an account's SQLite history with a SHA-256 manifest, retaining at
most ten checkpoints. Restore stages and verifies the selected checkpoint,
checks SQLite integrity, saves the current history, then replaces the database.
The desktop stops sync and waits for its current pass before restoring; the
recovery class also rejects an in-flight pass. Afterward sync rescans cloud history.
Cloud records are retained. These checkpoints cover ASIP history rather than
repository files, operating-system state, or provider credentials.

Previous-history import preserves the original database and saves current
history before importing projects, relationships, events, and session metadata.
Repeated imports deduplicate existing records. The UI owns file selection.

## Desktop and release

Linux opens a full desktop window. Windows and macOS use a tray/menu-bar panel
with a full-window option and a fallback when tray placement is unavailable.
**Open ASIP** opens the linked hosted workspace at `https://asip.ca/users/<handle>`.
Without a linked hosted identity it opens `https://asip.ca/app`, which resolves the
browser's signed-in account or offers sign-in. Project links retain their scope.
Local Google email addresses are never guessed as cloud workspace handles.
Beacon no longer registers the local browser workspace. Plugin communication
and temporary desktop OAuth/device callbacks still use loopback internally.
Google completion verifies the provider response before redirecting to the
branded hosted completion page. Cloud approval returns to `/app` rather than the
restricted preview fallback.

[updates.mjs](beacon/updates.mjs) checks public release metadata without sending
account information. It selects supported native assets, enforces a trusted HTTPS
download origin, verifies size/SHA-256, and rechecks before opening the installer.
The renderer has check/download/install actions, not arbitrary URL or file access.
Updates preserve the normal installer approval flow and OS signing constraints.

Startup is enabled by default with an explicit opt-out: native login-item APIs
on Windows/macOS, XDG autostart on Linux, and a per-user LaunchAgent fallback for
unsigned Mac builds. A login launch keeps Beacon in the background.

Builds include version, Git revision, source-tree hash, dirty state, platform,
and build time. [Native CI](.github/workflows/beacon.yml) builds on each target
OS, checks plugin managers, packages installers, and performs startup smoke tests.
[Qualification history](QUALIFICATION.md) records the separate interactive
observations, artifact receipts, signing limits, and remaining checks.

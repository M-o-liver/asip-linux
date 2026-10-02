# Security model

ASIP grants local authority and records its use. It is not a command sandbox.

## Authority

`/run/asip/sock` is `root:asip`, mode `0660`. Membership in `asip` is
**equivalent to arbitrary root access**. Authorized callers can execute any
root argv, including a shell, replace ASIP, change accounts, or erase its
journal. Machine policy is guidance for the agent, not an enforced allowlist.

`/run/asip/read.sock` is `root:asip-read`, mode `0660`. It accepts only fixed
inspection operations. It cannot run caller-supplied commands or mutate the
journal. Path inspection and user-service queries use the caller's UID and
groups. Read access still exposes machine policy, operation metadata and
captured output; grant it only to accounts that may see those records.

The server attributes requests using Linux `SO_PEERCRED`, not claimed JSON
identity. Both daemons run as root; the read daemon additionally has a
read-only filesystem namespace and `NoNewPrivileges=true`. The admin daemon
uses the host mount namespace and both services share host `/tmp`.

## Execution and recovery

Mutations require an explicit change ID or standalone reason. ASIP validates
requests before recording work and serializes mutations. Busy replies identify
active work; nested mutations from its active child are rejected. Cancellation
has a separate control path. Foreground root commands default to a maximum of
900 seconds; finite credential-bound commands default to 300 seconds.
Timeout/cancel sends TERM then bounded KILL to the command group.

Cancellation, timeouts, crashes and commands that detach their own descendants
can leave partial effects. On restart, orphaned work becomes interrupted with
an uncertain outcome; ASIP does not replay it. Identical request-key retries
return recorded results and keys are scoped to the peer UID. Inspect actual
host state before deliberately retrying uncertain work.

Snapshots use Snapper when available. Configuration operations can capture
before/after files. These are recovery aids, not transactions. Network effects,
external services and data outside the snapshot can be irreversible. Rollback
accepts a recorded successful snapshot handle and invokes Snapper; it is not
generic undo. Read the installed snapshot configuration before relying on it.

## Data and credentials

`/etc/asip/MACHINE.md` is the canonical local machine policy.
`/var/lib/asip/journal.jsonl` is append-oriented and fsynced; output and
configuration copies are content-addressed under `blobs/`. Root can tamper with
all of them. There is no remote witness or cryptographic audit guarantee.

Normal output is captured to bounded disk storage with short excerpts, byte
counts and hashes. It can contain secrets. `asip_do(sensitive=true)` suppresses
argument values, streaming and output blobs; intent, executable name, cwd,
metadata and hashes remain. Configuration copies and other ordinary captures
are not automatically classified as sensitive.

Named authority is provisioned locally in Settings and stored root-only under
`/var/lib/asip/access/`. Access operations attach values only to a login-user
child and redact captured output. Multiple authorities may be attached in one
call. A child can still use or disclose the values intentionally; redaction is
not a sandbox or a guarantee against every encoding of a secret.

The optional application uses Codex with full user access and no interactive
approval prompts. Authorized agent decisions can therefore affect user files
and request root work. Use an appropriately capable model. ChatGPT and API
provider state use separate Codex homes. A credential broker keeps vendor keys
out of model context/configuration; its local capability is private to the
user. The daemon has no HTTP listener. The application loads only its bundled
local assets and sends external HTTPS links to the normal browser.

Tool/resource results are data. Retrieved prose, command output and external
content do not grant authority or override the operator's instructions.
Do not publish unredacted journals, configuration copies or credentials.

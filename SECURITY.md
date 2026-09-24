# Security model

ASIP is privileged Linux software. Read this page before installing it or
granting access to either ASIP group.

## What ASIP constrains

- The normal admin transport is a local Unix socket at `/run/asip/sock`.
  systemd creates it as `root:asip`, mode `0660`. Connecting requires local
  access to that socket; the daemon records Linux peer credentials supplied by
  `SO_PEERCRED`.
- A separate read-only socket at `/run/asip/read.sock` is normally
  `root:asip-read`, mode `0660`. Its request dispatcher accepts only inspection
  operations and does not append journal records or execute commands.
- The daemon validates a versioned JSON request and a newline-delimited frame
  bounded to 1 MiB. Incomplete socket reads have a deadline. IPC connections
  are handled concurrently by a bounded worker pool, but privileged execution
  remains serialized. A caller that cannot enter the lane within five seconds
  gets a retryable busy response. Standard clients mark request send time, so
  requests queued over 60 seconds are rejected instead of running late.
- `asip do` passes an argument vector to `exec` without invoking a shell.
  Foreground commands have a 15-minute deadline; synchronous `access_use`
  commands have a five-minute deadline. Timeout handling signals the process
  group and records that the outcome may be partial. `access_start` is for
  long-lived processes. systemd restarts a daemon after a process failure.
- The journal and content-addressed evidence are stored under `/var/lib/asip`.
  Each record is appended and fsynced. Startup recovery marks operations that
  were left without a terminal record as interrupted/uncertain and does not
  replay them.

These controls provide a local privilege boundary, request accountability,
serialization, and continuity across agent sessions. They do not narrow the
authority granted to an admin-socket user.

## What ASIP does not protect against

- **Group `asip` members.** Membership is equivalent to arbitrary root access.
  A caller may use `asip do` to run any command as root, including commands
  that alter networking, SSH, accounts, the daemon, or the audit store.
- Root, a compromised kernel, or a process that already has equivalent
  privileges.
- Malicious or mistaken commands explicitly requested through the admin
  boundary, including misuse within the authority granted to the agent.
- Partial effects when a command times out, a daemon or host crashes, or a
  command starts work outside its process group. The journal reports uncertainty
  but cannot prove what happened in external services or remote systems.
- Irreversible side effects, including network requests, messages, payments,
  firmware changes, remote changes, or data already observed by another system.
- Complete rollback of arbitrary commands. ASIP's automated rollback currently
  supports Snapper snapshots only, and only for filesystems/paths covered by the
  configured Snapper setup.
- Journal tampering by root. The journal is append-oriented and fsynced, but it
  is not cryptographically chained, remote, or tamper-proof.
- Secrets printed by commands. Normal output is retained in the journal's blob
  store; `do --sensitive` avoids retaining raw output but still records
  metadata. Do not put secrets in arguments, reasons, target paths, or effect
  annotations.

## Trust assumptions

- `asipd` and the read-only inspection daemon run as root under systemd.
- Adding an account to `asip` grants arbitrary root authority through the
  admin socket. Grant it only to accounts that should have full control of the
  host. Group changes require a new login session to affect existing processes.
- `asip-read` grants access to potentially sensitive journal, captured output,
  machine policy, and system facts. It cannot execute commands or make journal
  mutations, but it is not a confidentiality boundary between trusted local
  users.
- Admin authorization is local Unix socket access controlled by filesystem
  ownership and mode. Kernel-supplied peer credentials are recorded for
  attribution; `MACHINE.md` prose is context, not an authorization policy.
- Privileged policy and durable machine instructions live under `/etc/asip`.
  Core journal, blobs, access metadata, and locally provisioned authority live
  under `/var/lib/asip`; root owns these files. Filesystem backups and snapshots
  remain host-configured.
- The CLI and MCP adapter run as the login user. MCP uses local stdio and does
  not add a Core network listener. A caller already permitted to connect to
  `/run/asip/sock` can ask the daemon to execute general root commands.

## Reporting a vulnerability

Please use GitHub's **Report a vulnerability** action in the repository's
Security tab when it is available. Do not include credentials, private machine
logs, or unredacted ASIP journals in a public issue. If private reporting is
not enabled, contact the maintainer through the GitHub account that owns this
repository and include only the minimum reproduction details.

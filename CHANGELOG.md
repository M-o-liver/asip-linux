# Changelog

## 0.1.0 — initial public release

- Local root-owned Core daemon with separate admin and read-only Unix sockets.
- Explicit changes, serialized privileged operations, journaled output and
  configuration evidence, request retry keys, and bounded command execution.
- Bounded concurrent IPC handling, retryable mutation-lane contention, stale
  queued-request rejection, and a shorter deadline for synchronous credential
  use.
- Startup reconciliation for interrupted operations; uncertain mutations are
  recorded and are not replayed automatically.
- Package, service, configuration, snapshot, and Snapper rollback operations.
- Stdio MCP adapter, Linux Audit integration where supported, and a verified
  Linux installer.
- Fleet and the native Desktop application are outside the scope of this
  single-host release.

# ASIP

**Privileged operations for AI agents, with an audit trail.**

ASIP gives an agent a local interface for Linux system changes through a
root-owned daemon. It associates work with explicit intent and keeps a durable
record of the caller, requested action, result, captured evidence, and recovery
information. It is sometimes described as “sudo for agents,” but the trust
boundary is different from a sandbox: anyone allowed to use ASIP's admin
socket can run arbitrary commands as root.

## A first operation

With ASIP installed, a package change can be recorded as one coherent change:

```sh
change_id="$(asip change start 'Install ripgrep')"
asip --change "$change_id" pkg install ripgrep
asip --change "$change_id" verify pass rpm 'ripgrep is installed'
asip change finish "$change_id" 'Installed ripgrep and verified the package'
```

The same interface is available to agents through ASIP's local MCP adapter.
Agents start a change, use typed tools for package, service, configuration,
snapshot, journal, and recovery work, and use `asip_do` when no typed operation
fits.

## Why ASIP exists

An interactive root shell gives an agent broad authority with little durable
context. ASIP makes the local privileged path explicit and leaves a record that
the next session can inspect. It works with the host's package manager,
systemd, Linux Audit, and configured snapshot tool rather than replacing them.

## Trust model

ASIP is a local administration boundary, **not a sandbox or command allowlist**.
Membership in group `asip` is equivalent to arbitrary root access. The root
daemon accepts requests on `/run/asip/sock`, whose normal owner/group/mode is
`root:asip` and `0660`. The kernel supplies Unix peer credentials; socket
permissions are the authorization boundary. The separate
`/run/asip/read.sock` and `asip-read` group permit inspection without command
execution or journal mutation.

`asip do` runs an argument vector directly, without a shell. It is deliberately
general and can still do anything root can do. `/etc/asip/MACHINE.md` provides
context for agents; it is not an enforced policy language. Read the full
[security model](SECURITY.md) before granting either group.

## Install

ASIP targets Linux systems with systemd. The first public release is tested
through CI on Fedora 44 x86-64; package detection contracts also run in Ubuntu,
Debian, and Arch containers. Container checks are not clean graphical VM
qualification. See [platform status](SUPPORT.md) for the exact evidence and
limits.

For the graphical installer, download the versioned AppImage and its checksum
from [GitHub Releases](https://github.com/M-o-liver/asip-linux/releases/latest),
verify the checksum, make it executable, and run it:

```sh
sha256sum -c ASIP-Installer-0.1.0-x86_64.AppImage.sha256
chmod +x ASIP-Installer-0.1.0-x86_64.AppImage
./ASIP-Installer-0.1.0-x86_64.AppImage
```

The graphical installer verifies and stages its release payload before one
explicit system-authentication prompt. It installs the Core services, audit
integration, groups, and selected MCP adapter. Start a fresh login session
afterward so your agent receives the new group membership. The prompt grants
`asip` access, which is root-equivalent.

For a headless install, download and verify the source release, then install
the user-level client:

```sh
release=https://github.com/M-o-liver/asip-linux/releases/download/v0.1.0
curl -fsSLO "$release/asip-0.1.0.tar.gz"
curl -fsSLO "$release/release.json"
curl -fsSLO "$release/SHA256SUMS"
sha256sum --ignore-missing -c SHA256SUMS
tar -xzf asip-0.1.0.tar.gz
cd asip-0.1.0
./install.sh
```

Then use the explicit local system-authentication prompt to install the
services. On a headless host without polkit, use the system's documented root
path for the same `asip install --privileged` command:

```sh
pkexec /usr/bin/env \
  ASIP_OPERATOR="$(id -un)" \
  ASIP_SOURCE_ROOT="$HOME/.local/bin" \
  "$HOME/.local/bin/asip" install --privileged
```

Start a new login session, then run `asip doctor`. The first login must belong
to the `asip` group only if it should have root-equivalent authority.

For a headless or source install, see [INSTALL.md](INSTALL.md). Upgrades and
removal are documented in [UPGRADE.md](UPGRADE.md) and
[UNINSTALL.md](UNINSTALL.md).

## What it does and what it does not do

ASIP records explicit changes and privileged operations, streams and stores
captured command output by content hash, can capture configuration files before
and after a command, and records verification and recovery handles. Package
operations create a pre-change Snapper snapshot when Snapper is available.
Foreground commands have a 15-minute limit; timed-out work is terminated where
the operating system permits and marked as potentially partial. On daemon
restart, incomplete operations are recorded as uncertain and are never
automatically replayed.

The daemon accepts IPC connections concurrently but keeps privileged execution
serialized. A request that cannot enter the execution lane within five seconds
gets a retryable busy response. Standard clients' requests older than 60
seconds are rejected rather than executed late after a restart. Synchronous
`access_use` commands have a five-minute limit; `access_start` is for
long-running processes.

ASIP does not make arbitrary root commands safe, prevent an authorized user
from changing networking or SSH, protect against malicious root or a
compromised kernel, or reverse every side effect. Automated rollback currently
uses Snapper snapshots only. A journal entry is durable evidence, not proof that
an external effect can be undone.

## Audit and recovery

The root-owned journal is `/var/lib/asip/journal.jsonl`; captured output and
configuration copies are in `/var/lib/asip/blobs/`. Records are appended and
fsynced, but they are not cryptographically chained or tamper-proof against
root. Use `asip change list`, `asip log`, and `asip recovery` to inspect work.
`asip rollback HANDLE` accepts an ASIP recovery handle for a successful
Snapper snapshot; it does not roll back ordinary commands or external effects.

## Examples

```sh
# Restart a service and retain the operation record.
change_id="$(asip change start 'Restart the example service')"
asip --change "$change_id" svc restart example.service
asip change finish "$change_id" 'Service restart completed'

# Inspect the journal and available snapshots.
asip change list
asip log
asip recovery

# Create a named snapshot, then use its returned recovery handle if needed.
asip --change "$change_id" snap 'Before editing the service configuration'
```

Check the output before finishing a change. ASIP does not infer a successful
verification from a zero exit code.

## Architecture

The core consists of a root-owned admin daemon and a separate read-only
inspection daemon, reached through local systemd socket activation. The human
CLI and the stdio MCP adapter are unprivileged clients. The full process, state,
mutation, and recovery map is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

This release contains the single-host Core. It does not ship Fleet or the
native Desktop application.

## Development

Python 3, a POSIX shell, and systemd-related test fixtures are used by the
project. Core runtime code uses the Python standard library; the optional MCP
adapter and other optional components have separate pinned dependencies.

```sh
python3 -m unittest discover -s tests -v
./scripts/release_gate.sh
```

The live systemd/socket tests require a disposable Linux VM and are not run by
pull-request CI. See [CONTRIBUTING.md](CONTRIBUTING.md) and the
[release gate](tests/live_systemd.sh).

## License

ASIP is licensed under [Apache-2.0](LICENSE).

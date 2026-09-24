# Platform status and limitations

ASIP 0.1.0 is an initial public release of the single-host Core. It requires a
Linux system with systemd, Python 3, and a supported local package manager for
package operations. The release archive and graphical installer target
x86-64.

## Evidence available for this release

| Platform | Evidence | Claim |
|---|---|---|
| Fedora 44, x86-64 | Fedora CI plus a clean disposable VM: archive checksum, README bootstrap, privileged install, fresh-login group membership, package install/remove/already-satisfied/failure, service start/stop/restart/failure/missing unit, concurrent writer rejection, daemon crash/restart, and interrupted-operation recovery | Primary qualified target for this 0.1 release |
| Ubuntu 24.04, Debian 13, Arch | CI container tests for distro detection and package-name contracts | Packaging contract checks only; not systemd, GUI, privilege prompt, upgrade, or uninstall qualification |
| Other Linux distributions | No release qualification | Best effort only; not claimed as supported |
| Non-Linux systems | Not supported | ASIP uses Linux Unix sockets, systemd activation, Linux credentials, and Linux host tools |

The release workflow builds the source archive and x86-64 AppImage on Ubuntu
22.04 CI. That is an artifact build environment, not a supported host claim.
Privileged/live tests are separate from ordinary pull-request CI and must run
on a disposable Linux VM or a machine with an explicit recovery plan.

## Requirements and optional integrations

- Linux with systemd socket activation, Python 3.12–3.14 x86-64 for the
  installer-provisioned MCP wheelhouse, and ordinary POSIX tools.
- A local account whose membership in `asip` you deliberately trust with
  arbitrary root access. `asip-read` is a separate inspection permission.
- `pkexec` and a graphical polkit agent for the AppImage installer. The
  headless path uses an explicit system-authentication tool such as `pkexec`.
- Network/repository access during initial install only if required host
  packages are missing. Core operation does not require an ASIP-hosted service.
- Snapper for automatic filesystem snapshots and the `rollback` operation.
  Without it, ASIP remains usable but does not provide automated filesystem
  rollback.
- Linux Audit integration is installed where the distro provides the expected
  audit tools; it supplements the ASIP journal and is not a tamper-proof log.

## Current limitations

- ASIP is not a sandbox. `asip` group membership authorizes arbitrary root
  execution, and neither `MACHINE.md` nor the service API is a policy firewall.
- Foreground commands time out after 15 minutes; synchronous `access_use`
  commands time out after five minutes. A timed-out command may have made
  partial changes; inspect the host before retrying. Long-running credential
  processes should use `access_start`.
- Execution remains serialized, but waiting requests receive a retryable busy
  response after five seconds. Standard client requests left queued for over
  60 seconds are rejected as stale rather than executed later.
- The journal is root-owned, append-oriented, and fsynced, but root can alter
  it and the records are not cryptographically chained.
- Snapper is the only automated rollback backend. Other effects may be logged
  or captured without being reversible.
- Fleet and a native Desktop application are outside this release. The shipped
  source and default installer contain only the single-host Core and its
  graphical installer.
- No signed artifact workflow is configured yet. Release checksums detect
  accidental corruption but do not authenticate the publisher independently
  of GitHub.

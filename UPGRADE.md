# Upgrade ASIP

ASIP does not update itself in the background. Each upgrade uses a versioned
release manifest and SHA-256 check before the privileged installer replaces
system files.

Download the new release archive and metadata from
[GitHub Releases](https://github.com/M-o-liver/asip-linux/releases), then check the
candidate before applying it:

```sh
ASIP_RELEASE_METADATA=/path/to/release.json asip upgrade --check
ASIP_RELEASE_METADATA=/path/to/release.json asip upgrade
```

The upgrade creates a pre-change Snapper snapshot when available, stages and
validates the release payload, preserves `/etc/asip/MACHINE.md` and
`/var/lib/asip`, and checks that the new Core sockets reconnect. The local
installer keeps a recovery copy of replaced system files. This does not make an
upgrade transactional if the host loses power or the filesystem fails.

If an upgrade fails before service replacement, inspect the installer output
and keep the previous release archive. If the daemon does not return, use the
host's trusted administrator recovery path to restore the retained installer
backup or a verified previous release. Do not erase `/etc/asip` or
`/var/lib/asip` while troubleshooting.

Downgrades are not supported. Check state/schema compatibility before restoring
an older program version.

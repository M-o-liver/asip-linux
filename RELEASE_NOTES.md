# ASIP 0.1.0

ASIP is a local privileged execution layer for AI agents with explicit changes,
serialized mutations, an audit trail, and recovery handles.

This is the first public source release. The project targets single-host Linux
with systemd. Fedora 44 x86-64 is the primary CI/development target and was
qualified in a clean disposable VM for archive verification, README-guided
installation, fresh-login group access, package operations, systemd service
operations, concurrent-writer rejection, daemon crash/restart, and interrupted
operation recovery. Ubuntu, Debian, and Arch CI jobs check package contracts
in containers only.

The admin socket grants arbitrary root access. ASIP is not a sandbox, its
journal is not tamper-proof against root, and automated rollback supports
Snapper snapshots only. Timed-out or interrupted commands may have partial
effects. Fleet and a native Desktop application are outside this release.

The release archive contains the single-host Core, graphical bootstrap
installer, and pinned MCP wheelhouse. It does not install an agent desktop
application or fleet services.

Release assets include the Core source/install archive, x86-64 AppImage
bootstrap, release metadata, and SHA-256 checksums.

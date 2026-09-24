# Install ASIP

The current release is the Linux x86-64 systemd Core. It installs the daemon,
local admin and read-only sockets, command-line tools, audit integration where
available, and the MCP adapter for the selected local agent harness.

## Graphical installer

1. Open [GitHub Releases](https://github.com/M-o-liver/asip-linux/releases/latest)
   and download `ASIP-Installer-0.1.0-x86_64.AppImage` and its `.sha256` file.
2. Verify the file using the provided sidecar:

   ```sh
   sha256sum -c ASIP-Installer-0.1.0-x86_64.AppImage.sha256
   ```

3. Mark it executable and run it:

   ```sh
   chmod +x ASIP-Installer-0.1.0-x86_64.AppImage
   ./ASIP-Installer-0.1.0-x86_64.AppImage
   ```

4. Review the system check and confirm the one explicit polkit authentication
   prompt. The helper verifies the staged payload again before installing the
   Core services and selected agent adapter.
5. Start a new login session after installation so your processes receive the
   `asip` and `asip-read` group memberships.
6. Check the installation with `asip doctor` and inspect current work with
   `asip brief`.

ASIP membership is equivalent to arbitrary root access. Do not accept the
group change for an account that should not have full host authority.

## Headless install from the source release

Install the basic tools `curl` (or `wget`), Python 3, `tar`, `gzip`, and
`sha256sum`. Download `asip-0.1.0.tar.gz`, `release.json`, and `SHA256SUMS`
from the same GitHub release. Verify the archive before extracting it:

```sh
sha256sum --ignore-missing -c SHA256SUMS
tar -xzf asip-0.1.0.tar.gz
cd asip-0.1.0
./install.sh
```

The bootstrap installs a user-level CLI and verified release payload under
`~/.local/bin`. The privileged system installation is a separate explicit
step. With `pkexec` installed, run this from the same login account:

```sh
pkexec /usr/bin/env \
  ASIP_OPERATOR="$(id -un)" \
  ASIP_SOURCE_ROOT="$HOME/.local/bin" \
  "$HOME/.local/bin/asip" install --privileged
```

This command invokes the graphical/local polkit authorization path. On a
headless host without polkit, use the system's normal administrative path to
run the same `asip install --privileged` command as root, and set
`ASIP_OPERATOR` to the intended local account. The installer does not add a
remote listener or install Fleet or a native Desktop application.

## First operation

Start a fresh session, then:

```sh
asip doctor
change_id="$(asip change start 'Install ripgrep')"
asip --change "$change_id" pkg install ripgrep
asip --change "$change_id" verify pass rpm 'ripgrep is installed'
asip change finish "$change_id" 'Installed and verified ripgrep'
```

If no snapshot backend is configured, package operations continue but cannot
create an automatic pre-change filesystem snapshot. See
[SECURITY.md](SECURITY.md) and [SUPPORT.md](SUPPORT.md) before granting agent
access.

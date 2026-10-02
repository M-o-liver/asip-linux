#!/bin/sh
# Source installation; never fetches dependencies or schedules a delayed restart.
set -eu
[ "$(id -u)" -eq 0 ] || { printf 'System installation requires root.\n' >&2; exit 77; }
source_root="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
operator=''
if [ "${1:-}" = --operator ] && [ "$#" -eq 2 ]; then operator="$2"
elif [ "$#" -ne 0 ]; then printf 'Usage: %s [--operator USER]\n' "$0" >&2; exit 64; fi
python3 -c 'import sys; assert sys.version_info >= (3,11), "Python 3.11+ required"'
command -v systemctl >/dev/null
if [ -n "$operator" ]; then [ "$operator" != root ] && getent passwd "$operator" >/dev/null; fi
getent group asip >/dev/null || groupadd --system asip
getent group asip-read >/dev/null || groupadd --system asip-read
install -d -m 0755 /usr/lib /usr/share/asip /usr/local/bin /usr/local/sbin /etc/asip
install -d -o root -g asip -m 0750 /var/lib/asip /var/lib/asip/blobs
install -d -o root -g root -m 0700 /var/lib/asip/install-backups
backup="/var/lib/asip/install-backups/$(date -u +%Y%m%dT%H%M%S)-$$.tar"
backup_list="$(mktemp)"
stage="$(mktemp -d /usr/lib/.asip-install.XXXXXX)"
trap 'rm -rf -- "$stage"; rm -f -- "$backup_list"' 0 1 2 3 15
for path in usr/lib/asip usr/share/asip usr/local/bin/asip usr/local/bin/a \
    usr/local/bin/asip-inspect usr/local/sbin/asip-restore usr/local/sbin/asip-uninstall \
    etc/systemd/system/asip.service etc/systemd/system/asip.socket \
    etc/systemd/system/asip-read.service etc/systemd/system/asip-read.socket; do
    [ ! -e "/$path" ] || printf '%s\n' "$path" >>"$backup_list"
done
tar -C / -cpf "$backup" -T "$backup_list"
chmod 0600 "$backup"
for directory in core cli desktop scripts systemd; do cp -R "$source_root/$directory" "$stage/"; done
for file in asip asip-inspect a asip_mcp.py pyproject.toml VERSION install.sh; do cp "$source_root/$file" "$stage/"; done
find "$stage" -type d -name __pycache__ -prune -exec rm -rf {} +
find "$stage" -type d -exec chmod 0755 {} +
find "$stage" -type f -exec chmod 0644 {} +
chmod 0755 "$stage/asip" "$stage/asip-inspect" "$stage/a" "$stage/cli/asip.sh" \
    "$stage/desktop/asip-desktop" "$stage/install.sh" "$stage/scripts/"*.sh
python3 -m compileall -q "$stage/core" "$stage/desktop" "$stage/asip_mcp.py"
running=false
if systemctl is-active --quiet asip.service || systemctl is-active --quiet asip-read.service; then running=true; fi
if [ -e /usr/lib/asip ]; then mv /usr/lib/asip "$stage.previous"; fi
if ! mv "$stage" /usr/lib/asip; then
    [ ! -e "$stage.previous" ] || mv "$stage.previous" /usr/lib/asip
    exit 1
fi
rm -rf -- "$stage.previous"
install -m 0644 "$source_root/VERSION" /usr/share/asip/VERSION
install -m 0755 "$source_root/asip" /usr/local/bin/asip
install -m 0755 "$source_root/a" /usr/local/bin/a
install -m 0755 "$source_root/asip-inspect" /usr/local/bin/asip-inspect
install -m 0755 "$source_root/scripts/restore_install_backup.sh" /usr/local/sbin/asip-restore
install -m 0755 "$source_root/scripts/uninstall_software.sh" /usr/local/sbin/asip-uninstall
for unit in asip.service asip.socket asip-read.service asip-read.socket; do
    install -m 0644 "$source_root/systemd/$unit" "/etc/systemd/system/$unit"
done
if [ ! -e /etc/asip/MACHINE.md ]; then "$source_root/asip" skeleton >/etc/asip/MACHINE.md; fi
chmod 0644 /etc/asip/MACHINE.md
chown -R root:root /usr/lib/asip /usr/share/asip
if [ -n "$operator" ]; then usermod -aG asip,asip-read "$operator"; fi
systemctl daemon-reload
systemctl reset-failed asip.service asip-read.service asip.socket asip-read.socket
for role in asip asip-read; do
    if systemctl is-active --quiet "$role.service" && ! systemctl is-active --quiet "$role.socket"; then
        systemctl stop "$role.service"
    fi
done
systemctl enable --now asip.socket asip-read.socket
printf 'Installed source. Backup: %s\n' "$backup"
if [ "$running" = true ]; then
    printf 'RESTART REQUIRED: installed files changed; running services still use their previous code.\n'
    printf 'After callers are idle, restart asip.service and asip-read.service through ASIP. Verify health after reconnecting.\n'
else printf 'The socket units will start the services on first use.\n'; fi
if [ -n "$operator" ]; then printf 'Account %s has root-equivalent ASIP access. A new login may be required.\n' "$operator"; fi

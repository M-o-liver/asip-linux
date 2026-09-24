#!/bin/sh
# Restore the installer-level backup made before an ASIP self-upgrade.
# This intentionally does not depend on the installed ASIP Python runtime.
set -eu

backup=${1:-}
[ -n "$backup" ] || {
	printf 'Usage: %s /var/lib/asip/install-backups/<release>.tar\n' "${0##*/}" >&2
	exit 64
}
[ "$(id -u)" -eq 0 ] || {
	printf '%s: restore must run as root through the existing trusted root path\n' "${0##*/}" >&2
	exit 1
}
[ -f "$backup" ] || {
	printf '%s: backup archive not found: %s\n' "${0##*/}" "$backup" >&2
	exit 1
}
if ! tar -tf "$backup" | awk '
	{ if ($0 ~ /^\// || $0 ~ /(^|\/)\.\.(\/|$)/) bad=1 }
	END { exit bad }
'; then
	printf '%s: refusing an unsafe backup archive\n' "${0##*/}" >&2
	exit 1
fi
tar -xpf "$backup" -C / --no-same-owner
systemctl daemon-reload >/dev/null 2>&1 || true
for unit in asip.socket asip-read.socket; do
		systemctl reset-failed "$unit" >/dev/null 2>&1 || true
done
systemctl restart asip.service asip-read.service >/dev/null 2>&1 || true
printf 'Restored ASIP installed files from %s. Run asip doctor before normal use.\n' "$backup"

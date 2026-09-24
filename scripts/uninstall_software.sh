#!/bin/sh
# Complete deferred ASIP removal outside the daemon's systemd service group.
set -eu

mode=${1:-}
case "$mode" in
	--software|--purge) ;;
	*)
		printf 'Usage: %s --software | --purge\n' "${0##*/}" >&2
		exit 64
		;;
esac
[ "$(id -u)" -eq 0 ] || {
	printf '%s: removal helper must run as root\n' "${0##*/}" >&2
	exit 1
}

for unit in asip-read.socket asip.socket asip.service asip-read.service; do
	systemctl disable --now "$unit" >/dev/null 2>&1 || true
done
rm -f -- /etc/systemd/system/asip-read.socket /etc/systemd/system/asip-read.service \
	/etc/systemd/system/asip.socket /etc/systemd/system/asip.service
rm -f -- /usr/local/bin/asip /usr/local/bin/a /usr/local/bin/asip-inspect \
	/usr/local/sbin/asip-restore /usr/local/sbin/asip-uninstall \
	/etc/audit/rules.d/asip.rules
rm -rf -- /usr/lib/asip /usr/share/asip/eval /usr/share/asip/docs \
	/usr/share/asip/mcp-source
systemctl daemon-reload >/dev/null 2>&1 || true
if [ "$mode" = --purge ]; then
	rm -rf -- /etc/asip /var/lib/asip
	printf 'ASIP software and durable state removed.\n'
else
	printf 'ASIP Core software removed. Retained: /etc/asip, /var/lib/asip, and user state.\n'
fi

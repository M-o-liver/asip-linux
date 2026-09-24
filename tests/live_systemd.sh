#!/bin/sh
# Opt-in smoke test for a real ASIP installation. This appends harmless
# operations to the explicitly supplied change; it never edits machine policy.
set -eu

[ "${ASIP_LIVE_TEST:-}" = 1 ] || {
	printf 'Set ASIP_LIVE_TEST=1 to test the installed systemd/socket boundary.\n' >&2
	exit 77
}
[ -n "${ASIP_CHANGE_ID:-}" ] || {
	printf 'Set ASIP_CHANGE_ID to the active qualification change.\n' >&2
	exit 64
}

systemctl is-active --quiet asip.service asip-read.service
[ "$(stat -c '%U:%G:%a' /run/asip/sock)" = root:asip:660 ]
[ "$(stat -c '%U:%G:%a' /run/asip/read.sock)" = root:asip-read:660 ]

ASIP_BIN=${ASIP_BIN:-$(command -v asip || printf '%s/.local/bin/asip' "$HOME")}
ASIP_INSPECT_BIN=${ASIP_INSPECT_BIN:-$(command -v asip-inspect || printf '%s/.local/bin/asip-inspect' "$HOME")}
[ -x "$ASIP_BIN" ] || { printf 'ASIP CLI not found: %s\n' "$ASIP_BIN" >&2; exit 1; }
[ -x "$ASIP_INSPECT_BIN" ] || {
	printf 'ASIP inspection CLI not found: %s\n' "$ASIP_INSPECT_BIN" >&2
	exit 1
}

asip_cli() {
	"$ASIP_BIN" --change "$ASIP_CHANGE_ID" "$@"
}

# Keep the accept loop responsive while a foreground command owns the
# serialized mutation lane. A competing caller must receive a retryable error
# instead of waiting to execute after the original operation.
lane_log=$(mktemp)
trap 'rm -f -- "$lane_log"' 0 1 2 3 15
asip_cli 'do' -- sleep 8 \
	>"$lane_log" 2>&1 &
lane_pid=$!
sleep 1
set +e
busy_output=$(asip_cli 'do' -- true 2>&1)
busy_status=$?
set -e
wait "$lane_pid"
[ "$busy_status" -eq 75 ] || {
	printf 'busy mutation request returned %s, expected retryable exit 75\n%s\n' \
		"$busy_status" "$busy_output" >&2
	exit 1
}
printf '%s\n' "$busy_output" | grep -q 'serialized administration lane'

# Exercise systemd crash recovery in a disposable machine. Socket activation
# leaves the listener available while Restart=on-failure reconstructs daemon
# state; request daemon termination through ASIP itself. The interrupted
# request must not be replayed, and a harmless follow-up request must succeed.
set +e
asip_cli 'do' -- \
	systemctl kill --signal=KILL asip.service >/dev/null 2>&1
kill_status=$?
set -e
[ "$kill_status" -eq 0 ] || [ "$kill_status" -eq 75 ] || {
	printf 'ASIP daemon termination request returned unexpected status %s\n' \
		"$kill_status" >&2
	exit 1
}
attempt=0
until systemctl is-active --quiet asip.service; do
	attempt=$((attempt + 1))
	[ "$attempt" -lt 30 ] || {
		printf 'asip.service did not recover after daemon termination\n' >&2
		exit 1
	}
	sleep 1
done
systemctl is-active --quiet asip.socket
asip_cli 'do' -- true >/dev/null

doctor_output=$("$ASIP_INSPECT_BIN" --json doctor)
printf '%s\n' "$doctor_output" | python3 -c '
import json, sys
doctor = json.load(sys.stdin)
assert doctor["status"] == "ok", doctor
assert doctor["journal"]["incomplete_operations"] == [], doctor
'
"$ASIP_INSPECT_BIN" context / >/dev/null

if python3 /usr/lib/asip/core/client.py --socket /run/asip/read.sock --op 'do' \
	--standalone-reason rejected -- true >/dev/null 2>&1; then
	printf 'read-only socket accepted mutation\n' >&2
	exit 1
fi

key="live-smoke-$(date -u +%Y%m%dT%H%M%SZ)-$$"
asip_cli --request-key "$key" 'do' -- true
asip_cli --request-key "$key" 'do' -- true 2>&1 |
	grep -q 'idempotent replay'

printf 'ASIP live systemd smoke test passed.\n'

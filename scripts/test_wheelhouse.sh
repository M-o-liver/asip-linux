#!/bin/sh
# Prove the current interpreter can install the adapter with networking disabled.
set -eu

repo=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
wheelhouse=${1:-"$repo/wheelhouse"}
python=${PYTHON:-python3}
tag=$($python -c 'import sys; print("%d%d" % sys.version_info[:2])')
case "$tag" in
312|313|314) ;;
*)
	printf 'test_wheelhouse.sh: Python %s is outside the engineering matrix\n' "$tag" >&2
	exit 77
	;;
esac
target="$wheelhouse/py${tag}-linux-x86_64"
lock="$repo/requirements/mcp-py${tag}-linux-x86_64.lock"
common="$wheelhouse/common"
if [ ! -d "$target" ] || [ ! -d "$common" ]; then
	printf 'test_wheelhouse.sh: incomplete wheelhouse: %s\n' "$wheelhouse" >&2
	exit 69
fi

python3 "$repo/scripts/wheelhouse_lock.py" verify "$target" "$lock" >/dev/null
(
	cd "$wheelhouse"
	sha256sum -c SHA256SUMS >/dev/null
)

environment=$(mktemp -d "${TMPDIR:-/tmp}/asip-wheelhouse-test.XXXXXX") || exit 1
cleanup() { rm -rf -- "$environment"; }
trap cleanup 0 1 2 3 15
$python -m venv "$environment/venv"
"$environment/venv/bin/python" -m pip install --disable-pip-version-check \
	--no-index --find-links "$target" --require-hashes --requirement "$lock" >/dev/null
set -- "$common"/asip_mcp-*.whl
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
	printf 'test_wheelhouse.sh: expected exactly one ASIP adapter wheel\n' >&2
	exit 69
fi
"$environment/venv/bin/python" -m pip install --disable-pip-version-check \
	--no-index --no-deps "$1" >/dev/null
"$environment/venv/bin/python" -c \
	'import asip_mcp, mcp; from importlib.metadata import version; assert version("mcp") == "2.0.0"'
"$environment/venv/bin/asip-mcp-inspect" </dev/null >/dev/null 2>&1 &
adapter_pid=$!
kill "$adapter_pid" 2>/dev/null || true
wait "$adapter_pid" 2>/dev/null || true
printf 'Offline MCP wheelhouse test passed for Python %s.\n' "$tag"

#!/bin/sh
# Build target-specific, binary-only MCP wheelhouses from committed hash locks.
set -eu

repo=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
refresh=0
if [ "${1:-}" = "--refresh" ]; then
	refresh=1
	shift
fi
output=${1:-"$repo/wheelhouse"}
[ "$#" -le 1 ] || {
	printf 'Usage: %s [--refresh] [OUTPUT-DIRECTORY]\n' "${0##*/}" >&2
	exit 64
}

case "$output" in
''|/|.)
	printf 'build_wheelhouse.sh: refusing unsafe output directory: %s\n' "$output" >&2
	exit 64
	;;
esac
mkdir -p "$(dirname -- "$output")"

stage=$(mktemp -d "${TMPDIR:-/tmp}/asip-wheelhouse.XXXXXX") || exit 1
cleanup() { rm -rf -- "$stage"; }
trap cleanup 0 1 2 3 15

build_target() {
	tag=$1
	python_version=$2
	target="cp${tag}-manylinux2014-x86_64"
	destination="$stage/py${tag}-linux-x86_64"
	lock="$repo/requirements/mcp-py${tag}-linux-x86_64.lock"
	mkdir -p "$destination"
	if [ "$refresh" -eq 1 ]; then
		# Resolve only from binary distributions that pip can actually install for
		# the target. The resulting exact versions and wheel bytes become the
		# committed hash lock; ordinary product builds never resolve again.
		python3 -m pip download --disable-pip-version-check --quiet \
			--dest "$destination" --only-binary=:all: \
			--platform manylinux2014_x86_64 --implementation cp \
			--python-version "$python_version" \
			--requirement "$repo/requirements/mcp.in"
		python3 "$repo/scripts/wheelhouse_lock.py" create \
			"$destination" "$stage/mcp-py${tag}.lock" --target "$target" >/dev/null
	else
		[ -r "$lock" ] || {
			printf 'build_wheelhouse.sh: missing committed lock: %s\n' "$lock" >&2
			exit 69
		}
		python3 -m pip download --disable-pip-version-check --quiet \
			--dest "$destination" --only-binary=:all: --no-deps \
			--platform manylinux2014_x86_64 --implementation cp \
			--python-version "$python_version" --require-hashes \
			--requirement "$lock"
	fi
}

build_target 312 3.12
build_target 313 3.13
build_target 314 3.14

mkdir -p "$stage/common"
python3 -m pip wheel --disable-pip-version-check --quiet --no-deps \
	--wheel-dir "$stage/common" "$repo"

python3 - "$stage/common" "$repo/VERSION" <<'PY'
import email.parser
import pathlib
import re
import sys
import zipfile

directory = pathlib.Path(sys.argv[1])
version = pathlib.Path(sys.argv[2]).read_text(encoding="utf-8").strip()
wheels = sorted(directory.glob("*.whl"))
if len(wheels) != 1 or not re.fullmatch(
    rf"asip_mcp-{re.escape(version)}-py3-none-any\.whl", wheels[0].name
):
    raise SystemExit("build_wheelhouse.sh: expected one versioned, pure-Python ASIP adapter wheel")

with zipfile.ZipFile(wheels[0]) as wheel:
    metadata_names = [name for name in wheel.namelist() if name.endswith(".dist-info/METADATA")]
    if len(metadata_names) != 1:
        raise SystemExit("build_wheelhouse.sh: adapter wheel must contain one dist-info/METADATA")
    metadata = email.parser.BytesParser().parsebytes(wheel.read(metadata_names[0]))
    normalize = lambda name: re.sub(r"[-_.]+", "-", name or "").lower()
    if normalize(metadata.get("Name")) != "asip-mcp" or metadata.get("Version") != version:
        raise SystemExit("build_wheelhouse.sh: adapter wheel metadata name or version is incorrect")
    files = set(wheel.namelist())
    required = {"asip_mcp.py", "core/__init__.py", "core/protocol.py"}
    if not required.issubset(files):
        raise SystemExit("build_wheelhouse.sh: adapter wheel is missing ASIP Python modules")
PY

if [ "$refresh" -eq 1 ]; then
	install -m 0644 "$stage/mcp-py312.lock" \
		"$repo/requirements/mcp-py312-linux-x86_64.lock"
	install -m 0644 "$stage/mcp-py313.lock" \
		"$repo/requirements/mcp-py313-linux-x86_64.lock"
	install -m 0644 "$stage/mcp-py314.lock" \
		"$repo/requirements/mcp-py314-linux-x86_64.lock"
fi
rm -f -- "$stage/mcp-py312.lock" "$stage/mcp-py313.lock" "$stage/mcp-py314.lock"

python3 "$repo/scripts/wheelhouse_lock.py" verify \
	"$stage/py312-linux-x86_64" "$repo/requirements/mcp-py312-linux-x86_64.lock" >/dev/null
python3 "$repo/scripts/wheelhouse_lock.py" verify \
	"$stage/py313-linux-x86_64" "$repo/requirements/mcp-py313-linux-x86_64.lock" >/dev/null
python3 "$repo/scripts/wheelhouse_lock.py" verify \
	"$stage/py314-linux-x86_64" "$repo/requirements/mcp-py314-linux-x86_64.lock" >/dev/null

(
	cd "$stage"
	find . -type f -name '*.whl' -print | LC_ALL=C sort |
		while IFS= read -r wheel; do sha256sum "$wheel"; done >SHA256SUMS
)

backup=''
if [ -e "$output" ]; then
	backup="${output}.previous.$$"
	mv -- "$output" "$backup"
fi
if ! mv -- "$stage" "$output"; then
	[ -n "$backup" ] && mv -- "$backup" "$output"
	exit 1
fi
trap - 0 1 2 3 15
[ -n "$backup" ] && rm -rf -- "$backup"
printf 'ASIP MCP wheelhouse built at %s (Python 3.12–3.14, x86_64).\n' "$output"

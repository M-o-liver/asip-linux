#!/bin/sh
# Build a version-distinct, locally signed-by-digest upgrade fixture without
# modifying the source checkout. This is test material, not a production signer.
set -eu

repo=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
version=${1:-}
output=${2:-}
case "$version" in
''|*[!0-9A-Za-z.+-]*|.*|*.)
	printf 'Usage: %s SEMANTIC-VERSION OUTPUT-DIRECTORY\n' "${0##*/}" >&2
	exit 64
	;;
esac
[ -n "$output" ] || {
	printf 'Usage: %s SEMANTIC-VERSION OUTPUT-DIRECTORY\n' "${0##*/}" >&2
	exit 64
}
[ -d "$repo/wheelhouse" ] || {
	printf 'build_upgrade_fixture.sh: build the release wheelhouse first\n' >&2
	exit 69
}

stage=$(mktemp -d "${TMPDIR:-/tmp}/asip-upgrade-fixture.XXXXXX") || exit 1
cleanup() { rm -rf -- "$stage"; }
trap cleanup 0 1 2 3 15

# Copy only filesystem content; Git identity/history is irrelevant to this
# synthetic fixture and the product wheelhouse is intentionally gitignored.
(
	cd "$repo"
	tar --exclude=.git --exclude=wheelhouse --exclude=dist -cf - .
) | tar -xf - -C "$stage"
cp -R "$repo/wheelhouse" "$stage/wheelhouse"
printf '%s\n' "$version" >"$stage/VERSION"
sed -i '0,/^version = "[^"]*"/s//version = "'"$version"'"/' "$stage/pyproject.toml"

rm -f -- "$stage"/wheelhouse/common/asip_mcp-*.whl
python3 -c 'import setuptools; assert tuple(map(int, setuptools.__version__.split(".")[:2])) >= (77, 0)' \
	2>/dev/null || {
	printf 'build_upgrade_fixture.sh: setuptools 77 or newer is required locally\n' >&2
	exit 69
}
python3 -m pip wheel --disable-pip-version-check --quiet --no-deps --no-build-isolation \
	--wheel-dir "$stage/wheelhouse/common" "$stage"
(
	cd "$stage/wheelhouse"
	find . -type f -name '*.whl' -print | LC_ALL=C sort |
		while IFS= read -r wheel; do sha256sum "$wheel"; done >SHA256SUMS
)

ASIP_REQUIRE_WHEELHOUSE=1 SOURCE_DATE_EPOCH=0 \
	"$stage/scripts/build_release.sh" "$output"

#!/bin/sh
# Build a complete ASIP release candidate from locked dependencies.
# Ordinary source archives omit binary wheelhouses; an installable release
# candidate carries them so first install is independent of a checkout and
# package-index state.
set -eu

repo=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
output=${1:-"$repo/dist/candidate"}
[ "$#" -le 1 ] || {
	printf 'Usage: %s [OUTPUT-DIRECTORY]\n' "${0##*/}" >&2
	exit 64
}

"$repo/scripts/build_wheelhouse.sh" "$repo/wheelhouse"
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-0}" \
	"$repo/scripts/build_release.sh" --product "$output"
printf 'ASIP release candidate is ready at %s (inspect release.json before publishing).\n' "$output"

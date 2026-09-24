#!/bin/sh
# Build a deterministic ASIP public release archive and local manifest.
set -eu

repo=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
product=false
if [ "${1:-}" = --product ]; then
	product=true
	shift
fi
output=${1:-"$repo/dist"}
if [ "$#" -gt 1 ]; then
	printf 'Usage: %s [--product] [OUTPUT-DIRECTORY]\n' "${0##*/}" >&2
	exit 64
fi
version=$(sed -n '1p' "$repo/VERSION")

case "$version" in
''|*[!0-9A-Za-z.+-]*)
	printf 'build_release.sh: VERSION is empty or contains unsupported characters\n' >&2
	exit 1
	;;
esac

epoch=${SOURCE_DATE_EPOCH:-}
if [ -z "$epoch" ] && command -v git >/dev/null 2>&1; then
	epoch=$(git -C "$repo" log -1 --format=%ct 2>/dev/null || true)
fi
epoch=${epoch:-0}
case "$epoch" in
''|*[!0-9]*)
	printf 'build_release.sh: SOURCE_DATE_EPOCH must be a non-negative integer\n' >&2
	exit 1
	;;
esac

mkdir -p "$output"
output=$(CDPATH='' cd -- "$output" && pwd)
artifact="$output/asip-$version.tar.gz"
manifest="$output/release.json"

set -- \
	VERSION LICENSE README.md SECURITY.md CONTRIBUTING.md CHANGELOG.md RELEASE_NOTES.md \
	SUPPORT.md INSTALL.md UPGRADE.md UNINSTALL.md install.sh pyproject.toml \
	docs/ARCHITECTURE.md \
	installer packaging/appimage \
	scripts/restore_install_backup.sh scripts/uninstall_software.sh \
	a asip asip-inspect core cli asip_mcp.py \
	eval/cases eval/suites eval/trajectory.schema.json eval/suite.schema.json \
	requirements/mcp.in requirements/mcp-py312-linux-x86_64.lock \
	requirements/mcp-py313-linux-x86_64.lock \
	requirements/mcp-py314-linux-x86_64.lock \
	systemd/asip.socket systemd/asip.service \
	systemd/asip-read.socket systemd/asip-read.service

for file do
	[ -e "$repo/$file" ] || {
		printf 'build_release.sh: required release file is missing: %s\n' "$file" >&2
		exit 1
	}
done

wheelhouse=false
if [ "$product" = true ] || [ "${ASIP_INCLUDE_WHEELHOUSE:-0}" = 1 ] || [ "${ASIP_REQUIRE_WHEELHOUSE:-0}" = 1 ]; then
	[ -d "$repo/wheelhouse" ] || {
		printf 'build_release.sh: requested wheelhouse is absent; run scripts/build_wheelhouse.sh first\n' >&2
		exit 1
	}
	set -- "$@" wheelhouse
	wheelhouse=true
fi

LC_ALL=C tar \
	--sort=name \
	--mtime="@$epoch" \
	--owner=0 --group=0 --numeric-owner \
	--mode='u+rwX,go+rX,go-w' \
	--exclude='*/__pycache__' \
	--exclude='*.py[co]' \
	--transform="s,^,asip-$version/," \
	-czf "$artifact" -C "$repo" "$@"

digest=$(sha256sum "$artifact" | awk '{print $1}')
source_commit=unknown
if command -v git >/dev/null 2>&1; then
	source_commit=$(git -C "$repo" rev-parse HEAD 2>/dev/null || printf unknown)
fi
build_date=unknown
if command -v date >/dev/null 2>&1; then
	build_date=$(date -u -d "@$epoch" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || printf unknown)
fi
{
	printf '{\n'
	printf '  "artifact": "asip-%s.tar.gz",\n' "$version"
	printf '  "build_date": "%s",\n' "$build_date"
	printf '  "build_epoch": %s,\n' "$epoch"
	printf '  "mcp_wheelhouse": %s,\n' "$wheelhouse"
	printf '  "release_channel": "public-preview",\n'
	printf '  "schema_version": 1,\n'
	printf '  "sha256": "%s",\n' "$digest"
	printf '  "source_commit": "%s",\n' "$source_commit"
	printf '  "supported_platforms": ["fedora-44-x86_64"],\n'
	printf '  "version": "%s"\n' "$version"
	printf '}\n'
} >"$manifest"

printf 'artifact=%s\nmanifest=%s\nsha256=%s\nproduct=%s\n' "$artifact" "$manifest" "$digest" "$product"

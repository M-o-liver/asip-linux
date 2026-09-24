#!/bin/sh
# ASIP bootstrap installer. The bootstrap obtains one immutable,
# digest-checked GitHub Release archive, stages its complete payload in the
# user's home, and leaves the one privileged installation step to ASIP.
set -eu

RELEASE_VERSION="${ASIP_RELEASE_VERSION:-0.1.0}"
# ASIP_RELEASE_BASE is an explicit mirror/qualification override. The default
# points at the versioned GitHub Release for the public source repository.
RELEASE_BASE="${ASIP_RELEASE_BASE:-${ASIP_INSTALL_BASE:-https://github.com/M-o-liver/asip-linux/releases/download/v$RELEASE_VERSION}}"
BIN="$HOME/.local/bin"
SOURCE_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
JSON=0
if [ "${1:-}" = "--json" ]; then
	JSON=1
	shift
fi
[ "$#" -eq 0 ] || {
	printf 'Usage: %s [--json]\n' "${0##*/}" >&2
	exit 64
}

die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
if command -v curl >/dev/null 2>&1; then fetch() { curl -fsSL "$1"; }
elif command -v wget >/dev/null 2>&1; then fetch() { wget -qO- "$1"; }
else die 'this needs curl or wget on PATH.'; fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/asip-bootstrap.XXXXXX")" ||
	die 'could not create a temporary staging directory.'
cleanup() { rm -rf -- "$TMP"; }
trap cleanup 0 1 2 3 15

source_tree="$SOURCE_DIR"
manifest_version=local
if [ ! -f "$source_tree/asip" ] || [ ! -d "$source_tree/core" ] ||
		[ ! -d "$source_tree/cli" ]; then
	# A downloaded bootstrap must consume one complete, digest-checked Core
	# release archive. Raw per-file fallbacks were mutable and incomplete.
	command -v python3 >/dev/null 2>&1 || die 'Python 3 is required to read the release manifest.'
	manifest="$TMP/release.json"
	artifact_meta="$TMP/artifact.meta"
	if ! fetch "$RELEASE_BASE/release.json" >"$manifest"; then
		die "could not fetch the release manifest from $RELEASE_BASE"
	fi
	if ! python3 - "$manifest" >"$artifact_meta" <<'PY'
import json, pathlib, re, sys
try:
    data = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
except (OSError, json.JSONDecodeError) as exc:
    raise SystemExit(f"invalid release manifest: {exc}")
artifact, digest, version = data.get("artifact"), data.get("sha256"), data.get("version")
if not isinstance(artifact, str) or not re.fullmatch(r"[A-Za-z0-9_.+-]+", artifact):
    raise SystemExit("release manifest has an unsafe artifact name")
if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", digest):
    raise SystemExit("release manifest has no valid SHA-256 digest")
if not isinstance(version, str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?", version):
    raise SystemExit("release manifest has an invalid version")
print(artifact)
print(digest.lower())
print(version)
PY
	then
		die 'release manifest validation failed.'
	fi
	artifact_name="$(sed -n '1p' "$artifact_meta")"
	expected_digest="$(sed -n '2p' "$artifact_meta")"
	manifest_version="$(sed -n '3p' "$artifact_meta")"
	[ "$manifest_version" = "$RELEASE_VERSION" ] ||
		die "release manifest version $manifest_version does not match requested ASIP version $RELEASE_VERSION"
	artifact="$TMP/$artifact_name"
	if ! fetch "$RELEASE_BASE/$artifact_name" >"$artifact"; then
		die "could not fetch release artifact $artifact_name"
	fi
	if command -v sha256sum >/dev/null 2>&1; then
		actual_digest="$(sha256sum "$artifact" | awk '{print $1}')"
	else
		actual_digest="$(shasum -a 256 "$artifact" | awk '{print $1}')" ||
			die 'sha256sum or shasum is required to verify the release artifact.'
	fi
	[ "$actual_digest" = "$expected_digest" ] ||
		die "release artifact SHA-256 mismatch (expected $expected_digest, got $actual_digest)"
	if ! tar -tzf "$artifact" | awk '
		{ if ($0 ~ /^\// || $0 ~ /(^|\/)\.\.(\/|$)/) bad=1 }
		END { exit bad }
	'; then
		die 'release artifact contains an unsafe path.'
	fi
	release_stage="$TMP/release"
	mkdir -m 0755 "$release_stage"
	tar -xzf "$artifact" -C "$release_stage" --no-same-owner ||
		die 'could not extract the verified release artifact.'
	source_tree="$(find "$release_stage" -mindepth 1 -maxdepth 1 -type d -print -quit)"
	[ -n "$source_tree" ] || die 'release artifact has no top-level directory.'
	[ -f "$source_tree/asip" ] && [ -d "$source_tree/core" ] &&
		[ -d "$source_tree/cli" ] ||
		die "release $manifest_version is missing its Core payload."
fi

mkdir -p "$BIN"
for file in asip a asip-inspect VERSION asip_mcp.py pyproject.toml; do
	[ -f "$source_tree/$file" ] || die "release is missing required file $file"
	cp "$source_tree/$file" "$TMP/$file"
done
[ -d "$source_tree/core" ] || die "release is missing required Core package"
cp -R "$source_tree/core" "$TMP/core"
[ -d "$source_tree/cli" ] || die "release is missing required CLI services package"
cp -R "$source_tree/cli" "$TMP/cli"
mkdir -p "$TMP/systemd"
for file in asip.socket asip.service asip-read.socket asip-read.service; do
	[ -f "$source_tree/systemd/$file" ] || die "release is missing systemd/$file"
	cp "$source_tree/systemd/$file" "$TMP/$file"
done
for directory in installer requirements wheelhouse scripts; do
	if [ -d "$source_tree/$directory" ]; then
		mkdir -p "$TMP/$(dirname -- "$directory")"
		cp -R "$source_tree/$directory" "$TMP/$directory"
	fi
done
if [ -d "$source_tree/eval" ]; then
	cp -R "$source_tree/eval" "$TMP/eval"
fi
mkdir -p "$BIN/systemd"
install -m 755 "$TMP/a" "$BIN/a"
install -m 755 "$TMP/asip" "$BIN/asip"
install -m 755 "$TMP/asip-inspect" "$BIN/asip-inspect"
rm -rf -- "$BIN/core"
cp -R "$TMP/core" "$BIN/core"
find "$BIN/core" -type d -exec chmod 0755 {} +
find "$BIN/core" -type f -exec chmod 0644 {} +
chmod 0755 "$BIN/core/server.py" "$BIN/core/client.py"
rm -f -- "$BIN/asipd.py" "$BIN/asip-client.py" "$BIN/asip_protocol.py"
install -m 644 "$TMP/VERSION" "$BIN/VERSION"
rm -rf -- "$BIN/cli"
cp -R "$TMP/cli" "$BIN/cli"
find "$BIN/cli" -type d -exec chmod 0755 {} +
find "$BIN/cli" -type f -exec chmod 0644 {} +
chmod 0755 "$BIN/cli/asip.sh"
rm -f -- "$BIN/asip_dashboard.py" "$BIN/asip_ui.py" "$BIN/asip_release.py" \
	"$BIN/asip_telemetry.py" "$BIN/asip_eval.py" "$BIN/asip_telemetry_server.py" \
	"$BIN/asip_support.py"
install -m 644 "$TMP/asip_mcp.py" "$BIN/asip_mcp.py"
install -m 644 "$TMP/pyproject.toml" "$BIN/pyproject.toml"
rm -rf -- "$BIN/eval"
if [ -d "$TMP/eval" ]; then
	cp -R "$TMP/eval" "$BIN/eval"
fi
rm -rf -- "$BIN/requirements" "$BIN/wheelhouse" \
	"$BIN/installer" "$BIN/scripts"
if [ -d "$TMP/installer" ]; then cp -R "$TMP/installer" "$BIN/installer"; fi
if [ -d "$TMP/requirements" ]; then
	mkdir -p "$BIN/requirements"
	for file in mcp.in mcp-py312-linux-x86_64.lock \
		mcp-py313-linux-x86_64.lock mcp-py314-linux-x86_64.lock; do
		[ ! -f "$TMP/requirements/$file" ] || cp "$TMP/requirements/$file" "$BIN/requirements/$file"
	done
fi
if [ -d "$TMP/wheelhouse" ]; then cp -R "$TMP/wheelhouse" "$BIN/wheelhouse"; fi
if [ -f "$TMP/scripts/restore_install_backup.sh" ]; then
	mkdir -p "$BIN/scripts"
	cp "$TMP/scripts/restore_install_backup.sh" "$BIN/scripts/restore_install_backup.sh"
fi
if [ -f "$TMP/scripts/uninstall_software.sh" ]; then
	mkdir -p "$BIN/scripts"
	cp "$TMP/scripts/uninstall_software.sh" "$BIN/scripts/uninstall_software.sh"
	chmod 0755 "$BIN/scripts/uninstall_software.sh"
fi
for file in asip.socket asip.service asip-read.socket asip-read.service; do
	install -m 644 "$TMP/$file" "$BIN/systemd/$file"
done

if [ "$JSON" -eq 1 ]; then
	printf '{"status":"bootstrap-installed","client":"%s/asip","compatibility_client":"%s/a","mcp_source":"staged","release":"%s","next":"asip install --privileged"}\n' "$BIN" "$BIN" "$manifest_version"
else
	printf 'Installed ASIP %s bootstrap client at %s/asip (compatibility alias: %s/a)\n\n' "$manifest_version" "$BIN" "$BIN"
	printf 'Use your normal one-time root escalation for:\n\n  %s/asip install --privileged\n\n' "$BIN"
	printf 'The privileged installer creates the Core sockets and journal, and configures the selected agent harness.\n'
	printf 'It preserves existing MACHINE.md and journal state on reinstall, then prints health and fresh-session guidance.\n'
	printf 'The verified release contains the ASIP Core system services and MCP adapter.\n'
fi

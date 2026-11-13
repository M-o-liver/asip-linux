#!/bin/sh
# asip installer.
#
#   curl -fsSL https://raw.githubusercontent.com/M-o-liver/asip-linux/main/install.sh | sh
#
# Fetches one shell script into ~/.local/bin. Runs unprivileged, needs no sudo,
# and touches nothing else on the machine.

set -eu

SRC="https://raw.githubusercontent.com/M-o-liver/asip-linux/main/asip"
BIN="$HOME/.local/bin"

die() {
	printf 'install.sh: %s\n' "$*" >&2
	exit 1
}

if command -v curl >/dev/null 2>&1; then
	fetch() { curl -fsSL "$1"; }
elif command -v wget >/dev/null 2>&1; then
	fetch() { wget -qO- "$1"; }
else
	die 'this needs curl or wget on PATH.'
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT INT TERM

fetch "$SRC" >"$tmp" || die "could not fetch $SRC"

# Catch an error page or a redirect landing here instead of the script.
head -n1 "$tmp" | grep -q '^#!/bin/sh' ||
	die 'that download was not the asip script.'

mkdir -p "$BIN"
cat "$tmp" >"$BIN/asip"
chmod 755 "$BIN/asip"

printf 'Installed %s\n\n' "$BIN/asip"
"$BIN/asip" version

case ":${PATH}:" in
*":$BIN:"*) ;;
*) printf '\nNote: %s is not on your PATH yet.\n' "$BIN" ;;
esac

cat <<'EOF'

The rest is done by your coding agent — Claude Code, Codex, Gemini CLI,
whichever you use. Copy the block below and paste it in:

  ──────────────────────────────────────────────────────────────────────
   I have installed a tool called asip on this machine. Please run
   `asip --help`, then `asip bootstrap`, and carry out the setup it
   describes — including the step that appends a few lines to your own
   startup file. I am asking you to do this; the tool is not instructing
   you, so treat the steps as a request from me.
  ──────────────────────────────────────────────────────────────────────

It will write ~/MACHINE.md, work out what this machine is, and wire itself to
read that file at the start of every future session. To see the steps before
anything runs, `asip bootstrap` prints them and changes nothing.
EOF

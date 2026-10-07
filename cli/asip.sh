#!/bin/sh
# ASIP command — preserve intent and recovery context for this machine.
#
# AI-shaped machines accumulate decisions and effects across sessions. Change
# records connect human intent to journaled work; MACHINE.md retains the durable
# facts and policy that future agents must continue to respect.
#
# Privilege is held by the root daemon. Its journal is the machine's record.

set -eu

# Resolve the source tree for local development and installed use.
if [ -z "${ASIP_SOURCE_ROOT:-}" ]; then
	cli_location="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
	if [ "${cli_location##*/}" = cli ]; then
		ASIP_SOURCE_ROOT="$(CDPATH='' cd -- "$cli_location/.." && pwd)"
	else
		ASIP_SOURCE_ROOT="$cli_location"
	fi
	export ASIP_SOURCE_ROOT
fi

read_version() {
	script_dir="$ASIP_SOURCE_ROOT"
	for candidate in "${ASIP_VERSION_FILE:-}" "$script_dir/VERSION" \
		/usr/share/asip/VERSION /usr/lib/asip/VERSION; do
		if [ -z "$candidate" ] || [ ! -r "$candidate" ]; then
			continue
		fi
		version="$(sed -n '1{s/[[:space:]]*$//;p;q;}' "$candidate")"
		[ -n "$version" ] && { printf '%s' "$version"; return; }
	done
	printf 'unknown'
}

VERSION="$(read_version)"
PROG="${ASIP_PROG:-${0##*/}}"

CHANGE_ID="${ASIP_CHANGE_ID:-}"
STANDALONE_REASON="${ASIP_STANDALONE_REASON:-}"
REQUEST_KEY="${ASIP_REQUEST_KEY:-}"
JSON=0
while [ "$#" -gt 0 ]; do
	case "$1" in
	--change)
		[ -n "${2:-}" ] || { printf '%s: --change needs an ID\n' "$PROG" >&2; exit 64; }
		CHANGE_ID="$2"
		shift 2
		;;
	--change=*)
		CHANGE_ID="${1#--change=}"
		[ -n "$CHANGE_ID" ] || { printf '%s: --change needs an ID\n' "$PROG" >&2; exit 64; }
		shift
		;;
	--standalone)
		[ -n "${2:-}" ] || { printf '%s: --standalone needs a reason\n' "$PROG" >&2; exit 64; }
		STANDALONE_REASON="$2"
		shift 2
		;;
	--request-key)
		[ -n "${2:-}" ] || { printf '%s: --request-key needs a value\n' "$PROG" >&2; exit 64; }
		REQUEST_KEY="$2"
		shift 2
		;;
	--json)
		JSON=1
		shift
		;;
	*) break ;;
	esac
done
[ -z "$CHANGE_ID" ] || [ -z "$STANDALONE_REASON" ] || {
	printf '%s: use either --change or --standalone, not both\n' "$PROG" >&2
	exit 64
}

# ---------------------------------------------------------------- detection --

detect_distro() {
	if [ -r /etc/os-release ]; then
		# shellcheck disable=SC1091
		. /etc/os-release
		printf '%s' "${PRETTY_NAME:-${NAME:-unknown}}"
	else
		printf 'unknown'
	fi
}

detect_pkgmgr() {
	for m in dnf apt-get pacman zypper emerge apk xbps-install; do
		if command -v "$m" >/dev/null 2>&1; then
			printf '%s' "$m"
			return
		fi
	done
	printf 'unknown'
}

detect_rootfs() { findmnt -no FSTYPE / 2>/dev/null || printf 'unknown'; }

detect_snapshotter() {
	for s in snapper timeshift zfs; do
		if command -v "$s" >/dev/null 2>&1; then
			printf '%s' "$s"
			return
		fi
	done
	if [ "$(detect_rootfs)" = "btrfs" ]; then printf 'btrfs-raw'; else printf 'none'; fi
}

# Identify the running service manager for inspection and service actions.
detect_initsys() {
	if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
		printf 'systemd'
	elif command -v rc-service >/dev/null 2>&1; then
		printf 'openrc'
	elif command -v service >/dev/null 2>&1; then
		printf 'sysv'
	else
		printf 'unknown'
	fi
}

detect_desktop() { printf '%s' "${XDG_CURRENT_DESKTOP:-${DESKTOP_SESSION:-none}}"; }


find_machine_md() {
	# The installed machine policy is canonical; home paths serve local scaffolding.
	for p in "${ASIP_MACHINE:-}" /etc/asip/MACHINE.md "$HOME/MACHINE.md" \
		"$HOME/dotfiles/MACHINE.md" "$HOME/.asip/MACHINE.md"; do
		[ -n "$p" ] && [ -r "$p" ] && { printf '%s' "$p"; return; }
	done
	printf ''
}

SECTIONS='System Identity
Administrative Root
Package Provenance
Operator Preferences
Decision Log
Recovery
Safety Rules
Diagnostics
Environment Map'

section_regex() {
	case "$1" in
	'System Identity') printf 'identity|hardware|the machine|system facts' ;;
	'Administrative Root') printf 'administrative|admin root|repo|dotfile|how this|config root|ground rules' ;;
	'Package Provenance') printf 'provenance|package|software source|where.*from' ;;
	'Operator Preferences') printf 'operator preference|response style|communication|interaction' ;;
	'Decision Log') printf 'decision|quirk|scar|gotcha|known issue|log' ;;
	'Recovery') printf 'recovery|recover|snapshot|rollback|roll back|restore|undo' ;;
	'Safety Rules') printf 'safety|off.limits|hard limit|never|forbidden' ;;
	'Diagnostics') printf 'diagnostic|triage|health|before you' ;;
	'Environment Map') printf 'environment|env map|current state|day to day|what.s installed' ;;
	esac
}

expected_empty() { [ "$1" = 'Decision Log' ]; }

# ---------------------------------------------------------------------- help --

cmd_help() {
	cat <<EOF
$PROG $VERSION — ASIP continuity and recovery for an agent-shaped Linux machine.

USAGE
  $PROG [--change ID | --standalone WHY] [--request-key KEY] [--json] <command> [arguments]

The short alias 'a' runs the same command.

COMMANDS
  install --privileged       Install source; an existing daemon requires an explicit restart.
  desktop [install]          Open/install the optional local application.
  bootstrap [--harness all]  Wire agent harnesses to /etc/asip/MACHINE.md.
  change start|finish|fail    Record an intent and its outcome.
  change hold|release         Gate known work without making a planner.
  change supersede OLD NEW    Close stale intent in favour of another change.
  change list|open|show      Inspect durable intent; show ID is the one inspect.
                            Add --json for structured data.
  note PATH WHY               Attach an important userland effect to a change.
  do [OPTIONS] -- COMMAND     Run privileged work; annotate effects/capture.
  pkg install|remove PKG...  Change packages; use Snapper first if available.
  svc ACTION [UNIT]            Run systemctl through the ASIP daemon.
  conf PATH -- COMMAND       Change a config file; before/after are saved.
  observe PATH CHANGE        Journal an external change already integrated.
  audit pending               Summarize audit events not yet integrated.
  verify list                 Show the latest in-situ verification per tool.
  verify pass|fail TOOL NOTE  Record a result; optional evidence IDs supported.
  snap REASON                Take and journal a snapshot.
  rollback HANDLE            Restore by ASIP recovery_handle, not Snapper #.
  log [ID]                   Read the journal or one action and its output.
  project set NAME PATH WHY  Idempotently update the system project map.
  project remove NAME|PATH   Remove a stale project registration.
  index [HINT]               Find projects with one grep.
  drift decide KIND ITEM WHY Record accepted provenance decisions.
  brief                      Deterministic agent entry: attention, caller, blocking.
  context [CWD]              Bind cwd/project, caller, and supplied change ID.
  policy                     Complete MACHINE.md. Never an excerpt.
  summary                    Return typed product/system aggregates.
  recovery                   Read-only Snapper timeline and journal snapshot IDs.
  facts catalog|get SPEC     Bounded live facts. Held work is change show.
  ask pose|list|show|answer   Ask the operator through the configured question surface.
  access list|show|request|use     Discover or exercise named external authority.
  mcp install|status         Install/check the isolated MCP adapter dependency.
  mcp config inspect|admin   Print a local stdio MCP host configuration.
  skeleton, discover, rule, doctor, drift, version

ACCESS
  /run/asip/sock is root:asip 0660. Membership in group asip is
  ROOT-EQUIVALENT: it permits submitting arbitrary root commands through
  the root daemon. Socket access is a grant of root authority, not a policy allowlist.
  /run/asip/read.sock is root:asip-read 0660. Use asip-inspect for queries;
  asip-read membership does not permit execution or journal mutation.

CHANGE ASSOCIATION
  Use --change ID or ASIP_CHANGE_ID on each related command. Association is
  explicit per process; ASIP never infers an active change from the Unix UID.
  Isolated mutations require --standalone WHY. --request-key makes retries safe.
EOF
}

# ----------------------------------------------------------------- bootstrap --


# ------------------------------------------------------------------ skeleton --

cmd_skeleton() {
	host="$(hostname 2>/dev/null || printf 'unknown')"
	distro="$(detect_distro)"
	desktop="$(detect_desktop)"

	cat <<EOF
# MACHINE.md — $host

$distro, $desktop.

What this file is for: the things about this machine that cannot be worked
out by looking at it. Anyone — or anything — working on this machine should
read it first, and trust it over general knowledge about $distro. Where it
disagrees with the live system, the live system is right: check, then fix
the file.

Keeping it true is part of the work. This describes how the machine is set
up, so changes made here can make it wrong. After installing something that
carries its own configuration, adding a repository, changing a shell, or
altering a service, correct the section covering that ground at the same
time. A description that is quietly out of date is worse than none, because
it gets believed.

## System Identity
<!-- The hardware, limited to what is load-bearing — the parts that break
     something if assumed wrong. Chassis, CPU, graphics and which device
     drives the display, storage layout, boot and encryption, other
     operating systems on disk. Say what must stay as it is, and why. -->

<!-- Volatile, high-impact facts can carry a machine-checkable freshness cue:
     asip:fact-example observed-at=2026-03-14 max-age-days=90 checked-by="command"
     Keep the annotation on the fact's line. 'asip doctor' flags stale facts. -->

## Administrative Root
<!-- Where configuration lives, how it is deployed, and which copy is
     authoritative. If there is a dotfiles repository, name it and say edits
     belong there. If changes are expected to be committed, say so — that is
     what makes it happen. Note where the base configuration came from: a
     file owned by a package updates with it, a file seeded from /etc/skel
     never will. -->

## Package Provenance
<!-- A table, one row per component chosen rather than inherited:

     | Component | Source | Notes |

     Chosen means: the terminal, editor, shell, browser, multiplexer, file
     manager, drivers, desktop extensions — anything another machine might
     reasonably do differently. Plus everything from outside the default
     repositories, and everything installed outside the package manager,
     which updates by no mechanism at all.

     Installing one of these adds a row. That obligation is what keeps the
     section current instead of a snapshot of the day it was written. -->

## Operator Preferences
<!-- Durable preferences that apply across agents and projects. Examples:
     response tone, desired detail, when to ask before acting, and preferred
     tools. Keep project-specific conventions in the project itself.

     If a knowledge base (Obsidian vault, wiki, notes repo) exists separately
     from this file, say what each is for — they are rarely interchangeable.
     This file tends to end up the agent's own operational record: what was
     done, why, and how to recover. A separate knowledge base tends to be for
     the operator's own understanding, and usually wants sessions with lasting
     technical value offered into it proactively, not only on request — ask
     whether that is wanted and record the answer.

     If the operator collaborates through Git hosting, record the default:
     private vs public per new repository, when a push is expected as part of
     finishing a change versus staying local, and whether direct pushes or
     pull requests are the norm even working solo. -->

## Decision Log
<!-- The section that cannot be generated. One entry per lesson:

     **Thing (YYYY-MM-DD, status):** the symptom, the cause, what was
     decided, and what to do now — often nothing.

     Include things considered and rejected, with the condition that would
     justify revisiting. Something left broken on purpose looks identical to
     something nobody has fixed yet; only this section tells them apart.

     Also the place for standing operational policy an agent would otherwise
     have to guess at fresh every session: whether to update unprompted and
     on what cadence (a rolling-release system usually wants a different
     answer than a point-release one), how often an unprompted security
     review is worth running, what counts as disruptive enough to ask first.
     These aren't generated either — ask the operator once, record the
     answer in their words. -->

## Recovery
<!-- How this machine is rolled back, and when doing so is required rather
     than optional. Name the mechanism and the exact command. Keep system
     state and user configuration separate if they recover differently. -->

## Safety Rules
<!-- Handle credentials, keys and tokens carefully as a matter of course;
     that needs no writing down. This section is for what is specific here
     and would otherwise surprise: a disk easily mistaken for another, a
     partition belonging to a different operating system, a service to leave
     running. -->

## Diagnostics
<!-- The commands to run before changing anything, and what each is for.
     The point is to make checking cheaper than guessing. -->

## Environment Map
<!-- What this machine is day to day, naming the specific programs:
     desktop, display manager, shell, terminal emulator, multiplexer,
     editor, file manager, browser, remote access, services expected to be
     running.

     Name them. A section that says "a desktop and a shell" cannot be made
     wrong by anything; one that says "gnome-terminal" goes stale the moment
     the terminal changes, and that is the point — it is what turns a swap
     into an obvious edit rather than a judgement call. -->
EOF
}

# ------------------------------------------------------------------ discover --

cmd_discover() {
	distro="$(detect_distro)"
	pkg="$(detect_pkgmgr)"
	fs="$(detect_rootfs)"
	snap="$(detect_snapshotter)"
	desktop="$(detect_desktop)"

	cat <<EOF
CHECKLIST — $(hostname 2>/dev/null || printf 'this machine')
$distro | packages: $pkg | root: $fs | snapshots: $snap | desktop: $desktop

Every command below is read-only. Run them, read the output, write what you
find into the matching section of MACHINE.md. Anything not checked is worth
saying so rather than assuming.

SYSTEM IDENTITY
  hostnamectl
  lscpu | head -20
  lspci -k | grep -A3 -Ei 'vga|3d'
  lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINT,MODEL
  free -h

  Watch for: more than one graphics device (say which drives the display),
  encrypted volumes, more than one operating system on disk — anything that
  makes a general answer about $distro wrong here.

ADMINISTRATIVE ROOT
  ls -la ~ | head -30
  ls -la ~/.config | head -30

  Watch for: a dotfiles repository, and whether files under ~/.config are
  symlinks into it. If they are, that matters — writing to the live path
  instead of the repository silently forks the configuration.

  No dotfiles repository is a finding, not the end of it. Every machine has
  a base configuration whether or not anyone set one up, and where it came
  from decides whether edits survive an update:
EOF

	case "$pkg" in
	pacman) printf '    ls -la /etc/skel\n    pacman -Qs config | head -20\n    pacman -Qo ~/.bashrc ~/.zshrc ~/.config/fish/config.fish 2>&1\n' ;;
	dnf) printf '    ls -la /etc/skel\n    rpm -qf ~/.bashrc ~/.zshrc 2>&1\n' ;;
	apt-get) printf '    ls -la /etc/skel\n    dpkg -S ~/.bashrc ~/.profile 2>&1\n' ;;
	*) printf '    ls -la /etc/skel\n' ;;
	esac

	cat <<'EOF'

  A file the package manager owns is updated with the package, and local
  edits surface as .pacnew/.rpmnew. A file copied from /etc/skel at account
  creation is owned by nothing: it was written once and will never be
  updated again. The two look identical on disk and behave in opposite
  ways, so record which this machine has.

PACKAGE PROVENANCE
EOF

	case "$pkg" in
	pacman) printf '  pacman -Qm            # installed from outside the configured repositories\n  cat /etc/pacman.conf | grep -A2 "^\\["\n' ;;
	dnf) printf '  dnf repolist\n  dnf history | head -20\n  ls /etc/yum.repos.d/\n' ;;
	apt-get) printf '  apt-cache policy | head -30\n  ls /etc/apt/sources.list.d/\n' ;;
	*) printf '  Record by hand how software is installed here.\n' ;;
	esac

	cat <<'EOF'
  ls ~/.local/bin /usr/local/bin 2>/dev/null

  Anything in those last two updates by no mechanism at all. Say so.

DECISION LOG
  Nothing to run. This section records experience, not inspection.

  Worth asking whoever runs this machine: is anything here broken or unusual
  on purpose, that should be left alone? Also worth asking, if privileged
  execution is set up: how they want unprompted updates and security review
  handled, and on what cadence — especially on a rolling-release system,
  where that answer usually differs from a point-release one. Record the
  answers in their words. Otherwise leave it empty.

RECOVERY
EOF

	case "$snap" in
	snapper) printf '  snapper list-configs\n  snapper list 2>/dev/null | tail -5\n\n  Record the exact command to take a snapshot before a risky change, the\n  command to roll back, and which subvolumes a rollback does NOT cover.\n' ;;
	timeshift) printf '  timeshift --list\n\n  Record the snapshot and restore commands.\n' ;;
	zfs) printf '  zfs list -t snapshot | tail -5\n\n  Record the dataset layout and the rollback command.\n' ;;
	btrfs-raw) printf '  btrfs subvolume list /\n\n  Root is btrfs with no snapshot manager installed. Write that down as a\n  fact: rollback is possible in principle and not set up in practice.\n' ;;
	*) printf '  No snapshot mechanism found. Record that plainly, and what the fallback\n  is — backups, reinstall, or nothing.\n' ;;
	esac

	cat <<'EOF'
  git -C ~/dotfiles log --oneline | head -5      # if a dotfiles repo exists

SAFETY RULES
  Nothing to run, and nothing to go looking through. Handle credentials,
  keys and tokens carefully as a matter of course — no list written here
  would cover the one that mattered.

  What belongs in this section is local: a disk easily mistaken for another,
  a partition belonging to a different operating system, a service to leave
  alone. Ask, and record the answer.

DIAGNOSTICS
  Assemble the handful of commands worth running before changing anything
  on this machine. A starting set:

    journalctl -b -p err --no-pager | tail -50
    systemctl --failed
EOF

	[ "$pkg" = "dnf" ] && printf '    dnf history | head\n'
	[ "$pkg" = "pacman" ] && printf '    tail -20 /var/log/pacman.log\n'
	case "$desktop" in
	*GNOME*) printf '    gnome-extensions list --enabled\n' ;;
	*KDE*) printf '    plasmashell --version\n' ;;
	esac

	cat <<'EOF'

  Keep 'systemctl --failed' in the list even when it is clean. A failed unit
  hides the next one.

ENVIRONMENT MAP
  echo "$SHELL"; echo "$XDG_CURRENT_DESKTOP"; echo "$XDG_SESSION_TYPE"
  systemctl list-units --type=service --state=running | head -20
  ip -brief addr

  Watch for: remote access expected to keep working, and anything that would
  make this machine unreachable after a reboot — full-disk encryption, a VPN
  that starts only after login.
EOF
}

# ---------------------------------------------------------------------- rule --

print_agent_rule() {
	cat <<'EOF'

<!-- ASIP: BEGIN -->
## ASIP — privileged Linux operations

Read `/etc/asip/MACHINE.md` before system administration. It contains local
constraints, recovery facts, and operator decisions that may not be visible
from inspection.

Use `asip_brief` when beginning system work. Use typed ASIP MCP tools for
package, service, configuration, snapshot, audit, and recovery operations. Use
`asip_do` only when no typed operation fits; it runs the requested command as
root. Use ordinary unprivileged tools directly for userland work. Do not use
`sg` to bypass socket access or change the recorded caller identity.
If `attention` contains operator items, mention their count and that ASIP
presents them. Do not reclassify holds or live observations as alerts.

Access to group `asip` or `/run/asip/sock` grants arbitrary root authority. ASIP
records and serializes work; it is not a sandbox or command allowlist. The
separate `/run/asip/read.sock` interface permits inspection but not execution or
journal mutation.

For each coherent system task, create a change with `change_start`, include its
ID on related mutations, and finish, fail, or hold it explicitly. Use
`note_record` for important paths or outcomes so later work can recover context.
ASIP does not infer the active change from the Unix user.

For external credentials, use `access_list`, `access_request`, and `access_use`
with the authority's stable name. Never request or copy credential values into
chat or logs. Use `access_use(background=true)` for a long-lived process;
ordinary `access_use` is finite and synchronous.

Read the full machine policy and inspect recovery state before acting on
networking, remote access, or other host-critical services. ASIP does not
prevent an authorized root command from disrupting them, and logged operations
are not necessarily reversible.
<!-- ASIP: END -->
EOF
}

cmd_rule() {
	tool="${1:-}"

	if [ -z "$tool" ]; then
		cat <<EOF
Usage: $PROG rule <tool>

Prints the ASIP instruction block for that tool. Every block refers to the
canonical /etc/asip/MACHINE.md.

  claude       ~/.claude/CLAUDE.md
  codex        ~/.codex/AGENTS.md
  grok         ~/.grok/AGENTS.md
  gemini       ~/.gemini/GEMINI.md
  goose        ~/.config/goose/.goosehints
  qwen         ~/.qwen/QWEN.md
  generic      plain text, no include syntax

These paths change as the tools do. Check against the tool's own
documentation, and use 'generic' if unsure.
EOF
		return 0
	fi

	case "$tool" in
	claude | gemini | qwen | codex | grok | goose | generic) ;;
	*)
		printf '%s: unknown tool "%s". Run "%s rule" for the list.\n' \
			"$PROG" "$tool" "$PROG" >&2
		return 1
		;;
	esac

	print_agent_rule
}

# -------------------------------------------------------------------- doctor --

git_last_for_file() {
	file="$1"
	dir="$(dirname "$file")"
	repo="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || true)"
	[ -n "$repo" ] || return 1
	rel="$(realpath --relative-to="$repo" "$file" 2>/dev/null || true)"
	if [ -z "$rel" ] || ! git -C "$repo" ls-files --error-unmatch -- "$rel" >/dev/null 2>&1; then
		return 1
	fi
	git -C "$repo" log -1 --format='%as (%s)' -- "$rel" 2>/dev/null
}

find_machine_mirror() {
	canonical="$1"
	for candidate in "${ASIP_MACHINE_MIRROR:-}" "$HOME/MACHINE.md" \
		"$HOME/dotfiles/MACHINE.md" "$HOME/.asip/MACHINE.md"; do
		if [ -z "$candidate" ] || [ "$candidate" = "$canonical" ] || [ ! -r "$candidate" ]; then
			continue
		fi
		cmp -s "$canonical" "$candidate" || continue
		[ -n "$(git_last_for_file "$candidate" || true)" ] || continue
		printf '%s' "$candidate"
		return 0
	done
	return 1
}

cmd_doctor() {
	if [ "${1:-}" = "--json" ] || [ "$JSON" -eq 1 ]; then
		if [ "${1:-}" = "--json" ]; then
			[ "$#" -eq 1 ] || { printf 'Usage: %s doctor [--json]\n' "$PROG" >&2; return 64; }
		else
			[ "$#" -eq 0 ] || { printf 'Usage: %s doctor [--json]\n' "$PROG" >&2; return 64; }
		fi
		request_readonly --json --op doctor
		return
	fi
	[ "$#" -eq 0 ] || { printf 'Usage: %s doctor [--json]\n' "$PROG" >&2; return 64; }
	rc=0
	md="$(find_machine_md)"

	printf '%s %s — doctor\n\n' "$PROG" "$VERSION"

	if [ -z "$md" ]; then
		printf 'MACHINE.md   not found\n'
		printf '  Looked in ~/MACHINE.md, ~/dotfiles/MACHINE.md, ~/.asip/MACHINE.md,\n'
		# shellcheck disable=SC2016  # naming the variable, not expanding it
		printf '  /etc/asip/MACHINE.md, and $ASIP_MACHINE.\n\n'
		printf '  Run "%s bootstrap" to set one up.\n' "$PROG"
		return 1
	fi

	printf 'MACHINE.md   %s\n' "$md"
	last="$(git_last_for_file "$md" 2>/dev/null || true)"
	if [ -n "$last" ]; then
		printf '  tracked, last changed %s\n' "$last"
	else
		mirror="$(find_machine_mirror "$md" || true)"
		if [ -n "$mirror" ]; then
			last="$(git_last_for_file "$mirror")"
			printf '  tracked by byte-identical mirror %s\n' "$mirror"
			printf '  mirror last changed %s\n' "$last"
		else
			printf '  no tracked byte-identical copy found — set ASIP_MACHINE_MIRROR if one exists\n'
			rc=1
		fi
	fi

	printf '\nObserved facts\n'
	fact_lines="$(grep -n 'asip:fact ' "$md" 2>/dev/null || true)"
	if [ -z "$fact_lines" ]; then
		printf '  none annotated (optional; useful for volatile, high-impact facts)\n'
	else
		oldifs="$IFS"
		IFS='
'
		for fact in $fact_lines; do
			line_no="${fact%%:*}"
			observed="$(printf '%s' "$fact" | sed -n 's/.*observed-at=\([0-9][0-9-]*\).*/\1/p')"
			max_age="$(printf '%s' "$fact" | sed -n 's/.*max-age-days=\([0-9][0-9]*\).*/\1/p')"
			if [ -z "$observed" ] || ! printf '%s' "$fact" | grep -q 'checked-by='; then
				printf '  line %-5s incomplete — needs observed-at and checked-by\n' "$line_no"
				rc=1
				continue
			fi
			state='current'
			if [ -n "$max_age" ]; then
				observed_epoch="$(date -d "$observed" +%s 2>/dev/null || echo 0)"
				now_epoch="$(date +%s)"
				[ "$observed_epoch" -gt 0 ] && [ "$now_epoch" -gt $((observed_epoch + max_age * 86400)) ] && state='STALE' && rc=1
			fi
			printf '  line %-5s %-7s observed %s%s\n' "$line_no" "$state" "$observed" "${max_age:+ (max ${max_age}d)}"
		done
		IFS="$oldifs"
	fi

	printf '\nSections\n'
	filled="$(awk '
		BEGIN { inc = 0; h = ""; n = 0 }
		{
			line = $0
			if (inc) { if (line ~ /-->/) { inc = 0; sub(/.*-->/, "", line) } else next }
			if (line ~ /<!--/) {
				if (line ~ /-->/) { gsub(/<!--.*-->/, "", line) }
				else { sub(/<!--.*/, "", line); inc = 1 }
			}
			if (line ~ /^## /) {
				if (h != "") printf "%s\t%d\n", h, n
				h = substr(line, 4); n = 0; next
			}
			gsub(/^[ \t]+|[ \t]+$/, "", line)
			if (h != "" && line != "") n++
		}
		END { if (h != "") printf "%s\t%d\n", h, n }
	' "$md")"

	tab="$(printf '\t')"
	missing=0
	blank=0
	consumed=''
	oldifs="$IFS"
	IFS='
'
	for want in $SECTIONS; do
		rx="$(section_regex "$want")"
		mhead=''
		mcount=0
		for line in $filled; do
			head="${line%%"$tab"*}"
			cnt="${line##*"$tab"}"
			case "$consumed" in *"<$head>"*) continue ;; esac
			if printf '%s' "$head" | grep -Eiq "$rx"; then
				mhead="$head"
				case "$cnt" in '' | *[!0-9]*) mcount=0 ;; *) mcount="$cnt" ;; esac
				consumed="$consumed<$head>"
				break
			fi
		done

		if [ -z "$mhead" ]; then
			printf '  %-22s absent\n' "$want"
			missing=$((missing + 1))
		elif [ "$mcount" -eq 0 ]; then
			if expected_empty "$want"; then
				printf '  %-22s empty — expected, it fills over months\n' "$want"
			else
				printf '  %-22s empty\n' "$want"
				blank=$((blank + 1))
			fi
		else
			seen=''
			[ "$mhead" != "$want" ] && seen="   <- \"$mhead\""
			printf '  %-22s %3s lines%s\n' "$want" "$mcount" "$seen"
		fi
	done

	extra=''
	for line in $filled; do
		head="${line%%"$tab"*}"
		case "$consumed" in *"<$head>"*) continue ;; esac
		extra="$extra    $head
"
	done
	IFS="$oldifs"

	if [ -n "$extra" ]; then
		printf '\n  Additional sections — the list is a floor, not a limit:\n'
		printf '%s' "$extra"
	fi

	printf '\nReferenced by\n'
	any=0
	for pair in \
		"claude:claude:$HOME/.claude/CLAUDE.md" \
		"codex:codex:$HOME/.codex/AGENTS.md" \
		"grok:grok:$HOME/.grok/AGENTS.md" \
		"gemini:gemini:$HOME/.gemini/GEMINI.md" \
		"goose:goose:$HOME/.config/goose/.goosehints" \
		"qwen:qwen:$HOME/.qwen/QWEN.md"; do
		name="${pair%%:*}"
		rest="${pair#*:}"
		bin="${rest%%:*}"
		file="${rest#*:}"
		command -v "$bin" >/dev/null 2>&1 || continue
		any=1
		if [ -r "$file" ] && grep -q 'MACHINE\.md' "$file" 2>/dev/null; then
			printf '  %-22s yes  (%s)\n' "$name" "$file"
		else
			printf '  %-22s no   (%s)\n' "$name" "$file"
			printf '  %-22s      %s rule %s >> %s\n' '' "$PROG" "$name" "$file"
			rc=1
		fi
	done
	[ "$any" -eq 0 ] && printf '  no known tools installed\n'

	printf '\n'
	[ "$missing" -gt 0 ] && {
		printf '%s section(s) absent. "%s skeleton" shows what they are for.\n' "$missing" "$PROG"
		rc=1
	}
	[ "$blank" -gt 0 ] && {
		printf '%s section(s) empty. "%s discover" prints what to run.\n' "$blank" "$PROG"
		rc=1
	}
	[ "$rc" -eq 0 ] && printf 'Complete.\n'
	return "$rc"
}

# --------------------------------------------------------------------- drift --
# What has changed on this machine since the description was last updated.
# Mechanical: it compares installed software against the words in the file,
# so it catches the ordinary-feeling install that nobody judged worth writing
# down. Reports only; nothing here edits anything.

cmd_drift() {
	decisions=/etc/asip/drift.md
	case "${1:-}" in
	decide)
		kind="${2:-}"; item="${3:-}"
		if [ -z "$kind" ] || [ -z "$item" ]; then
			printf 'Usage: %s drift decide ignore|documented|managed-by-project ITEM WHY\n' "$PROG" >&2
			return 64
		fi
		shift 3
		[ "$#" -gt 0 ] || { printf 'Usage: %s drift decide KIND ITEM WHY\n' "$PROG" >&2; return 64; }
		request --op drift-decision --action "$kind" --reason "$*" -- "$item"
		return
		;;
	decisions)
		[ "$#" -eq 1 ] || { printf 'Usage: %s drift decisions\n' "$PROG" >&2; return 64; }
		if [ -r "$decisions" ]; then
			cat "$decisions"
		else
			printf 'No drift decisions recorded.\n'
		fi
		return
		;;
	'') ;;
	*) printf 'Usage: %s drift [decisions | decide KIND ITEM WHY]\n' "$PROG" >&2; return 64 ;;
	esac
	md="$(find_machine_md)"
	if [ -z "$md" ]; then
		printf '%s: no MACHINE.md found. Run "%s bootstrap" first.\n' "$PROG" "$PROG" >&2
		return 1
	fi

	dir="$(dirname "$md")"
	since=''
	if command -v git >/dev/null 2>&1 &&
		git -C "$dir" rev-parse --git-dir >/dev/null 2>&1; then
		since="$(git -C "$dir" log -1 --format=%ct -- "$md" 2>/dev/null || true)"
	fi
	[ -n "$since" ] || since="$(stat -c %Y "$md" 2>/dev/null || echo 0)"
	stamp="$(date -d "@$since" '+%Y-%m-%d %H:%M' 2>/dev/null || echo 'unknown')"

	printf '%s %s — drift\n\n' "$PROG" "$VERSION"
	printf '%s\nlast updated %s\n\n' "$md" "$stamp"

	tmp="$(mktemp)"
	trap 'rm -f "$tmp"' EXIT INT TERM
	: >"$tmp"

	iso="$(date -d "@$since" '+%Y-%m-%dT%H:%M:%S' 2>/dev/null || echo '')"
	case "$(detect_pkgmgr)" in
	pacman)
		[ -r /var/log/pacman.log ] && [ -n "$iso" ] &&
			awk -v s="$iso" '/\[ALPM\] installed / {
				t = substr($1, 2, 19)
				if (t > s) print $4
			}' /var/log/pacman.log | sort -u >"$tmp"
		;;
	dnf | zypper)
		rpm -qa --qf '%{INSTALLTIME} %{NAME}\n' 2>/dev/null |
			awk -v s="$since" '$1 + 0 > s + 0 { print $2 }' | sort -u >"$tmp"
		;;
	apt-get)
		[ -r /var/log/dpkg.log ] && [ -n "$iso" ] &&
			awk -v s="$iso" '$3 == "install" {
				t = $1 "T" $2
				if (t > s) { n = $4; sub(/:.*/, "", n); print n }
			}' /var/log/dpkg.log | sort -u >"$tmp"
		;;
	esac

	found=0
	if [ -s "$tmp" ]; then
		printf 'Installed since, and not mentioned in the file:\n'
		while IFS= read -r p; do
			[ -n "$p" ] || continue
			grep -qiF -- "$p" "$md" 2>/dev/null && continue
			[ -r "$decisions" ] && grep -qF -- "\`$p\`" "$decisions" 2>/dev/null && continue
			printf '  %s\n' "$p"
			found=$((found + 1))
		done <"$tmp"
		[ "$found" -eq 0 ] && printf '  (everything installed since is mentioned)\n'
	else
		printf 'No package installs recorded since then.\n'
	fi

	# Software outside the package manager updates by no mechanism at all,
	# which is exactly the kind of thing worth naming.
	loose=0
	for d in "$HOME/.local/bin" /usr/local/bin; do
		[ -d "$d" ] || continue
		for f in "$d"/*; do
			if [ ! -f "$f" ] || [ ! -x "$f" ]; then
				continue
			fi
			n="${f##*/}"
			grep -qiF -- "$n" "$md" 2>/dev/null && continue
			[ -r "$decisions" ] && grep -qF -- "\`$f\`" "$decisions" 2>/dev/null && continue
			[ "$loose" -eq 0 ] && printf '\nOutside the package manager, and not mentioned:\n'
			printf '  %s\n' "$f"
			loose=$((loose + 1))
		done
	done

	printf '\n'
	if [ "$found" -eq 0 ] && [ "$loose" -eq 0 ]; then
		printf 'No drift found.\n'
		return 0
	fi
	printf 'Each finding belongs in Package Provenance or needs a durable decision:\n'
	printf '  %s drift decide ignore|documented|managed-by-project ITEM WHY\n' "$PROG"
	return 1
}

# ------------------------------------------------------------------ dispatch --

runtime_file() {
	local_client="${ASIP_SOURCE_ROOT:-$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)}/core/client.py"
	if [ -x "$local_client" ]; then
		printf '%s' "$local_client"
	else
		printf '%s' /usr/lib/asip/core/client.py
	fi
}





request() {
	if [ "$JSON" -eq 1 ]; then
		set -- --json "$@"
	fi
	if [ -n "$CHANGE_ID" ] && [ -n "$REQUEST_KEY" ]; then
		python3 "$(runtime_file)" --change-id "$CHANGE_ID" --request-key "$REQUEST_KEY" "$@"
	elif [ -n "$CHANGE_ID" ]; then
		python3 "$(runtime_file)" --change-id "$CHANGE_ID" "$@"
	elif [ -n "$STANDALONE_REASON" ] && [ -n "$REQUEST_KEY" ]; then
		python3 "$(runtime_file)" --standalone-reason "$STANDALONE_REASON" --request-key "$REQUEST_KEY" "$@"
	elif [ -n "$STANDALONE_REASON" ]; then
		python3 "$(runtime_file)" --standalone-reason "$STANDALONE_REASON" "$@"
	elif [ -n "$REQUEST_KEY" ]; then
		python3 "$(runtime_file)" --request-key "$REQUEST_KEY" "$@"
	else
		python3 "$(runtime_file)" "$@"
	fi
}

request_unscoped() {
	if [ "$JSON" -eq 1 ]; then
		set -- --json "$@"
	fi
	if [ -n "$REQUEST_KEY" ]; then
		python3 "$(runtime_file)" --request-key "$REQUEST_KEY" "$@"
	else
		python3 "$(runtime_file)" "$@"
	fi
}

request_readonly() {
	# Prefer the read socket. A process that only has `asip` (typical
	# `sg asip` shells) already holds arbitrary-root authority, so inspect
	# through the privileged socket instead of failing.
	socket=/run/asip/read.sock
	case " $(id -nG) " in
	*" asip-read "*) ;;
	*" asip "*) socket=/run/asip/sock ;;
	esac
	if [ "$JSON" -eq 1 ]; then
		python3 "$(runtime_file)" --socket "$socket" --json "$@"
	else
		python3 "$(runtime_file)" --socket "$socket" "$@"
	fi
}






cmd_do() {
	affects=''
	sensitive=0
	while [ "$#" -gt 0 ]; do
		case "$1" in
		--affects)
			[ -n "${2:-}" ] || { printf '%s: --affects needs an absolute path\n' "$PROG" >&2; return 64; }
			affects="${affects}${affects:+,}$2"
			shift 2
			;;
		--sensitive) sensitive=1; shift ;;
		--) shift; break ;;
		*) break ;;
		esac
	done
	if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
		printf 'Usage: %s do [--affects PATH] [--sensitive] -- COMMAND\n' "$PROG"
		return 0
	fi
	[ "$#" -gt 0 ] || { printf '%s: do needs a command\n' "$PROG" >&2; return 64; }
	if [ "$sensitive" -eq 1 ]; then
		request --op "do" --affects "$affects" --sensitive -- "$@"
	else
		request --op "do" --affects "$affects" -- "$@"
	fi
}

cmd_snap() {
	if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
		printf 'Usage: %s snap [--json] REASON\n' "$PROG"
		printf 'JSON includes recovery_handle; that is what asip rollback accepts.\n'
		return 0
	fi
	if [ "${1:-}" = "--json" ]; then JSON=1; shift; fi
	[ "$#" -gt 0 ] || { printf '%s: snap needs a reason\n' "$PROG" >&2; return 64; }
	request --op "snap" --reason "$*" snapshot
}

cmd_pkg() {
	action="${1:-}"
	if [ "$action" = "--help" ] || [ "$action" = "-h" ]; then
		printf 'Usage: %s pkg install|remove PACKAGE...\n' "$PROG"
		return 0
	fi
	shift || true
	case "$action" in install | remove) ;; *) printf 'Usage: %s pkg install|remove PACKAGE...\n' "$PROG" >&2; return 64 ;; esac
	[ "$#" -gt 0 ] || return 64
	request --op "pkg" --manager "$(detect_pkgmgr)" --action "$action" --reason "package $action: $*" -- "$@"
}

cmd_change() {
	if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
		printf 'Usage: %s change [list|open|show|start|finish|fail|hold|release|supersede] ...\n' "$PROG"
		printf 'show ID is the one inspect for a change.\n'
		printf 'open lists status=open work. list is history with explicit status.\n'
		printf 'brief.blocking is the cold open/held unfinished picture.\n'
		printf 'hold/release mark known work as blocked without becoming a planner.\n'
		printf 'ASIP never infers a current change from the Unix user.\n'
		return 0
	fi
	action="${1:-list}"
	case "$action" in
	start)
		shift
		if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
			printf 'Usage: %s change start [--json] INTENT\n' "$PROG"
			printf 'INTENT is the human title for the change, not a flag.\n'
			return 0
		fi
		if [ "${1:-}" = "--json" ]; then JSON=1; shift; fi
		[ "$#" -gt 0 ] || { printf 'Usage: %s change start [--json] INTENT\n' "$PROG" >&2; return 64; }
		request_unscoped --op change --action start -- "$*"
		;;
	hold)
		shift
		if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
			printf 'Usage: %s change hold ID --kind KIND --unblock TEXT [--observe SPEC]... REASON\n' "$PROG"
			printf 'KIND is reboot_window, operator, predecessor, or deferred.\n'
			printf 'SPEC is kernel, disk:/, pkg:NAME, path:/ABS, unit:NAME, unit-user:NAME, kmod:NAME.\n'
			return 0
		fi
		if [ "${1:-}" = "--json" ]; then JSON=1; shift; fi
		kind="deferred"
		unblock=""
		change=""
		reason=""
		obs_n=0
		while [ "$#" -gt 0 ]; do
			case "$1" in
			--kind)
				[ -n "${2:-}" ] || { printf '%s: --kind needs a value\n' "$PROG" >&2; return 64; }
				kind="$2"
				shift 2
				;;
			--unblock)
				[ -n "${2:-}" ] || { printf '%s: --unblock needs a condition\n' "$PROG" >&2; return 64; }
				unblock="$2"
				shift 2
				;;
			--observe)
				[ -n "${2:-}" ] || { printf '%s: --observe needs a fact spec\n' "$PROG" >&2; return 64; }
				obs_n=$((obs_n + 1))
				eval "obs_${obs_n}=\$2"
				shift 2
				;;
			--) shift
				if [ -z "$reason" ]; then reason="$*"; else reason="$reason $*"; fi
				break
				;;
			*)
				if [ -z "$change" ]; then
					change="$1"
				elif [ -z "$reason" ]; then
					reason="$1"
				else
					reason="$reason $1"
				fi
				shift
				;;
			esac
		done
		if [ -z "$change" ] || [ -z "$unblock" ] || [ -z "$reason" ]; then
			printf 'Usage: %s change hold ID --kind KIND --unblock TEXT [--observe SPEC]... REASON\n' "$PROG" >&2
			return 64
		fi
		set -- --op change --action hold --kind "$kind" --unblock "$unblock"
		obs_i=1
		while [ "$obs_i" -le "$obs_n" ]; do
			eval "set -- \"\$@\" --observe \"\$obs_${obs_i}\""
			obs_i=$((obs_i + 1))
		done
		request_unscoped "$@" -- "$change" "$reason"
		;;
	release)
		shift
		if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
			printf 'Usage: %s change release ID NOTE\n' "$PROG"
			return 0
		fi
		if [ "${1:-}" = "--json" ]; then JSON=1; shift; fi
		change="${1:-}"
		if [ "$#" -gt 0 ]; then shift; fi
		if [ -z "$change" ] || [ "$#" -eq 0 ]; then
			printf 'Usage: %s change release ID NOTE\n' "$PROG" >&2
			return 64
		fi
		request_unscoped --op change --action release -- "$change" "$*"
		;;
	finish | fail)
		shift
		if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
			printf 'Usage: %s change %s ID SUMMARY\n' "$PROG" "$action"
			return 0
		fi
		change="${1:-}"
		shift || true
		if [ -z "$change" ] || [ "$#" -eq 0 ]; then
			printf 'Usage: %s change %s ID SUMMARY\n' "$PROG" "$action" >&2
			return 64
		fi
		request_unscoped --op change --action "$action" -- "$change" "$*"
		;;
	supersede)
		shift
		old="${1:-}"; new="${2:-}"
		if [ -z "$old" ] || [ -z "$new" ]; then
			printf 'Usage: %s change supersede OLD-ID NEW-ID REASON\n' "$PROG" >&2
			return 64
		fi
		shift 2
		[ "$#" -gt 0 ] || { printf 'Usage: %s change supersede OLD-ID NEW-ID REASON\n' "$PROG" >&2; return 64; }
		request_unscoped --op change --action supersede -- "$old" "$new" "$*"
		;;
	show)
		shift
		if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
			printf 'Usage: %s change show [--json] ID\n' "$PROG"
			return 0
		fi
		json=""
		if [ "${1:-}" = "--json" ]; then json=1; shift; fi
		[ "$#" -eq 1 ] || { printf 'Usage: %s change show [--json] ID\n' "$PROG" >&2; return 64; }
		if [ -n "$json" ]; then
			request_readonly --json --op change --action show -- "$1"
		else
			request_readonly --op change --action show -- "$1"
		fi
		;;
	status)
		printf '%s: change status was removed.\n' "$PROG" >&2
		printf 'One change: asip --json change show ID\n' >&2
		printf 'Continue now: asip --json change open\n' >&2
		printf 'History: asip --json change list\n' >&2
		printf 'Open/held counts: asip --json brief\n' >&2
		printf 'Invocation bind: asip --json context\n' >&2
		return 64
		;;
	list | open)
		shift
		if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
			printf 'Usage: %s change %s [--json]\n' "$PROG" "$action"
			return 0
		fi
		json=""
		if [ "${1:-}" = "--json" ]; then json=1; shift; fi
		[ "$#" -eq 0 ] || { printf 'Usage: %s change %s [--json]\n' "$PROG" "$action" >&2; return 64; }
		if [ -n "$json" ]; then
			request_readonly --json --op change --action "$action"
		else
			request_readonly --op change --action "$action"
		fi
		;;
	*)
		printf 'Usage: %s change [list|open|show|status|start|finish|fail|hold|release|supersede] ...\n' "$PROG" >&2
		return 64
		;;
	esac
}

cmd_note() {
	[ -n "$CHANGE_ID" ] || {
		printf '%s: note requires --change ID or ASIP_CHANGE_ID\n' "$PROG" >&2
		return 64
	}
	subject="${1:-}"
	shift || true
	if [ -z "$subject" ] || [ "$#" -eq 0 ]; then
		printf 'Usage: %s --change ID note PATH WHY\n' "$PROG" >&2
		return 64
	fi
	request --op note --reason "$*" -- "$subject"
}

cmd_svc() {
    [ "$#" -ge 1 ] && [ "$#" -le 2 ] || { printf 'Usage: %s svc ACTION [UNIT]\n' "$PROG" >&2; return 64; }
    action="$1"; unit="${2:-}"
    case "$action" in
    daemon-reload|daemon-reexec) [ -z "$unit" ] || { printf '%s takes no unit\n' "$action" >&2; return 64; } ;;
    reset-failed) ;;
    *) [ -n "$unit" ] || { printf '%s needs a unit\n' "$action" >&2; return 64; } ;;
    esac
    set -- systemctl "$action"
    [ -z "$unit" ] || set -- "$@" "$unit"
    request --op svc --reason "service $action: $unit" "$@"
}

cmd_conf() {
	if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
		printf 'Usage: %s conf /absolute/path -- COMMAND\n' "$PROG"
		return 0
	fi
	target="${1:-}"
	shift || true
	[ "${1:-}" = "--" ] && shift
	if [ -z "$target" ] || [ "$#" -eq 0 ]; then
		printf 'Usage: %s conf /absolute/path -- COMMAND\n' "$PROG" >&2
		return 64
	fi
	# The target is the object being changed. If the command never names it,
	# append it so `asip conf PATH -- sed -i s/a/b/` captures PATH.
	named=0
	for arg in "$@"; do
		if [ "$arg" = "$target" ]; then
			named=1
			break
		fi
	done
	if [ "$named" -eq 0 ]; then
		set -- "$@" "$target"
	fi
	request --op "conf" --target "$target" --reason "configuration change: $target" -- "$@"
}


cmd_observe() {
	subject="${1:-}"
	shift || true
	if [ -z "$subject" ] || [ "$#" -eq 0 ]; then
		printf 'Usage: %s observe SUBJECT CHANGE\n' "$PROG" >&2
		return 64
	fi
	source="${ASIP_OBSERVE_SOURCE:-inspection}"
	evidence="${ASIP_OBSERVE_EVIDENCE:-}"
	request --op "observe" --source "$source" --evidence "$evidence" \
		--reason "$*" -- "$subject"
}

cmd_ask() {
	if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
		printf 'Usage: %s ask pose|list|show|answer|supersede ...\n' "$PROG"
		printf 'pose --gate GATE --cannot WHY [--choices a,b|--free-text] QUESTION\n'
		printf 'answer ID --choice TOKEN|--note TEXT\n'
		printf 'Answering records evidence only; it does not reboot or release holds.\n'
		printf 'Human surface: ASIP → Computer → Operator questions\n'
		return 0
	fi
	if [ "${1:-}" = "--json" ]; then JSON=1; shift; fi
	action="${1:-list}"
	case "$action" in
	list | pending)
		if [ "${2:-}" = "--json" ]; then JSON=1; fi
		request_readonly --json --op ask --action list
		;;
	show)
		shift
		if [ "${1:-}" = "--json" ]; then JSON=1; shift; fi
		[ "$#" -eq 1 ] || { printf 'Usage: %s ask show ID\n' "$PROG" >&2; return 64; }
		request_readonly --json --op ask --action show -- "$1"
		;;
	pose)
		shift
		if [ "${1:-}" = "--json" ]; then JSON=1; shift; fi
		gate=""; cannot=""; choices=""; free=0
		while [ "$#" -gt 0 ]; do
			case "$1" in
			--gate) [ -n "${2:-}" ] || return 64; gate="$2"; shift 2 ;;
			--cannot) [ -n "${2:-}" ] || return 64; cannot="$2"; shift 2 ;;
			--choices) [ -n "${2:-}" ] || return 64; choices="$2"; shift 2 ;;
			--free-text) free=1; shift ;;
			--) shift; break ;;
			*) break ;;
			esac
		done
		if [ -z "$gate" ] || [ -z "$cannot" ] || [ "$#" -eq 0 ]; then
			printf 'Usage: %s ask pose --gate GATE --cannot WHY [--choices a,b|--free-text] QUESTION\n' "$PROG" >&2
			return 64
		fi
		if [ "$free" -eq 1 ]; then
			request --op ask --action pose --gate "$gate" --cannot "$cannot" --free-text -- "$*"
		else
			[ -n "$choices" ] || { printf '%s: pose needs --choices or --free-text\n' "$PROG" >&2; return 64; }
			request --op ask --action pose --gate "$gate" --cannot "$cannot" --choices "$choices" -- "$*"
		fi
		;;
	answer)
		shift
		if [ "${1:-}" = "--json" ]; then JSON=1; shift; fi
		qid=""; choice=""; note=""
		while [ "$#" -gt 0 ]; do
			case "$1" in
			--choice) [ -n "${2:-}" ] || return 64; choice="$2"; shift 2 ;;
			--note) [ -n "${2:-}" ] || return 64; note="$2"; shift 2 ;;
			*) if [ -z "$qid" ]; then qid="$1"; shift; else break; fi ;;
			esac
		done
		if [ -z "$qid" ]; then
			printf 'Usage: %s ask answer ID --choice TOKEN|--note TEXT\n' "$PROG" >&2
			return 64
		fi
		if [ -n "$choice" ] && [ -n "$note" ]; then
			request --op ask --action answer --choice "$choice" --note "$note" -- "$qid"
		elif [ -n "$choice" ]; then
			request --op ask --action answer --choice "$choice" -- "$qid"
		elif [ -n "$note" ]; then
			request --op ask --action answer --note "$note" -- "$qid"
		else
			printf 'Usage: %s ask answer ID --choice TOKEN|--note TEXT\n' "$PROG" >&2
			return 64
		fi
		;;
	supersede)
		shift
		qid="${1:-}"; shift || true
		if [ -z "$qid" ] || [ "$#" -eq 0 ]; then
			printf 'Usage: %s ask supersede ID REASON\n' "$PROG" >&2
			return 64
		fi
		request --op ask --action supersede -- "$qid" "$*"
		;;
	*)
		printf 'Usage: %s ask pose|list|show|answer|supersede\n' "$PROG" >&2
		return 64
		;;
	esac
}

cmd_access() {
	action="${1:-list}"; shift || true
	case "$action" in
	list)
		[ "$#" -eq 0 ] || { printf 'Usage: %s access list\n' "$PROG" >&2; return 64; }
		request_readonly --json --op access --action list
		;;
	show)
		[ "$#" -eq 1 ] || { printf 'Usage: %s access show NAME\n' "$PROG" >&2; return 64; }
		request_readonly --json --op access --action show --name "$1" -- "$1"
		;;
	request)
		name="${1:-}"; label="${2:-}"; env_var="${3:-}"
		[ -n "$name" ] && [ -n "$label" ] && [ -n "$env_var" ] && [ "$#" -eq 3 ] || {
			printf 'Usage: %s access request NAME LABEL ENV_VAR\n' "$PROG" >&2; return 64;
		}
		request --response-json --op access --action request --name "$name" --label "$label" --env-var "$env_var" --reason "request external authority $name" -- "$name"
		;;
	use|start)
		name="${1:-}"; [ -n "$name" ] || { printf 'Usage: %s access %s NAME -- COMMAND\n' "$PROG" "$action" >&2; return 64; }
		shift
		[ "${1:-}" = -- ] && shift
		[ "$#" -gt 0 ] || { printf 'Usage: %s access %s NAME -- COMMAND\n' "$PROG" "$action" >&2; return 64; }
		request --op access --action "$action" --name "$name" --reason "$action with external authority $name" -- "$@"
		;;
	*)
		printf 'Usage: %s access list|show|request|use|start\n' "$PROG" >&2
		return 64
		;;
	esac
}

cmd_audit() {
	if [ "${1:-}" != pending ] || [ "$#" -ne 1 ]; then
		printf 'Usage: %s audit pending\n' "$PROG" >&2
		return 64
	fi
	request_readonly --op audit-pending
}

cmd_verify() {
	action="${1:-list}"
	if [ "$action" = "--help" ] || [ "$action" = "-h" ]; then
		printf 'Usage: %s verify list | verify pass|fail TOOL [--evidence ID,... --] NOTE\n' "$PROG"
		printf 'pass records a successful check; fail records an unsuccessful check.\n'
		return 0
	fi
	case "$action" in
	list)
		[ "$#" -le 1 ] || { printf 'Usage: %s verify\n' "$PROG" >&2; return 64; }
		request_readonly --op verify --action list
		;;
	pass | fail)
		shift
		tool="${1:-}"
		if [ "$tool" = "--help" ] || [ "$tool" = "-h" ]; then
			printf 'Usage: %s verify %s TOOL NOTE\n' "$PROG" "$action"
			printf '%s means the check result was %s.\n' "$action" "$action"
			return 0
		fi
		[ -n "$tool" ] || { printf 'Usage: %s verify pass|fail TOOL [--evidence ID,... --] NOTE\n' "$PROG" >&2; return 64; }
		shift
		references=''
		if [ "${1:-}" = "--evidence" ]; then
			references="${2:-}"
			[ -n "$references" ] || { printf '%s: --evidence needs one or more comma-separated journal IDs\n' "$PROG" >&2; return 64; }
			shift 2
			[ "${1:-}" = "--" ] && shift
		fi
		[ "$#" -gt 0 ] || { printf 'Usage: %s verify pass|fail TOOL [--evidence ID,... --] NOTE\n' "$PROG" >&2; return 64; }
		request --op verify --action "$action" --references "$references" -- "$tool" "$@"
		;;
	*)
		printf 'Usage: %s verify list | verify pass|fail TOOL [--evidence ID,... --] NOTE\n' "$PROG" >&2
		return 64
		;;
	esac
}

cmd_log() {
	[ "$#" -le 1 ] || { printf 'Usage: %s log [JOURNAL-ID]\n' "$PROG" >&2; return 64; }
	request_readonly --op log -- "$@"
}

cmd_brief() {
	if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
		printf 'Usage: %s brief [--json]\n' "$PROG"
		printf 'Deterministic agent entry. ASIP fills attention[]; empty means nothing to announce.\n'
		return 0
	fi
	if [ "${1:-}" = "--json" ]; then shift; fi
	[ "$#" -eq 0 ] || { printf 'Usage: %s brief [--json]\n' "$PROG" >&2; return 64; }
	if [ -n "$CHANGE_ID" ]; then
		request_readonly --json --change-id "$CHANGE_ID" --op brief
	else
		request_readonly --json --op brief
	fi
}

cmd_context() {
	if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
		printf 'Usage: %s context [--json] [CWD]\n' "$PROG"
		printf 'Binds cwd/project, caller authority, and the supplied change ID. Not a dump of other surfaces.\n'
		return 0
	fi
	if [ "${1:-}" = "--json" ]; then shift; fi
	[ "$#" -le 1 ] || { printf 'Usage: %s context [--json] [CWD]\n' "$PROG" >&2; return 64; }
	cwd="${1:-$(pwd)}"
	case "$cwd" in /*) ;; *) printf '%s: context CWD must be absolute\n' "$PROG" >&2; return 64 ;; esac
	# Context is JSON by design. --json is accepted to make the contract
	# explicit in scripts and keep room for a future human renderer.
	if [ -n "$CHANGE_ID" ]; then
		request_readonly --json --change-id "$CHANGE_ID" --op context --cwd "$cwd"
	else
		request_readonly --json --op context --cwd "$cwd"
	fi
}

cmd_policy() {
	if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
		printf 'Usage: %s policy [--json]\n' "$PROG"
		printf 'Complete /etc/asip/MACHINE.md. Never an excerpt.\n'
		return 0
	fi
	if [ "${1:-}" = "--json" ]; then shift; fi
	[ "$#" -eq 0 ] || { printf 'Usage: %s policy [--json]\n' "$PROG" >&2; return 64; }
	request_readonly --json --op machine-policy
}

cmd_summary() {
	if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
		printf 'Usage: %s summary [--json]\n' "$PROG"
		return 0
	fi
	if [ "${1:-}" = "--json" ]; then
		[ "$#" -eq 1 ] || { printf 'Usage: %s summary [--json]\n' "$PROG" >&2; return 64; }
	else
		[ "$#" -eq 0 ] || { printf 'Usage: %s summary [--json]\n' "$PROG" >&2; return 64; }
	fi
	request_readonly --json --op summary
}

cmd_recovery() {
	if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
		printf 'Usage: %s recovery [--json]\n' "$PROG"
		printf 'Read-only Snapper catalog plus journal snapshot IDs. Does not mutate.\n'
		return 0
	fi
	if [ "${1:-}" = "--json" ]; then
		[ "$#" -eq 1 ] || { printf 'Usage: %s recovery [--json]\n' "$PROG" >&2; return 64; }
	else
		[ "$#" -eq 0 ] || { printf 'Usage: %s recovery [--json]\n' "$PROG" >&2; return 64; }
	fi
	request_readonly --json --op recovery
}

cmd_facts() {
	if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
		printf 'Usage: %s facts [catalog|get SPEC]\n' "$PROG"
		printf 'Read-only machine facts. Held work is: asip --json change show ID.\n'
		return 0
	fi
	if [ "${1:-}" = "--json" ]; then JSON=1; shift; fi
	action="${1:-catalog}"
	case "$action" in
	catalog | list)
		[ "$#" -le 1 ] || { printf 'Usage: %s facts catalog\n' "$PROG" >&2; return 64; }
		request_readonly --json --op facts --action catalog
		;;
	get)
		shift
		[ "$#" -ge 1 ] || { printf 'Usage: %s facts get SPEC\n' "$PROG" >&2; return 64; }
		if [ "$#" -eq 2 ]; then
			request_readonly --json --op facts --action get -- "$1" "$2"
		else
			request_readonly --json --op facts --action get -- "$1"
		fi
		;;
	*)
		printf 'Usage: %s facts [catalog|get SPEC]\n' "$PROG" >&2
		return 64
		;;
	esac
}


cmd_mcp_install() {
    [ "$#" -eq 0 ] || { printf 'Usage: %s mcp install\n' "$PROG" >&2; return 64; }
    python3 "$ASIP_SOURCE_ROOT/scripts/install_user.py" mcp
}

cmd_desktop() {
    case "${1:-}" in
    install) shift; python3 "$ASIP_SOURCE_ROOT/scripts/install_user.py" desktop "$@" ;;
    '') exec "$HOME/.local/bin/asip-desktop" ;;
    *) printf 'Usage: %s desktop [install]\n' "$PROG" >&2; return 64 ;;
    esac
}

register_host_mcp_grok() {
	inspect="$HOME/.local/bin/asip-mcp-inspect"
	admin="$HOME/.local/bin/asip-mcp-admin"
	if ! command -v grok >/dev/null 2>&1; then
		return 0
	fi
	if [ ! -x "$inspect" ] || [ ! -x "$admin" ]; then
		return 0
	fi
	grok mcp add asip-inspect -- "$inspect" || return 1
	grok mcp add asip-admin -- "$admin" || return 1
}

register_host_mcp_codex() {
	inspect="$HOME/.local/bin/asip-mcp-inspect"
	admin="$HOME/.local/bin/asip-mcp-admin"
	if ! command -v codex >/dev/null 2>&1; then
		return 0
	fi
	if [ ! -x "$inspect" ] || [ ! -x "$admin" ]; then
		return 0
	fi
	if ! codex mcp get asip-inspect >/dev/null 2>&1; then
		codex mcp add asip-inspect -- "$inspect" || return 1
	fi
	if ! codex mcp get asip-admin >/dev/null 2>&1; then
		codex mcp add asip-admin -- "$admin" || return 1
	fi
}

cmd_mcp_status() {
	mcp_inspect="$(readlink -f "$HOME/.local/bin/asip-mcp-inspect" 2>/dev/null || true)"
	mcp_admin="$(readlink -f "$HOME/.local/bin/asip-mcp-admin" 2>/dev/null || true)"
	mcp_bin="$(dirname -- "$mcp_inspect")"
	mcp_venv="$(dirname -- "$mcp_bin")"
	if [ -x "$mcp_inspect" ] && [ -x "$mcp_admin" ] && \
			[ "$mcp_bin" = "$(dirname -- "$mcp_admin")" ] && \
			[ -x "$mcp_venv/bin/python" ]; then
		mcp_sdk_version="$("$mcp_venv/bin/python" -I -c 'from importlib.metadata import version; print(version("mcp"))' 2>/dev/null || printf unknown)"
		mcp_adapter_version="$("$mcp_venv/bin/python" -I -c 'from importlib.metadata import version; print(version("asip-mcp"))' 2>/dev/null || printf unknown)"
		printf 'MCP adapter: %s\nSDK version: %s\nEnvironment: %s\n' \
			"$mcp_adapter_version" "$mcp_sdk_version" "$mcp_venv"
		return 0
	fi
	printf 'MCP adapter: not installed\nRun: asip mcp install\n'
	return 1
}

cmd_mcp() {
	case "${1:-}" in
	install)
		shift
		cmd_mcp_install "$@"
		;;
	status|doctor)
		[ "$#" -eq 1 ] || { printf 'Usage: %s mcp status\n' "$PROG" >&2; return 64; }
		cmd_mcp_status
		;;
	config)
		[ "$#" -eq 2 ] || { printf 'Usage: %s mcp config inspect|admin\n' "$PROG" >&2; return 64; }
		case "$2" in
		inspect) command="$HOME/.local/bin/asip-mcp-inspect" ;;
		admin) command="$HOME/.local/bin/asip-mcp-admin" ;;
		*) printf 'Usage: %s mcp config inspect|admin\n' "$PROG" >&2; return 64 ;;
		esac
		printf '{"command":"%s","args":[],"transport":"stdio"}\n' "$command"
		;;
	*)
		printf 'Usage: %s mcp install | status | config inspect|admin\n' "$PROG" >&2
		return 64
		;;
	esac
}

cmd_rollback() {
	if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
		printf 'Usage: %s rollback RECOVERY-HANDLE\n' "$PROG"
		printf 'RECOVERY-HANDLE is journal_snapshots[].recovery_handle, not a Snapper number.\n'
		return 0
	fi
	[ "$#" -eq 1 ] || { printf 'Usage: %s rollback RECOVERY-HANDLE\n' "$PROG" >&2; return 64; }
	request --op "rollback" --reason "rollback snapshot $1" "$1"
}

cmd_project() {
	if [ "${1:-}" = discover ]; then
		[ "$#" -eq 1 ] || { printf 'Usage: %s project discover\n' "$PROG" >&2; return 64; }
		registry=/etc/asip/projects.md
		printf 'Git repositories under %s:\n' "$HOME"
		find "$HOME" \
			\( -path "$HOME/.cache" -o -path "$HOME/.local/share/Trash" -o -name node_modules \) -prune -o \
			-name .git \( -type d -o -type f \) -print 2>/dev/null |
			sed 's#/.git$##' | sort -u |
			while IFS= read -r repo; do
				if [ -r "$registry" ] && grep -qF -- "\`$repo\`" "$registry"; then
					printf '  registered    %s\n' "$repo"
				else
					printf '  unregistered  %s\n' "$repo"
				fi
			done
		return
	fi
	action="${1:-set}"
	case "$action" in
	set | update)
		shift
		name="${1:-}"; path="${2:-}"
		if [ -z "$name" ] || [ -z "$path" ]; then
			printf 'Usage: %s project set NAME /absolute/path [WHY]\n' "$PROG" >&2
			return 64
		fi
		shift 2
		reason="${*:-project registered through asip}"
		request --op project --action set --reason "$reason" -- "$name" "$path"
		;;
	remove)
		[ "$#" -eq 2 ] || { printf 'Usage: %s project remove NAME|PATH\n' "$PROG" >&2; return 64; }
		request --op project --action remove -- "$2"
		;;
	*)
		# Backward-compatible shorthand: project NAME PATH [WHY].
		name="$action"; path="${2:-}"
		[ -n "$path" ] || { printf 'Usage: %s project set NAME PATH [WHY] | remove NAME|PATH | discover\n' "$PROG" >&2; return 64; }
		shift 2
		reason="${*:-project registered through asip}"
		request --op project --action set --reason "$reason" -- "$name" "$path"
		;;
	esac
}

cmd_index() {
	registry=/etc/asip/projects.md
	[ -r "$registry" ] || { printf '%s: no projects registered\n' "$PROG" >&2; return 1; }
	if [ "$#" -eq 0 ]; then cat "$registry"; else grep -iF -- "$*" "$registry"; fi
}

cmd_bootstrap_live() {
	harness="all"
	if [ "${1:-}" = "--harness" ]; then harness="${2:-}"; fi
	md=/etc/asip/MACHINE.md
	[ -r "$md" ] || { printf '%s: %s is missing; run install.sh --system first\n' "$PROG" "$md" >&2; return 1; }
	case "$harness" in all | claude | codex | grok) ;; *)
		printf '%s: unknown harness "%s"\n' "$PROG" "$harness" >&2; return 64 ;;
	esac
	for h in claude codex grok; do
		case "$harness:$h" in
		all:* | claude:claude | codex:codex | grok:grok) ;;
		*) continue ;;
		esac
		case "$h" in claude) file="$HOME/.claude/CLAUDE.md" ;; codex) file="$HOME/.codex/AGENTS.md" ;; grok) file="$HOME/.grok/AGENTS.md" ;; esac
		mkdir -p "$(dirname "$file")"
		tmp="$(mktemp)"
		if [ -f "$file" ]; then
			awk '
				/<!-- ASIP: BEGIN -->/ { pending = ""; skip = 1; next }
				/<!-- ASIP: END -->/ { skip = 0; next }
				!skip {
					if ($0 == "") { pending = pending "\n"; next }
					printf "%s", pending
					pending = ""
					print
				}
			' "$file" >"$tmp"
		else
			: >"$tmp"
		fi
		print_agent_rule >>"$tmp"
		cat "$tmp" >"$file"
		rm -f "$tmp"
		printf '%s\n' "$file"
		if [ "$h" = codex ]; then
			register_host_mcp_codex || true
		elif [ "$h" = grok ]; then
			register_host_mcp_grok || true
		fi
	done
}

cmd_install() {
    [ "${1:-}" = --privileged ] || { printf 'Usage: %s install --privileged [--operator USER]\n' "$PROG" >&2; return 64; }
    shift
    "$ASIP_SOURCE_ROOT/scripts/install_system.sh" "$@"
}

case "${1:-help}" in
install) shift; cmd_install "$@" ;;
bootstrap) shift; cmd_bootstrap_live "$@" ;;
change) shift; cmd_change "$@" ;;
note) shift; cmd_note "$@" ;;
do) shift; cmd_do "$@" ;;
pkg) shift; cmd_pkg "$@" ;;
svc) shift; cmd_svc "$@" ;;
conf) shift; cmd_conf "$@" ;;
observe) shift; cmd_observe "$@" ;;
audit) shift; cmd_audit "$@" ;;
verify) shift; cmd_verify "$@" ;;
snap) shift; cmd_snap "$@" ;;
rollback) shift; cmd_rollback "$@" ;;
log) shift; cmd_log "$@" ;;
brief) shift; cmd_brief "$@" ;;
context) shift; cmd_context "$@" ;;
policy) shift; cmd_policy "$@" ;;
summary) shift; cmd_summary "$@" ;;
recovery) shift; cmd_recovery "$@" ;;
facts) shift; cmd_facts "$@" ;;
ask) shift; cmd_ask "$@" ;;
access) shift; cmd_access "$@" ;;
mcp) shift; cmd_mcp "$@" ;;
desktop) shift; cmd_desktop "$@" ;;
project) shift; cmd_project "$@" ;;
index) shift; cmd_index "$@" ;;
skeleton) cmd_skeleton ;;
discover) cmd_discover ;;
rule)
	shift
	cmd_rule "${1:-}"
	;;
doctor) shift; cmd_doctor "$@" ;;
drift) shift; cmd_drift "$@" ;;
version | --version | -V)
    if [ "${2:-}" = --json ] || [ "$JSON" -eq 1 ]; then
        printf '{"client_version":"%s"}
' "$VERSION"
    else printf '%s %s
' "$PROG" "$VERSION"; fi
    ;;
help | --help | -h) cmd_help ;;
*)
	printf '%s: unknown command "%s"\n\n' "$PROG" "$1" >&2
	cmd_help >&2
	exit 1
	;;
esac

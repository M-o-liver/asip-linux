#!/bin/sh
# ASIP command — preserve intent and recovery context for this machine.
#
# AI-shaped machines accumulate decisions and effects across sessions. Change
# records connect human intent to journaled work; MACHINE.md retains the durable
# facts and policy that future agents must continue to respect.
#
# Privilege is held only by asipd. Its journal is the machine's record.

set -eu

# The release launcher supplies the source root. Retain direct execution for
# development and characterization tests, including a copied standalone CLI.
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
	printf '2.0.0'
}

VERSION="$(read_version)"
PROG="${ASIP_PROG:-${0##*/}}"

if [ -z "${HOME:-}" ]; then
	HOME="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f6)"
	export HOME="${HOME:-/}"
fi

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

# systemd is assumed by 'asip install' (the daemon is socket-activated) but
# not by 'asip svc' — an operator can run asipd by other means on a machine
# with a different init, and service control should still work there.
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

detect_assistants() {
	for h in claude codex grok gemini goose qwen; do
		command -v "$h" >/dev/null 2>&1 && printf '%s\n' "$h"
	done
	true
}

find_machine_md() {
	# /etc/asip/MACHINE.md is checked ahead of the home-directory fallbacks:
	# once asipd is installed, it is the only file the daemon itself ever
	# writes to (package provenance, asip conf), so it is authoritative over
	# a stale ~/MACHINE.md left from the doc-only workflow. On a machine with
	# no privileged install, that path simply doesn't exist and the fallbacks
	# apply as before.
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

The preferred human command is asip. The optional 'a' wrapper remains
available for users of an earlier experiment and existing local scripts.

COMMANDS
  install --privileged       Install ASIP (asipd and its systemd sockets).
  upgrade --check|           Check or perform a verified ASIP self-upgrade.
          upgrade
	  uninstall --software|     Remove installed software while retaining
	           --purge          durable ASIP history; --purge also erases it.
  desktop                     Reserved; unavailable in the Core release.
  telemetry status|preview|  Manage opt-in aggregate telemetry; the local
            enable|disable|send  collector is a development-only endpoint.
            serve [OPTIONS]
  support preview|bundle    Inspect/write a privacy-bounded support diagnostic.
  eval list|show|start|bind|prompt|grade|status|export|suite|qualify
                          Run local agent-evaluation fixtures; never launches a model.
  bootstrap [--harness all]  Wire agent harnesses to /etc/asip/MACHINE.md.
  onboard [--initial]         Print machine migration or reconciliation prompt.
  change start|finish|fail    Record an intent and its outcome.
  change hold|release         Gate known work without making a planner.
  change supersede OLD NEW    Close stale intent in favour of another change.
  change list|open|show      Inspect durable intent; show ID is the one inspect.
                            Add --json for structured data.
  note PATH WHY               Attach an important userland effect to a change.
  do [OPTIONS] -- COMMAND     Run privileged work; annotate effects/capture.
  pkg install|remove PKG...  Change packages; use Snapper first if available.
  svc ACTION UNIT            Run systemctl through asipd.
  conf PATH -- COMMAND       Change a config file; before/after are saved.
  observe PATH CHANGE        Journal an external change already integrated.
  maintenance [...]          Record recurring maintenance roles; omit vs unconfigured.
                            list/history/open accept --json.
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
  asipd. Socket access is a grant of root authority, not a policy allowlist.
  /run/asip/read.sock is root:asip-read 0660. Use asip-inspect for queries;
  asip-read membership does not permit execution or journal mutation.

CHANGE ASSOCIATION
  Use --change ID or ASIP_CHANGE_ID on each related command. Association is
  explicit per process; ASIP never infers an active change from the Unix UID.
  Isolated mutations require --standalone WHY. --request-key makes retries safe.
EOF
}

# ----------------------------------------------------------------- bootstrap --

cmd_bootstrap() {
	existing="$(find_machine_md)"
	# Resolved here so step 5 prints concrete values for this machine rather
	# than a command to evaluate. These heredocs interpolate, so anything
	# meant to appear literally has to be escaped.
	gituser="$(id -un 2>/dev/null || echo user)"
	githost="$(hostname 2>/dev/null || echo localhost)"

	cat <<EOF
ASIP SETUP
==========

Six steps. Takes about ten minutes, most of it reading command output.

EOF

	if [ -n "$existing" ]; then
		cat <<EOF
This machine already has a description at:
  $existing
Keep it. Read it, then start at step 2 and check the reference is in place.
Run '$PROG doctor' to see which sections it is missing.

EOF
	fi

	cat <<EOF
1. CREATE THE FILE

       $PROG skeleton > ~/MACHINE.md

   Nine empty sections, each with a note on what belongs in it. If the file
   already exists, keep it and skip to step 2.

2. POINT YOUR TOOLS AT IT

   A description helps only if something reads it. Tools that load a Markdown
   file at startup need a line telling them where this one is:

       $PROG rule <tool>

   prints the block to append to that tool's config file. '$PROG rule' with
   no argument lists the tools it knows and where their config lives.

   Expect a permission prompt on this one. Some tools treat their own
   config as protected and will ask before it is written, whatever rules
   are already in place — that guard is there so nothing rewrites its own
   instructions unnoticed, and it is working as intended.
EOF

	found="$(detect_assistants)"
	if [ -n "$found" ]; then
		printf '\n   Found on this machine:\n'
		printf '%s\n' "$found" | sed 's/^/       /'
		printf '   Do each of them.\n'
	fi

	cat <<EOF

3. LOOK AT THE MACHINE

       $PROG discover

   prints read-only commands suited to this machine — its package manager,
   filesystem, snapshot tool, desktop. Run them and read the output.

4. WRITE DOWN WHAT YOU FOUND

   Fill in the sections from that output. What makes this file worth having:

   - Record what cannot be worked out later. A package list can be
     regenerated any time; the reason something was installed cannot.
   - Say which facts are load-bearing. "Hybrid graphics" is trivia. "The
     integrated GPU drives the display and switching has corrupted it
     before" changes what happens next.
   - Mark volatile, high-impact observations with an inline freshness cue:

       <!-- asip:fact observed-at=2026-03-14 max-age-days=90 checked-by="command" -->

     'doctor' warns after max-age-days; omit that field for manually reviewed
     facts that have no useful automatic expiry.
   - Absolute dates: 2026-03-14, not "last week".
   - Leave the Decision Log empty for now. It records things learned the
     hard way, and a new machine has not yet taught anyone anything. It
     fills over months, one incident at a time.

5. PUT IT UNDER VERSION CONTROL

   The history is half the value — when a decision was taken, and what it
   replaced. Version the machine's own configuration deliberately, and start
   the repository ignoring everything so nothing sweeps up credentials:

       git init
       printf '*\n!MACHINE.md\n!.gitignore\n' > ~/.gitignore
       git add MACHINE.md .gitignore
       git commit -m "Add MACHINE.md"

   A freshly installed machine often has no git identity at all, which stops
   that commit. Set one for this repository only — never --global, which
   would change how every other repository here behaves:

       git config user.name "$gituser"
       git config user.email "$gituser@$githost"

   Widen the ignore file later, when there is something specific to track.

6. CHECK IT

       $PROG doctor

   reports which sections are filled and what references the file.

KEEPING IT CURRENT
   The file describes how this machine is set up, so changes made here can
   make it wrong. After installing something that carries its own
   configuration, adding a repository, changing a shell, or altering a
   service, correct the section covering that ground at the same time. A
   description that is quietly out of date is worse than none, because it
   gets believed.
EOF
}

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
Treat returned `attention` as authoritative; do not reclassify holds or live
observations as alerts.

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
chat or logs. `access_start` is for a long-lived process; `access_use` is finite
and synchronous.

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

release_file() {
	local_release="${ASIP_SOURCE_ROOT:-$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)}/cli/release.py"
	if [ -r "$local_release" ]; then
		printf '%s' "$local_release"
	else
		printf '%s' /usr/lib/asip/cli/release.py
	fi
}

telemetry_file() {
	local_telemetry="${ASIP_SOURCE_ROOT:-$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)}/cli/telemetry.py"
	if [ -r "$local_telemetry" ]; then
		printf '%s' "$local_telemetry"
	else
		printf '%s' /usr/lib/asip/cli/telemetry.py
	fi
}

telemetry_server_file() {
	local_server="${ASIP_SOURCE_ROOT:-$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)}/cli/telemetry_server.py"
	if [ -r "$local_server" ]; then
		printf '%s' "$local_server"
	else
		printf '%s' /usr/lib/asip/cli/telemetry_server.py
	fi
}

support_file() {
	local_support="${ASIP_SOURCE_ROOT:-$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)}/cli/support.py"
	if [ -r "$local_support" ]; then
		printf '%s' "$local_support"
	else
		printf '%s' /usr/lib/asip/cli/support.py
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

release_field() {
	key="$1"
	printf '%s\n' "$release_status" | awk -F= -v wanted="$key" '$1 == wanted { print substr($0, length($1) + 2); exit }'
}

cmd_upgrade() {
	check_only=0
	if [ "${1:-}" = "--check" ]; then
		check_only=1
		shift
	fi
	[ "$#" -eq 0 ] || {
		printf 'Usage: %s upgrade [--check]\n' "$PROG" >&2
		return 64
	}
	release_status="$(python3 "$(release_file)" check)"
	installed="$(release_field installed_version)"
	installed_source="$(release_field installed_source)"
	client_version="$(release_field client_version)"
	latest="$(release_field latest_version)"
	candidate="$(release_field candidate_version)"
	available="$(release_field available)"
	metadata="$(release_field metadata)"
	mismatch="$(release_field mismatch)"
	[ -n "$client_version" ] || client_version="$VERSION"
	[ -n "$latest" ] || latest="${candidate:-unavailable}"
	[ -n "$installed_source" ] || installed_source="unavailable"
	printf 'Client/source version: %s\n' "$client_version"
	if [ -n "$installed" ]; then
		printf 'Installed product: %s (%s)\n' "$installed" "$installed_source"
		printf 'Installed ASIP version: %s\n' "$installed"
	else
		printf 'Installed product: unavailable (%s)\n' "$installed_source"
			printf 'Installed ASIP version: unavailable\n'
	fi
	printf 'Candidate: %s\n' "${candidate:-none}"
	printf 'Latest known release: %s\n' "$latest"
	if [ -n "$mismatch" ]; then
		printf 'Version mismatch: %s\n' "$mismatch"
	fi
	if [ "$metadata" = available ]; then
		if [ -z "$installed" ]; then
			printf 'Upgrade eligibility: unknown (live installed version unavailable)\n'
		elif [ "$available" = true ]; then
			printf 'Upgrade available: %s -> %s\n' "$installed" "$latest"
		else
			printf 'ASIP is current; no upgrade is available.\n'
		fi
	else
		printf 'Release metadata: unavailable (local execution remains independent of a release server).\n'
		printf '  %s\n' "$(release_field message)"
	fi
	[ "$check_only" -eq 1 ] && return 0
	if [ -z "$installed" ]; then
		printf '%s: live installed version is unavailable; will not treat this checkout as installed\n' "$PROG" >&2
		return 1
	fi
	if [ "$metadata" != available ] || [ "$available" != true ]; then
		printf '%s: no verified newer release is available\n' "$PROG" >&2
		return 1
	fi

	if ! request_readonly --op doctor >/dev/null; then
		printf '%s: preflight health check failed. Inspection needs the asip-read group or an asip-group process token. Start a fresh login or harness from a host context that preserves the required group; do not use sg inside a confined runner.\n' "$PROG" >&2
		return 1
	fi
	change="$(cmd_change start "Upgrade ASIP from $installed to $latest")"
	stage=''
	install_root=''
	if ! stage_status="$(python3 "$(release_file)" prepare --json)"; then
		cmd_change fail "$change" "Release artifact preparation or integrity validation failed"
		return 1
	fi
	stage="$(printf '%s\n' "$stage_status" | python3 -c 'import json,sys; print(json.load(sys.stdin)["stage"])')"
	install_root="$(printf '%s\n' "$stage_status" | python3 -c 'import json,sys; print(json.load(sys.stdin)["root"])')"
	cleanup_stage() {
		[ -n "$stage" ] && [ -d "$stage" ] && rm -rf -- "$stage"
	}
	# Do not use an EXIT trap here. POSIX shells may run it in command-
	# substitution subshells such as $(runtime_file), deleting the artifact
	# before the privileged request can consume it.
	trap cleanup_stage 1 2 3 15

	CHANGE_ID="$change"
	STANDALONE_REASON=''
	if ! cmd_snap "Before upgrading ASIP from $installed to $latest"; then
		CHANGE_ID=''
		cleanup_stage
		cmd_change fail "$change" "Recovery snapshot preflight failed"
		return 1
	fi
	if ! cmd_do -- env ASIP_OPERATOR="$(id -un)" "$install_root/asip" install --privileged --self-upgrade; then
		CHANGE_ID=''
		cleanup_stage
		cmd_change fail "$change" "Verified release installation failed; existing ASIP state was retained where possible"
		return 1
	fi

	reconnected=0
	stable_checks=0
	attempt=0
	# Do not poll either ASIP socket while the deferred systemd restart is due.
	# The privileged daemon serializes requests; a stream of summary calls can
	# keep its socket-activated service busy and postpone the very restart we are
	# waiting to verify. Leave the journal-safe handoff window completely quiet.
	sleep 15
	# systemd may defer a socket-activated service restart until the old daemon
	# has drained its final journal response. Allow a full minute rather than
	# classifying that safe transition as an upgrade failure.
	while [ "$attempt" -lt 60 ]; do
		# The old daemons remain healthy until the deferred timer fires. Require
		# both socket roles to report the target version and pass doctor twice;
		# this avoids accepting the read service while the privileged service is
		# still inside the same systemd restart transaction.
		if request_readonly --op summary 2>/dev/null | \
				python3 -c 'import json,sys; assert json.load(sys.stdin)["version"] == sys.argv[1]' "$latest" 2>/dev/null && \
				request_unscoped --op summary 2>/dev/null | \
				python3 -c 'import json,sys; assert json.load(sys.stdin)["version"] == sys.argv[1]' "$latest" 2>/dev/null && \
				request_readonly --op doctor >/dev/null 2>&1 && \
				request_unscoped --op doctor >/dev/null 2>&1; then
			stable_checks=$((stable_checks + 1))
			if [ "$stable_checks" -ge 2 ]; then
				reconnected=1
				break
			fi
		else
			stable_checks=0
		fi
		attempt=$((attempt + 1))
		sleep 1
	done
	if [ "$reconnected" -ne 1 ]; then
		CHANGE_ID=''
		cleanup_stage
		cmd_change fail "$change" "ASIP services did not report target version $latest after the deferred restart"
		return 1
	fi
	CHANGE_ID="$change"
	if ! cmd_verify pass upgrade "ASIP services reconnected and the read-only doctor check passed after upgrade"; then
		CHANGE_ID=''
		cleanup_stage
		cmd_change fail "$change" "Post-upgrade verification could not be recorded"
		return 1
	fi
	CHANGE_ID=''
	if ! cmd_change finish "$change" "Upgraded ASIP from $installed to $latest and verified the daemon transition"; then
		cleanup_stage
		return 1
	fi
	trap - 1 2 3 15
	cleanup_stage
}

cmd_uninstall() {
	mode="${1:-}"
	case "$mode" in
	--software|--purge) ;;
	--help|-h)
		printf 'Usage: %s uninstall --software | --purge\n' "$PROG"
		printf 'Software removal retains /etc/asip and /var/lib/asip.\n'
		printf 'Removal starts after a short delay so the current ASIP request can finish.\n'
		printf 'Use --purge only when intentionally erasing ASIP Core durable state.\n'
		return 0
		;;
	*)
		printf 'Usage: %s uninstall --software | --purge\n' "$PROG" >&2
		return 64
		;;
	esac
	[ "$(id -u)" -eq 0 ] || {
		printf '%s: uninstall must run as root through the existing trusted root path\n' "$PROG" >&2
		return 1
	}
	if [ "$mode" = --purge ]; then
		printf 'This schedules ASIP software removal and permanently erases /etc/asip and /var/lib/asip.\n'
	else
		printf 'This schedules ASIP Core software removal; durable journal, policy, and evidence will be retained.\n'
	fi
	[ -x /usr/local/sbin/asip-uninstall ] || {
		printf '%s: the installed software-removal helper is missing; reinstall ASIP before retrying\n' "$PROG" >&2
		return 1
	}
	unit="asip-uninstall-$(date -u +%Y%m%d%H%M%S)-$$"
	systemd-run --quiet --unit="$unit" --on-active=10s --collect -- \
		/usr/local/sbin/asip-uninstall "$mode" || {
		printf '%s: could not schedule deferred software removal; ASIP was left installed\n' "$PROG" >&2
		return 1
	}
	printf 'ASIP removal is scheduled in a separate systemd job for 10 seconds from now.\n'
	printf 'The active request can finish its journal record before the sockets and daemon stop.\n'
}

cmd_telemetry() {
	action="${1:-}"
	[ -n "$action" ] || {
		printf 'Usage: %s telemetry status|preview|enable|disable|send | serve [--port PORT]\n' "$PROG" >&2
		return 64
	}
	shift
	case "$action" in
	status|preview|enable|disable|send)
		[ "$#" -eq 0 ] || { printf 'Usage: %s telemetry %s\n' "$PROG" "$action" >&2; return 64; }
		python3 "$(telemetry_file)" "$action"
		;;
	serve|server)
		python3 "$(telemetry_server_file)" "$@"
		;;
	*)
		printf 'Usage: %s telemetry status|preview|enable|disable|send | serve [--port PORT]\n' "$PROG" >&2
		return 64
		;;
	esac
}

cmd_support() {
	python3 "$(support_file)" "$@"
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
	action="${1:-}"; unit="${2:-}"
	if [ -z "$action" ] || [ -z "$unit" ]; then
		printf 'Usage: %s svc ACTION UNIT\n' "$PROG" >&2
		return 64
	fi
	case "$(detect_initsys)" in
	systemd) set -- systemctl "$action" "$unit" ;;
	openrc) set -- rc-service "$unit" "$action" ;;
	sysv) set -- service "$unit" "$action" ;;
	*) printf '%s: no known init system (systemd, OpenRC, or sysvinit) found\n' "$PROG" >&2; return 1 ;;
	esac
	request --op "svc" --reason "service $action: $unit" "$@"
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

cmd_eval() {
	local_eval="${ASIP_SOURCE_ROOT:-$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)}/cli/eval.py"
	if [ ! -r "$local_eval" ]; then local_eval=/usr/lib/asip/cli/eval.py; fi
	[ -r "$local_eval" ] || { printf '%s: eval helper is not installed\n' "$PROG" >&2; return 69; }
	exec python3 "$local_eval" "$@"
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

cmd_onboard() {
	force_initial=0
	case "${1:-}" in
	'') ;;
	--initial) force_initial=1 ;;
	*) printf 'Usage: %s onboard [--initial]\n' "$PROG" >&2; return 64 ;;
	esac
	journal=/var/lib/asip/journal.jsonl
	if [ "$force_initial" -eq 0 ] && [ -r "$journal" ] &&
		grep -q '"op":"observe".*"subject":"asip:onboarding".*"evidence":"onboarding:v1"' "$journal"; then
		cat <<'EOF'
ASIP ONBOARDING REVIEW

Initial onboarding is recorded as complete. Read /etc/asip/MACHINE.md,
/etc/asip/projects.md, and the ASIP journal. Inspect current agent
configuration and the live system for durable information added since
onboarding. Integrate new machine-wide facts and operator preferences into
MACHINE.md through a change session, note important userland paths, and use
`asip observe` for relevant external changes. Preserve project-specific rules
in their projects and durable operating policy in MACHINE.md's Decision Log.
EOF
		return
	fi
	cat <<'EOF'
ASIP INITIAL ONBOARDING

Complete the initial migration of this machine into ASIP.

0. Confirm that this session exposes the native `asip-inspect` and
   `asip-admin` MCP servers. If either is missing, report an ASIP integration
   condition and stop onboarding until the operator repairs registration and
   relaunches the agent. Never wrap MCP in `sg` or substitute shell access.
   The Unix socket groups remain the authority; MCP adds no new privilege.
1. Relaunch the agent after registration. Call `asip_brief`, confirm the
   inspect/admin separation, and verify that the native tools include
   `asip_do`, `access_list`, `access_request`, `access_use`, and `access_start`.
   Use `access_use` only for finite commands and `access_start` for long-lived
   userland servers.
2. Call `change_start` with `Initial ASIP machine onboarding`. Carry the
   returned change ID on every following ASIP mutation.
3. Read /etc/asip/MACHINE.md and inspect existing machine notes, dotfiles,
   global agent instructions, hooks, privilege helpers, snapshot guards, and
   recovery documentation.
4. Move unique and current machine-wide facts into /etc/asip/MACHINE.md.
   Include operator preferences such as response tone and desired detail.
   If a separate knowledge base exists (Obsidian vault, wiki, notes repo),
   ask what it is for relative to this file, and whether sessions with
   lasting technical value should be offered into it proactively. If the
   operator uses Git hosting for collaboration, ask about default repo
   visibility and push/PR habits. Use `configuration_apply` for changes to the
   canonical file.
5. Identify privilege, snapshot, and agent-safety mechanisms that predate
   ASIP. Remove or update mechanisms superseded by ASIP. Preserve unrelated
   permissions, preferences, configuration management, and project rules.
6. Find meaningful Git repositories and other durable projects. Register each
   with `project_update`. Keep project-specific instructions in the project.
7. Confirm that each installed agent harness reads /etc/asip/MACHINE.md.
8. Review the resulting files and ASIP journal for omissions and conflicts.
9. Call `observation_record` for `asip:onboarding` with source `onboarding`,
   evidence `onboarding:v1`, and a concise completion description.
10. Call `verification_record`, then `change_close` with status `finish` and a
    concise migration outcome.

Use live system state when existing documentation is stale. Do not replace
project-local knowledge with machine-wide policy.
EOF
}

print_install_handoff() {
	printf '\nNEXT: OPEN CODEX OR CLAUDE CODE\n'
	printf 'Copy and paste the entire block below into the signed-in agent.\n\n'
	printf '%s\n' '----- BEGIN ASIP INSTALL HANDOFF -----'
	cmd_onboard
	printf '%s\n' '----- END ASIP INSTALL HANDOFF -----'
}

cmd_maintenance() {
	if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
		printf 'Usage: %s maintenance [list|history|open|policy|backfill|omit|unomit|start|finish|fail] ...\n' "$PROG"
		printf 'list [--json]   due/overdue/unconfigured/omitted obligation state\n'
		printf 'history|open [--json]\n'
		printf 'policy TASK DAYS\n'
		printf 'backfill TASK ISO-DATE NOTE\n'
		printf 'omit TASK REASON   durable not-applicable decision\n'
		printf 'unomit TASK        clear an omit decision\n'
		printf 'start TASK... ; finish SESSION [--covered TASK,...] SUMMARY\n'
		printf '%s\n' '--covered is the completion set. Without it, finish completes every started role.'
		return 0
	fi
	if [ "${1:-}" = "--json" ]; then
		request_readonly --json --op maintenance --action list
		return
	fi
	action="${1:-list}"
	case "$action" in
	list | "")
		if [ "$#" -gt 0 ]; then
			shift
		fi
		if [ "${1:-}" = "--json" ]; then
			request_readonly --json --op maintenance --action list
			return
		fi
		[ "$#" -eq 0 ] || { printf 'Usage: %s maintenance [--json]\n' "$PROG" >&2; return 64; }
		request_readonly --op maintenance --action list
		;;
	history | open)
		if [ "${2:-}" = "--json" ]; then
			[ "$#" -eq 2 ] || { printf 'Usage: %s maintenance %s [--json]\n' "$PROG" "$action" >&2; return 64; }
			request_readonly --json --op maintenance --action "$action"
			return
		fi
		[ "$#" -eq 1 ] || { printf 'Usage: %s maintenance %s [--json]\n' "$PROG" "$action" >&2; return 64; }
		request_readonly --op maintenance --action "$action"
		;;
	start)
		shift
		[ "$#" -gt 0 ] || { printf 'Usage: %s maintenance start TASK...\n' "$PROG" >&2; return 64; }
		request --op maintenance --action start -- "$@"
		;;
	policy)
		[ "$#" -eq 3 ] || { printf 'Usage: %s maintenance policy TASK DAYS\n' "$PROG" >&2; return 64; }
		request --op maintenance --action policy -- "$2" "$3"
		;;
	omit)
		shift
		task="${1:-}"
		if [ -z "$task" ] || [ "$#" -lt 2 ]; then
			printf 'Usage: %s maintenance omit TASK REASON\n' "$PROG" >&2
			return 64
		fi
		shift
		request --op maintenance --action omit -- "$task" "$*"
		;;
	unomit)
		[ "$#" -eq 2 ] || { printf 'Usage: %s maintenance unomit TASK\n' "$PROG" >&2; return 64; }
		request --op maintenance --action unomit -- "$2"
		;;
	backfill)
		shift
		task="${1:-}"; observed="${2:-}"
		if [ -z "$task" ] || [ -z "$observed" ]; then
			printf 'Usage: %s maintenance backfill TASK ISO-DATE NOTE\n' "$PROG" >&2
			return 64
		fi
		shift 2
		[ "$#" -gt 0 ] || { printf 'Usage: %s maintenance backfill TASK ISO-DATE NOTE\n' "$PROG" >&2; return 64; }
		request --op maintenance --action backfill -- "$task" "$observed" "$*"
		;;
	finish)
		shift
		session="${1:-}"
		if [ "$#" -gt 0 ]; then
			shift
		fi
		covered=""
		if [ "${1:-}" = "--covered" ]; then
			covered="${2:-}"
			[ -n "$covered" ] || { printf '%s: --covered needs a comma-separated task list\n' "$PROG" >&2; return 64; }
			shift 2
		fi
		if [ -z "$session" ] || [ "$#" -eq 0 ]; then
			printf 'Usage: %s maintenance finish SESSION [--covered TASK,...] SUMMARY\n' "$PROG" >&2
			return 64
		fi
		request --op maintenance --action finish --covered "$covered" -- "$session" "$*"
		;;
	fail)
		shift
		session="${1:-}"
		if [ "$#" -gt 0 ]; then
			shift
		fi
		if [ -z "$session" ] || [ "$#" -eq 0 ]; then
			printf 'Usage: %s maintenance fail SESSION REASON\n' "$PROG" >&2
			return 64
		fi
		request --op maintenance --action fail -- "$session" "$*"
		;;
	*)
		printf 'Usage: %s maintenance [history|open|policy|backfill|omit|unomit|start|finish|fail] ...\n' "$PROG" >&2
		return 64
		;;
	esac
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
	[ "$(id -u)" -ne 0 ] || {
		printf '%s: install the MCP adapter as the operator, not root\n' "$PROG" >&2
		return 77
	}
	[ "$#" -le 1 ] || {
		printf 'Usage: %s mcp install [SOURCE-DIRECTORY]\n' "$PROG" >&2
		return 64
	}
	mcp_source="${1:-${ASIP_SOURCE_ROOT:-$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)}}"
	mcp_source="$(CDPATH='' cd -- "$mcp_source" 2>/dev/null && pwd)" || {
		printf '%s: MCP source directory is unavailable: %s\n' "$PROG" "$mcp_source" >&2
		return 1
	}
	if [ ! -r "$mcp_source/pyproject.toml" ] && [ -r /usr/share/asip/mcp-source/pyproject.toml ]; then
		mcp_source=/usr/share/asip/mcp-source
	fi
	for mcp_file in pyproject.toml asip_mcp.py VERSION; do
		[ -r "$mcp_source/$mcp_file" ] || {
			printf '%s: MCP source is incomplete; missing %s\n' "$PROG" "$mcp_file" >&2
			return 1
		}
	done
	[ -r "$mcp_source/core/protocol.py" ] || {
		printf '%s: MCP source is incomplete; missing core/protocol.py\n' "$PROG" >&2
		return 1
	}
	mcp_stage="$(mktemp -d "${TMPDIR:-/tmp}/asip-mcp-install.XXXXXX")" || {
		printf '%s: could not create MCP installation staging directory\n' "$PROG" >&2
		return 1
	}
	mcp_candidate=''
	mcp_install_lock=''
	cleanup_mcp_stage() {
		rm -rf -- "$mcp_stage"
		[ -z "$mcp_candidate" ] || rm -rf -- "$mcp_candidate"
		[ -z "$mcp_install_lock" ] || rmdir -- "$mcp_install_lock" 2>/dev/null || true
	}
	trap cleanup_mcp_stage 0 1 2 3 15
	cp "$mcp_source/pyproject.toml" "$mcp_source/asip_mcp.py" \
		"$mcp_source/VERSION" "$mcp_stage/"
	cp -R "$mcp_source/core" "$mcp_stage/core"

	mcp_data_home="${XDG_DATA_HOME:-$HOME/.local/share}/asip"
	mcp_envs="$mcp_data_home/mcp-envs"
	mcp_python_tag="$(python3 -c 'import sys; print("%d%d" % sys.version_info[:2])')"
	mcp_arch="$(uname -m)"
	mcp_lock="$mcp_source/requirements/mcp-py${mcp_python_tag}-linux-x86_64.lock"
	mcp_wheels="$mcp_source/wheelhouse/py${mcp_python_tag}-linux-x86_64"
	mcp_common="$mcp_source/wheelhouse/common"
	mcp_install_mode=package-index
	mcp_bundle_present=0
	if [ -d "$mcp_source/wheelhouse" ]; then mcp_bundle_present=1; fi
	if [ -r "$mcp_lock" ] && [ -d "$mcp_wheels" ] && \
			[ -d "$mcp_common" ] && [ -r "$mcp_source/wheelhouse/SHA256SUMS" ]; then
		[ "$mcp_arch" = x86_64 ] || {
			printf '%s: bundled MCP wheelhouse does not support architecture %s\n' "$PROG" "$mcp_arch" >&2
			return 1
		}
		mcp_install_mode=wheelhouse
	fi
	if [ "$mcp_bundle_present" -eq 1 ] && [ "$mcp_install_mode" != wheelhouse ]; then
		printf '%s: bundled MCP wheelhouse does not support Python %s on %s, or is incomplete\n' \
			"$PROG" "$mcp_python_tag" "$mcp_arch" >&2
		return 1
	fi
	mcp_fingerprint="$({
		sha256sum "$mcp_source/pyproject.toml" "$mcp_source/asip_mcp.py" \
			"$mcp_source/core/protocol.py" "$mcp_source/VERSION"
		printf 'python=%s\nmode=%s\n' "$mcp_python_tag" "$mcp_install_mode"
		[ "$mcp_install_mode" = package-index ] || \
			sha256sum "$mcp_lock" "$mcp_source/wheelhouse/SHA256SUMS"
	} | sha256sum | cut -c1-20)"
	mcp_venv="$mcp_envs/$mcp_fingerprint"
	mcp_adapter_version="$(sed -n '1{s/[[:space:]]*$//;p;q;}' "$mcp_source/VERSION")"
	mkdir -p "$mcp_envs" "$HOME/.local/bin"
	mcp_environment_valid() {
		[ -x "$mcp_venv/bin/asip-mcp-inspect" ] && \
			[ -x "$mcp_venv/bin/asip-mcp-admin" ] && \
			[ "$(sed -n '1p' "$mcp_venv/bin/asip-mcp-inspect")" = "#!$mcp_venv/bin/python" ] && \
			[ "$(sed -n '1p' "$mcp_venv/bin/asip-mcp-admin")" = "#!$mcp_venv/bin/python" ] && \
			env -u PYTHONPATH "$mcp_venv/bin/python" -c \
			'import sys, asip_mcp, mcp; from core.protocol import VERSION; from importlib.metadata import version; assert version("mcp") == "2.0.0"; assert VERSION == sys.argv[1] == version("asip-mcp")' \
			"$mcp_adapter_version" \
			>/dev/null 2>&1
	}
	if ! mcp_environment_valid; then
		mcp_install_lock="$mcp_envs/.install-$mcp_fingerprint.lock"
		mcp_lock_attempt=0
		while ! mkdir -- "$mcp_install_lock" 2>/dev/null; do
			if mcp_environment_valid; then
				mcp_install_lock=''
				break
			fi
			mcp_lock_attempt=$((mcp_lock_attempt + 1))
			if [ "$mcp_lock_attempt" -ge 30 ]; then
				printf '%s: another MCP installation did not finish within 30 seconds\n' "$PROG" >&2
				return 1
			fi
			sleep 1
		done
	fi
	if ! mcp_environment_valid; then
		mcp_candidate="$mcp_envs/.build-$mcp_fingerprint-$$"
		if ! python3 -m venv "$mcp_candidate"; then
			printf '%s: could not create the isolated MCP environment; install the distribution python3-venv package and retry\n' "$PROG" >&2
			return 1
		fi
		if [ "$mcp_install_mode" = wheelhouse ]; then
			if ! (cd "$mcp_source/wheelhouse" && sha256sum -c SHA256SUMS >/dev/null); then
				printf '%s: bundled MCP wheelhouse failed its SHA-256 manifest\n' "$PROG" >&2
				return 1
			fi
			if ! "$mcp_candidate/bin/python" -m pip install --disable-pip-version-check \
					--no-input --quiet --no-index --find-links "$mcp_wheels" \
					--require-hashes --requirement "$mcp_lock"; then
				printf '%s: offline MCP dependency installation failed; the release wheelhouse may not match this Python/platform\n' "$PROG" >&2
				return 1
			fi
			set -- "$mcp_common"/asip_mcp-*.whl
			if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
				printf '%s: bundled wheelhouse must contain exactly one ASIP adapter wheel\n' "$PROG" >&2
				return 1
			fi
			if ! "$mcp_candidate/bin/python" -m pip install --disable-pip-version-check \
					--no-input --quiet --no-index --no-deps "$1"; then
				printf '%s: bundled ASIP MCP adapter wheel installation failed\n' "$PROG" >&2
				return 1
			fi
		else
			if ! "$mcp_candidate/bin/python" -m pip install --disable-pip-version-check \
					--no-input --quiet --upgrade 'mcp==2.0.0'; then
				printf '%s: pinned MCP SDK installation failed; check network/package-index access or use a release with a bundled wheelhouse\n' "$PROG" >&2
				return 1
			fi
			if ! "$mcp_candidate/bin/python" -m pip install --disable-pip-version-check \
					--no-input --quiet --force-reinstall --no-deps "$mcp_stage"; then
		printf '%s: ASIP MCP adapter installation failed; retry "asip mcp install"\n' "$PROG" >&2
				return 1
			fi
		fi
		if ! env -u PYTHONPATH "$mcp_candidate/bin/python" -c \
			'import sys, asip_mcp, mcp; from core.protocol import VERSION; from importlib.metadata import version; assert version("mcp") == "2.0.0"; assert VERSION == sys.argv[1] == version("asip-mcp")' \
			"$mcp_adapter_version"; then
			printf '%s: staged MCP environment failed import/version validation\n' "$PROG" >&2
			return 1
		fi
		printf '%s\n' "$mcp_install_mode" >"$mcp_candidate/ASIP_INSTALL_SOURCE"
		# Python entry points contain an absolute interpreter path. Rebase the two
		# user-facing launchers before publishing the renamed environment.
		for mcp_launcher in "$mcp_candidate/bin/asip-mcp-inspect" \
				"$mcp_candidate/bin/asip-mcp-admin"; do
			mcp_shebang="$(sed -n '1p' "$mcp_launcher")"
			[ "$mcp_shebang" = "#!$mcp_candidate/bin/python" ] || {
				printf '%s: staged MCP launcher has an unexpected interpreter path\n' "$PROG" >&2
				return 1
			}
			sed -i "1c\\#!$mcp_venv/bin/python" "$mcp_launcher"
		done
		if [ -e "$mcp_venv" ]; then rm -rf -- "$mcp_venv"; fi
		if ! mv -T -- "$mcp_candidate" "$mcp_venv"; then
			printf '%s: could not publish the validated MCP environment\n' "$PROG" >&2
			return 1
		fi
		mcp_candidate=''
		if ! mcp_environment_valid; then
			rm -rf -- "$mcp_venv"
			printf '%s: published MCP entry points failed final validation; existing user entry points were not changed\n' "$PROG" >&2
			return 1
		fi
		rmdir -- "$mcp_install_lock"
		mcp_install_lock=''
	fi
	ln -sfn "$mcp_venv/bin/asip-mcp-inspect" "$HOME/.local/bin/asip-mcp-inspect"
	ln -sfn "$mcp_venv/bin/asip-mcp-admin" "$HOME/.local/bin/asip-mcp-admin"
	mcp_sdk_version="$("$mcp_venv/bin/python" -c 'from importlib.metadata import version; print(version("mcp"))')" || {
		printf '%s: MCP SDK could not be imported after installation\n' "$PROG" >&2
		return 1
	}
	trap - 0 1 2 3 15
	cleanup_mcp_stage
	printf 'ASIP MCP adapter installed for %s (SDK %s, %s, isolated at %s).\n' \
		"$(id -un)" "$mcp_sdk_version" "$mcp_install_mode" "$mcp_venv"
}

cmd_desktop() {
	if [ "${1:-}" = --help ] || [ "${1:-}" = -h ]; then
		printf 'The native ASIP Desktop is not included in the Core release.\n'
		return 0
	fi
	printf '%s: the native ASIP Desktop is not included in this Core release\n' "$PROG" >&2
	return 69
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
		mcp_sdk_version="$("$mcp_venv/bin/python" -c 'from importlib.metadata import version; print(version("mcp"))' 2>/dev/null || printf unknown)"
		mcp_install_mode="$(sed -n '1p' "$mcp_venv/ASIP_INSTALL_SOURCE" 2>/dev/null || printf legacy)"
		printf 'MCP adapter: installed\nSDK version: %s\nInstall source: %s\nEnvironment: %s\n' \
			"$mcp_sdk_version" "$mcp_install_mode" "$mcp_venv"
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
		printf 'Usage: %s mcp install [SOURCE] | status | config inspect|admin\n' "$PROG" >&2
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
	[ -r "$md" ] || { printf '%s: %s is missing; run install --privileged first\n' "$PROG" "$md" >&2; return 1; }
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
	[ "${1:-}" = "--privileged" ] || { printf 'Usage: %s install --privileged [--self-upgrade] (run via your existing root escalation for first install)\n' "$PROG" >&2; return 64; }
	self_upgrade=0
	case "${2:-}" in
	'') ;;
	--self-upgrade) self_upgrade=1 ;;
	*) printf 'Usage: %s install --privileged [--self-upgrade] (run via your existing root escalation for first install)\n' "$PROG" >&2; return 64 ;;
	esac
	[ "$#" -le 2 ] || { printf 'Usage: %s install --privileged [--self-upgrade] (run via your existing root escalation for first install)\n' "$PROG" >&2; return 64; }
	[ "$(id -u)" -eq 0 ] || { printf '%s: install --privileged must run as root\n' "$PROG" >&2; return 1; }
	src="${ASIP_SOURCE_ROOT:-$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)}"
	if [ ! -r "$src/core/daemon.py" ] || [ ! -r "$src/a" ]; then
		printf '%s: this client is not an install tree; run install --privileged from an extracted ASIP release or use asip upgrade\n' "$PROG" >&2
		return 1
	fi
	[ -r "$src/scripts/restore_install_backup.sh" ] || {
		printf '%s: release is missing installer recovery helper: scripts/restore_install_backup.sh\n' "$PROG" >&2
		return 1
	}
	[ -r "$src/scripts/uninstall_software.sh" ] || {
		printf '%s: release is missing deferred removal helper: scripts/uninstall_software.sh\n' "$PROG" >&2
		return 1
	}
	python_tag="$(python3 -c 'import sys; print("%d%d" % sys.version_info[:2])')"
	case "$python_tag" in
	312|313|314) ;;
	*)
		printf '%s: Python %s is outside the supported MCP runtime matrix (3.12–3.14)\n' \
			"$PROG" "$python_tag" >&2
		return 1
		;;
	esac
	install_mode=first-install
	running_version=''
	if [ -r /usr/lib/asip/VERSION ]; then
		running_version="$(sed -n '1{s/[[:space:]]*$//;p;q;}' /usr/lib/asip/VERSION)"
	fi
	if [ "$self_upgrade" -eq 1 ]; then
		install_mode=self-upgrade
	elif [ -e /usr/local/bin/asip ] || [ -e /etc/asip/MACHINE.md ] || \
			[ -e /var/lib/asip/journal.jsonl ]; then
		install_mode=reinstall-repair
	fi
	if [ "$install_mode" = reinstall-repair ] && \
			systemctl is-active --quiet asip.service && \
			[ "$running_version" != "$VERSION" ]; then
		printf '%s: a running ASIP %s installation cannot be replaced by %s as a reinstall; use the verified upgrade workflow\n' \
			"$PROG" "${running_version:-unknown}" "$VERSION" >&2
		return 1
	fi
	install_backup=''
	if [ "$self_upgrade" -eq 1 ] && [ -n "$running_version" ]; then
		backup_dir=/var/lib/asip/install-backups
		install -d -o root -g asip -m 0700 "$backup_dir"
		install_backup="$backup_dir/${running_version}-$(date -u +%Y%m%d%H%M%S).tar"
		backup_list="$(mktemp "${TMPDIR:-/tmp}/asip-install-backup.XXXXXX")" || return 1
		for backup_path in usr/lib/asip usr/share/asip usr/local/bin/asip \
			usr/local/bin/a usr/local/bin/asip-inspect \
			etc/systemd/system/asip.service etc/systemd/system/asip.socket \
			etc/systemd/system/asip-read.service etc/systemd/system/asip-read.socket \
			usr/local/sbin/asip-uninstall; do
			[ -e "/$backup_path" ] && printf '%s\n' "$backup_path" >>"$backup_list"
		done
		if ! tar -C / -cpf "$install_backup" -T "$backup_list"; then
			rm -f -- "$backup_list" "$install_backup"
			printf '%s: could not retain the previous installation before upgrade\n' "$PROG" >&2
			return 1
		fi
		rm -f -- "$backup_list"
		chmod 0600 "$install_backup"
		printf 'Installer recovery backup retained at %s\n' "$install_backup"
	fi
	# MCP remains isolated from the standard-library core at runtime, but its
	# tested SDK is installed by default for this agent-first product. Resolve
	# it before replacing system files so package-index failure cannot leave a
	# half-applied core upgrade.
	operator="${SUDO_USER:-${ASIP_OPERATOR:-}}"
	mcp_status=skipped
	harness_status=skipped
	relogin_required=false
	if [ "$operator" = root ]; then operator=''; fi
	if [ -n "$operator" ]; then
		getent passwd "$operator" >/dev/null 2>&1 || {
			printf '%s: operator %s does not name a local account\n' "$PROG" "$operator" >&2
			return 1
		}
		operator_home="$(getent passwd "$operator" | cut -d: -f6)"
		operator_groups="$(id -nG "$operator")"
		case " $operator_groups " in *' asip '*) ;; *) relogin_required=true ;; esac
		case " $operator_groups " in *' asip-read '*) ;; *) relogin_required=true ;; esac
		if ! runuser -u "$operator" -- python3 -c 'import ensurepip, venv' >/dev/null 2>&1; then
			case "$(detect_pkgmgr)" in
			apt-get) apt-get update && apt-get install -y python3-venv ;;
			dnf) dnf install -y python3-pip ;;
			pacman) pacman -S --noconfirm python ;;
			zypper) zypper --non-interactive install python3-pip ;;
			emerge) emerge dev-python/pip ;;
			apk) apk add py3-pip ;;
			xbps-install) xbps-install -y python3-pip ;;
			*) printf '%s: cannot install the Python venv prerequisite for MCP\n' "$PROG" >&2; return 1 ;;
			esac
		fi
		mcp_src="$src"
		if [ ! -r "$src/pyproject.toml" ] && [ -r /usr/share/asip/mcp-source/pyproject.toml ]; then
			mcp_src=/usr/share/asip/mcp-source
		fi
		if ! runuser -u "$operator" -- "$src/asip" mcp install "$mcp_src"; then
			printf '%s: MCP adapter setup failed before system installation; fix the reported dependency error and retry\n' "$PROG" >&2
			return 1
		fi
		mcp_status=installed
	else
		printf '%s: no operator was supplied; Core installation will continue, but MCP setup requires the intended login user\n' "$PROG" >&2
	fi
	# Linux Audit supplies kernel attribution for changes made outside ASIP.
	# Package names differ, but the installed service and tools are auditd.
	if ! command -v auditctl >/dev/null 2>&1; then
		case "$(detect_pkgmgr)" in
		pacman) pacman -S --noconfirm audit ;;
		apt-get) apt-get update && apt-get install -y auditd ;;
		dnf) dnf install -y audit ;;
		zypper) zypper --non-interactive install audit ;;
		emerge) emerge sys-process/audit ;;
		apk) apk add audit ;;
		xbps-install) xbps-install -y audit ;;
		*) printf '%s: cannot install Linux Audit: unsupported package manager\n' "$PROG" >&2; return 1 ;;
		esac
	fi
	getent group asip >/dev/null 2>&1 || groupadd --system asip
	getent group asip-read >/dev/null 2>&1 || groupadd --system asip-read
	install -d -m 0755 /usr/lib/asip /usr/share/asip /etc/asip
	install -d -o root -g asip -m 0750 /var/lib/asip /var/lib/asip/blobs
	if [ -f /var/lib/asip/journal.jsonl ]; then
		chown root:asip /var/lib/asip/journal.jsonl
		chmod 0640 /var/lib/asip/journal.jsonl
	fi
	find /var/lib/asip/blobs -type f -exec chown root:asip {} + -exec chmod 0640 {} +
	rm -rf -- /usr/lib/asip/core
	cp -R "$src/core" /usr/lib/asip/core
	find /usr/lib/asip/core -type d -exec chmod 0755 {} +
	find /usr/lib/asip/core -type f -exec chmod 0644 {} +
	chmod 0755 /usr/lib/asip/core/server.py /usr/lib/asip/core/client.py
	rm -f -- /usr/lib/asip/asipd.py /usr/lib/asip/asip-client.py /usr/lib/asip/asip_protocol.py
	rm -rf -- /usr/lib/asip/cli
	cp -R "$src/cli" /usr/lib/asip/cli
	find /usr/lib/asip/cli -type d -exec chmod 0755 {} +
	find /usr/lib/asip/cli -type f -exec chmod 0644 {} +
	chmod 0755 /usr/lib/asip/cli/asip.sh
	rm -f -- /usr/lib/asip/asip_dashboard.py /usr/lib/asip/asip_ui.py \
		/usr/lib/asip/asip_release.py /usr/lib/asip/asip_telemetry.py \
		/usr/lib/asip/asip_telemetry_server.py /usr/lib/asip/asip_support.py \
		/usr/lib/asip/asip_eval.py
	rm -rf /usr/share/asip/eval
	install -d -m 0755 /usr/share/asip/eval
	cp -R "$src/eval/cases" /usr/share/asip/eval/cases
	cp -R "$src/eval/suites" /usr/share/asip/eval/suites
	install -m 0644 "$src/eval/trajectory.schema.json" "$src/eval/suite.schema.json" /usr/share/asip/eval/
	# The CLI reads the shared product version while the daemons import the
	# protocol module from /usr/lib/asip and intentionally resolve a sibling
	# VERSION. Keep both copies synchronized so a self-upgrade cannot make the
	# CLI and socket summaries disagree.
	install -m 0644 "$src/VERSION" /usr/share/asip/VERSION
	install -m 0644 "$src/VERSION" /usr/lib/asip/VERSION
	rm -rf -- /usr/share/asip/mcp-source
	install -d -m 0755 /usr/share/asip/mcp-source
	install -m 0644 "$src/pyproject.toml" "$src/asip_mcp.py" \
		"$src/VERSION" /usr/share/asip/mcp-source/
	cp -R "$src/core" /usr/share/asip/mcp-source/core
	for mcp_directory in requirements wheelhouse; do
		if [ -d "$src/$mcp_directory" ]; then
			cp -R "$src/$mcp_directory" "/usr/share/asip/mcp-source/$mcp_directory"
			find "/usr/share/asip/mcp-source/$mcp_directory" -type d -exec chmod 0755 {} +
			find "/usr/share/asip/mcp-source/$mcp_directory" -type f -exec chmod 0644 {} +
		fi
	done
	install -m 0755 "$src/asip" /usr/local/bin/asip
	install -m 0755 "$src/a" /usr/local/bin/a
	install -m 0755 "$src/asip-inspect" /usr/local/bin/asip-inspect
	install -d -m 0755 /usr/local/sbin
	install -m 0755 "$src/scripts/restore_install_backup.sh" /usr/local/sbin/asip-restore
	install -m 0755 "$src/scripts/uninstall_software.sh" /usr/local/sbin/asip-uninstall
	install -m 0644 "$src/systemd/asip.socket" /etc/systemd/system/asip.socket
	install -m 0644 "$src/systemd/asip.service" /etc/systemd/system/asip.service
	install -m 0644 "$src/systemd/asip-read.socket" /etc/systemd/system/asip-read.socket
	install -m 0644 "$src/systemd/asip-read.service" /etc/systemd/system/asip-read.service
	install -d -m 0750 /etc/audit/rules.d
	cat >/etc/audit/rules.d/asip.rules <<'EOF'
# ASIP: attribute executable-bit and other mode changes by logged-in users.
-a always,exit -F arch=b64 -S chmod,fchmod,fchmodat -F auid>=1000 -F auid!=4294967295 -k asip_mode
EOF
	if [ ! -f /etc/asip/MACHINE.md ]; then
		machine_stage="$(mktemp "${TMPDIR:-/tmp}/asip-machine.XXXXXX")" || return 1
		if ! "$src/asip" skeleton >"$machine_stage"; then
			rm -f -- "$machine_stage"
			printf '%s: could not generate the initial MACHINE.md policy\n' "$PROG" >&2
			return 1
		fi
		install -m 0644 "$machine_stage" /etc/asip/MACHINE.md
		rm -f -- "$machine_stage"
	fi
	# Agent harnesses run as the login user and must be able to read machine
	# policy. Repair permissions without replacing the operator's existing text.
	chown root:root /etc/asip/MACHINE.md
	chmod 0644 /etc/asip/MACHINE.md
	# Installation may read from a root-squashed or user-mounted source tree.
	# Normalize every system-owned product artifact explicitly instead of
	# relying on cp/install's source ownership behavior.
	chown -R root:root /usr/lib/asip /usr/share/asip
	chown root:root /usr/local/bin/asip /usr/local/bin/a /usr/local/bin/asip-inspect \
		/usr/local/sbin/asip-restore /usr/local/sbin/asip-uninstall \
		/etc/systemd/system/asip.socket /etc/systemd/system/asip.service \
		/etc/systemd/system/asip-read.socket /etc/systemd/system/asip-read.service
	[ ! -e /etc/audit/rules.d/asip.rules ] || chown root:root /etc/audit/rules.d/asip.rules
	systemctl daemon-reload
	systemctl enable --now auditd
	if ! auditctl -l | grep -q -- '-F key=asip_mode$'; then
		if ! augenrules --load && ! auditctl -l | grep -q -- '-F key=asip_mode$'; then
			printf '%s: could not activate the ASIP Linux Audit rule; inspect auditd and retry\n' "$PROG" >&2
			return 1
		fi
		# Some distributions keep a compiled copy of a rule after its source has
		# been removed. If the intended ASIP key is active, a duplicate-load exit
		# is harmless and must not make a reinstall/repair fail.
		if auditctl -l | grep -q -- '-F key=asip_mode$'; then
			printf 'ASIP Linux Audit rule is active.\n'
		fi
	fi
	# A failed read daemon can rate-limit its socket during an upgrade. Clear
	# that transient state after replacing the code so an idempotent retry heals.
	systemctl reset-failed asip-read.socket asip-read.service >/dev/null 2>&1 || true
	systemctl enable --now asip.socket
	# An interrupted failure-isolation or upgrade test can leave the static
	# read service running after its socket was stopped. systemd refuses to
	# start the socket while that orphaned service owns the endpoint, so repair
	# this split state before enabling the normal socket-activated path.
	if systemctl is-active --quiet asip-read.service && \
			! systemctl is-active --quiet asip-read.socket; then
		systemctl stop asip-read.service
	fi
	systemctl enable --now asip-read.socket
	if [ "$self_upgrade" -eq 1 ]; then
		# Restarting asip.service synchronously from an `asip do` child would
		# terminate the daemon before it can fsync this installation's terminal
		# journal record. A transient timer preserves the self-upgrade restart
		# contract while letting the request finish first.
		systemd-run --quiet --unit="asip-deferred-restart-$$" --on-active=10s \
			--collect -- /usr/bin/systemctl restart asip.service asip-read.service
		printf 'ASIP services will restart in 10 seconds after the current journal entry closes.\n'
	elif systemctl is-active --quiet asip.service; then
		# A same-version reinstall has already replaced the on-disk files. Keep the
		# healthy running daemon instead of scheduling an asynchronous restart that
		# could sever the next unrelated ASIP request. The verified self-upgrade path
		# above owns its restart and reconnect barrier when versions differ.
		# The read-only daemon does not own the mutation lane, so it can be
		# refreshed immediately. Keep the privileged daemon alive until its
		# current journal entry and any other active request have completed.
		systemctl try-restart asip-read.service
		printf 'The ASIP administration daemon stayed active; the read-only daemon was refreshed. Administration code applies on its next normal activation.\n'
	else
		systemctl try-restart asip.service
		systemctl try-restart asip-read.service
	fi
	# The invoking login user, not root, gets the access deliberately granted here.
	if [ -n "$operator" ]; then
		usermod -aG asip "$operator"
		usermod -aG asip-read "$operator"
		runuser -u "$operator" -- /usr/local/bin/asip bootstrap --harness all
		harness_status=refreshed
		# install.sh stages a complete bootstrap client in ~/.local/bin so the
		# one-time privileged installation can start. Always reconcile the two
		# operator-facing entrypoints to managed-system forwarders, regardless of
		# whether this installer runs from that bootstrap tree, an extracted release,
		# or a self-upgrade staging directory. Otherwise a stale bootstrap earlier on
		# PATH can keep reporting and running the old product after a valid upgrade.
		operator_bin="$operator_home/.local/bin"
		forward_stage="$(mktemp -d "${TMPDIR:-/tmp}/asip-forwarders.XXXXXX")" || return 1
		printf '%s\n' '#!/bin/sh' 'exec /usr/local/bin/asip "$@"' >"$forward_stage/a"
		printf '%s\n' '#!/bin/sh' 'exec /usr/local/bin/asip "$@"' >"$forward_stage/asip"
		printf '%s\n' '#!/bin/sh' 'exec /usr/local/bin/asip-inspect "$@"' >"$forward_stage/asip-inspect"
		bootstrap_owned=0
		if [ "$(readlink -f "$src")" = "$(readlink -f "$operator_bin")" ] || \
				{ [ -f "$operator_bin/core/client.py" ] && \
				[ -f "$operator_bin/core/protocol.py" ] && \
				[ -f "$operator_bin/systemd/asip.socket" ]; }; then
			bootstrap_owned=1
		fi
		if [ "$bootstrap_owned" -eq 1 ]; then
			for bootstrap_file in a asip asip-inspect VERSION \
					asip_mcp.py pyproject.toml; do
				rm -f -- "$operator_bin/$bootstrap_file"
			done
			rm -rf -- "$operator_bin/core" "$operator_bin/cli"
			rm -rf -- "$operator_bin/systemd" "$operator_bin/requirements" "$operator_bin/wheelhouse"
		fi
		install -o "$operator" -g "$(id -gn "$operator")" -m 0755 \
			"$forward_stage/a" "$operator_bin/a"
		install -o "$operator" -g "$(id -gn "$operator")" -m 0755 \
			"$forward_stage/asip" "$operator_bin/asip"
		install -o "$operator" -g "$(id -gn "$operator")" -m 0755 \
			"$forward_stage/asip-inspect" "$operator_bin/asip-inspect"
		rm -rf -- "$forward_stage"
	fi
	health=attention
	if /usr/local/bin/asip-inspect doctor >/dev/null 2>&1; then
		health=healthy
	fi
	printf 'ASIP installation succeeded. This is the last time root escalation is needed for normal ASIP administration.\n'
	printf 'Post-install health: %s (read-only socket and journal check)\n' "$health"
	printf 'MCP adapter: %s (host registration remains an explicit operator choice)\n' "$mcp_status"
	printf 'Run "asip doctor --json" now for operational health; plain "asip doctor" also reports onboarding completeness.\n'
	printf 'Start a new login session if group membership was just added.\n'
	printf 'ASIP now records and inspects privileged work through its local sockets.\n'
	printf 'Use the ASIP MCP adapter from your agent, and run "asip upgrade --check" before upgrading.\n'
	if [ -n "$install_backup" ]; then
		printf 'If the upgraded services cannot restart, restore with: /usr/local/sbin/asip-restore %s\n' "$install_backup"
	fi
	if [ "$self_upgrade" -eq 0 ]; then
		print_install_handoff
	fi
	if [ "$self_upgrade" -eq 0 ]; then handoff_status=printed; else handoff_status=suppressed; fi
	printf 'ASIP_INSTALL_RESULT {"schema_version":1,"status":"installed","mode":"%s","version":"%s","health":"%s","mcp":"%s","harness":"%s","relogin_required":%s,"handoff":"%s","installer_backup":"%s"}\n' \
		"$install_mode" "$VERSION" "$health" "$mcp_status" "$harness_status" \
		"$relogin_required" "$handoff_status" "${install_backup:-}"
}

case "${1:-help}" in
install) shift; cmd_install "$@" ;;
upgrade) shift; cmd_upgrade "$@" ;;
uninstall) shift; cmd_uninstall "$@" ;;
dashboard)
	printf '%s\n' 'The web dashboard is not included in ASIP Core.' >&2
	exit 69
	;;
telemetry) shift; cmd_telemetry "$@" ;;
support) shift; cmd_support "$@" ;;
eval) shift; cmd_eval "$@" ;;
bootstrap) shift; cmd_bootstrap_live "$@" ;;
onboard) shift; cmd_onboard "$@" ;;
change) shift; cmd_change "$@" ;;
note) shift; cmd_note "$@" ;;
do) shift; cmd_do "$@" ;;
pkg) shift; cmd_pkg "$@" ;;
svc) shift; cmd_svc "$@" ;;
conf) shift; cmd_conf "$@" ;;
observe) shift; cmd_observe "$@" ;;
maintenance) shift; cmd_maintenance "$@" ;;
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
	if [ "${2:-}" = "--json" ] || [ "$JSON" -eq 1 ]; then
		python3 "$(release_file)" check --json
	else
		release_status="$(python3 "$(release_file)" check)"
		installed="$(release_field installed_version)"
		source="$(release_field installed_source)"
		client="$(release_field client_version)"
		if [ -n "$installed" ]; then
			printf '%s %s\n' "$PROG" "$installed"
		else
			# A bootstrap/client can report its own qualified version even before
			# a daemon is installed.  Do not label a known release "unknown";
			# keep the separate installed_version field truthful below.
			printf '%s %s (client; installation unavailable)\n' "$PROG" "$VERSION"
		fi
		printf 'client_version=%s\n' "${client:-$VERSION}"
		printf 'installed_version=%s\n' "${installed:-}"
		printf 'installed_source=%s\n' "${source:-unavailable}"
	fi
	;;
help | --help | -h) cmd_help ;;
*)
	printf '%s: unknown command "%s"\n\n' "$PROG" "$1" >&2
	cmd_help >&2
	exit 1
	;;
esac

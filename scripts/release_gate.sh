#!/bin/sh
# Normal, non-destructive release gate. Live host checks remain opt-in.
set -eu

repo=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cache=$(mktemp -d "${TMPDIR:-/tmp}/asip-release-gate.XXXXXX")
cleanup() { rm -rf -- "$cache"; }
trap cleanup 0 1 2 3 15

cd "$repo"
python3 scripts/test_clean_tree.py
python3 scripts/run_bounded.py --timeout "${ASIP_TEST_TIMEOUT_SECONDS:-300}" -- \
	python3 -m unittest discover -s tests -v
shellcheck asip cli/asip.sh asip-inspect install.sh scripts/build_release.sh scripts/build_release_candidate.sh scripts/restore_install_backup.sh scripts/uninstall_software.sh \
	scripts/build_upgrade_fixture.sh scripts/build_wheelhouse.sh scripts/test_wheelhouse.sh \
	scripts/release_gate.sh installer/asip-installer packaging/appimage/build.sh tests/live_systemd.sh
PYTHONPYCACHEPREFIX="$cache/pycache" python3 -m py_compile \
	core/client.py core/daemon.py core/facts.py core/maintenance.py core/protocol.py core/server.py asip_mcp.py \
	cli/release.py cli/telemetry.py cli/telemetry_server.py cli/support.py cli/eval.py \
	installer/app.py installer/distro.py installer/privileged_helper.py installer/staging.py \
	scripts/wheelhouse_lock.py scripts/qualification.py scripts/run_bounded.py scripts/test_clean_tree.py \
	tests/mcp_stdio_smoke.py \
	eval/cases/deleted-running-executable/setup.py eval/cases/deleted-running-executable/grade.py \
	eval/cases/asip-discipline-baseline/setup.py eval/cases/asip-discipline-baseline/grade.py
git diff --check
SOURCE_DATE_EPOCH=0 scripts/build_release.sh "$cache/release" >/dev/null

mcp_python=python3
managed_mcp_entry="$(readlink -f "$HOME/.local/bin/asip-mcp-inspect" 2>/dev/null || true)"
managed_mcp_python="$(dirname -- "$managed_mcp_entry")/python"
if ! "$mcp_python" -c 'import mcp' >/dev/null 2>&1 && [ -x "$managed_mcp_python" ]; then
	mcp_python=$managed_mcp_python
fi
if "$mcp_python" -c 'import mcp' >/dev/null 2>&1; then
	PYTHONPATH="$repo" "$mcp_python" -m unittest tests.test_mcp -v
else
	printf 'release gate: optional MCP SDK absent; core tests passed and MCP tests were skipped.\n'
fi

printf 'ASIP normal release gate passed. Live systemd/MCP gates remain explicit.\n'

import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest


REPOSITORY = pathlib.Path(__file__).resolve().parents[1]
CLI_IMPLEMENTATION = REPOSITORY / "cli" / "asip.sh"


class CliTestCase(unittest.TestCase):
    def test_root_command_is_a_thin_stable_launcher(self):
        launcher = (REPOSITORY / "asip").read_text(encoding="utf-8")
        self.assertLess(len(launcher.splitlines()), 30)
        self.assertIn("cli/asip.sh", launcher)
        self.assertNotIn("cmd_install()", launcher)
        self.assertTrue(CLI_IMPLEMENTATION.stat().st_mode & 0o111)

    def test_core_client_is_import_safe(self):
        result = subprocess.run(
            ["python3", "-c", "import core.client; print(core.client.__name__)"],
            cwd=REPOSITORY, text=True, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, check=True,
        )
        self.assertEqual(result.stdout.strip(), "core.client")

    def test_core_install_does_not_pull_experimental_desktop_dependencies(self):
        script = CLI_IMPLEMENTATION.read_text(encoding="utf-8")
        install_body = script.split("cmd_install() {", 1)[1].split(
            '\ncase "${1:-help}" in', 1
        )[0]
        self.assertNotIn("install_desktop_system_dependencies", install_body)
        self.assertNotIn("desktop install", install_body)
        self.assertNotIn("apparmor_parser", install_body)
        self.assertIn("the native ASIP Desktop is not included", script)
        self.assertIn("return 69", script.split("cmd_desktop() {", 1)[1].split("\n}", 1)[0])

    def test_install_wires_harness_rules_without_silencing_notice(self):
        script = CLI_IMPLEMENTATION.read_text()
        install_body = script.split("cmd_install() {", 1)[1].split(
            '\ncase "${1:-help}" in', 1
        )[0]

        self.assertIn("bootstrap --harness all", install_body)
        self.assertIn("--self-upgrade", install_body)
        self.assertIn("asip-deferred-restart-", install_body)
        self.assertIn('systemctl is-active --quiet asip.service', install_body)
        self.assertIn('ASIP_OPERATOR', install_body)
        self.assertIn('install_backup=', install_body)
        self.assertIn('/usr/local/sbin/asip-restore', install_body)
        self.assertIn('/usr/local/sbin/asip-uninstall', install_body)
        self.assertIn('restore_install_backup.sh', install_body)
        self.assertIn('uninstall_software.sh', install_body)
        self.assertIn('/usr/share/asip/mcp-source', install_body)
        self.assertIn('this client is not an install tree', install_body)
        self.assertIn('getent passwd "$operator"', install_body)
        self.assertNotIn("install_desktop_system_dependencies", install_body)
        self.assertNotIn('runuser -u "$operator" -- "$src/asip" desktop install', install_body)
        self.assertNotIn("apparmor_parser", install_body)
        self.assertIn("reset-failed asip-read.socket asip-read.service", install_body)
        self.assertIn('! systemctl is-active --quiet asip-read.socket', install_body)
        self.assertIn('systemctl stop asip-read.service', install_body)
        self.assertIn('ASIP administration daemon stayed active; the read-only daemon was refreshed', install_body)
        self.assertIn('[ "$running_version" != "$VERSION" ]', install_body)
        deferred = install_body.split('if [ "$self_upgrade" -eq 1 ]; then', 1)[1].split(
            "elif systemctl is-active --quiet asip.service", 1
        )[0]
        self.assertIn("asip-deferred-restart-", deferred)
        self.assertLess(
            install_body.index('systemctl stop asip-read.service'),
            install_body.index('systemctl enable --now asip-read.socket'),
        )
        self.assertIn('bootstrap --harness all', install_body)
        self.assertIn('/usr/share/asip/mcp-source', install_body)
        self.assertIn('print_install_handoff', install_body)
        install_script = (REPOSITORY / "install.sh").read_text(encoding="utf-8")
        self.assertIn('github.com/M-o-liver/asip-linux/releases/download/v$RELEASE_VERSION', install_script)
        self.assertNotIn('raw.githubusercontent.com/M-o-liver/asip/main', install_script)
        self.assertIn('install -m 0644 "$machine_stage" /etc/asip/MACHINE.md', install_body)
        self.assertIn('chmod 0644 /etc/asip/MACHINE.md', install_body)
        self.assertIn('chown -R root:root /usr/lib/asip /usr/share/asip', install_body)
        self.assertIn('install -m 0644 "$src/VERSION" /usr/share/asip/VERSION', install_body)
        self.assertIn('install -m 0644 "$src/VERSION" /usr/lib/asip/VERSION', install_body)
        self.assertIn("grep -q -- '-F key=asip_mode$'", install_body)
        self.assertIn('could not activate the ASIP Linux Audit rule', install_body)
        self.assertIn('exec /usr/local/bin/asip "$@"', install_body)
        self.assertIn('exec /usr/local/bin/asip-inspect "$@"', install_body)
        self.assertIn('readlink -f "$operator_bin"', install_body)
        self.assertIn('[ -f "$operator_bin/core/client.py" ]', install_body)
        self.assertIn('[ -f "$operator_bin/core/protocol.py" ]', install_body)
        self.assertIn('[ -f "$operator_bin/systemd/asip.socket" ]', install_body)
        self.assertLess(
            install_body.index('exec /usr/local/bin/asip "$@"'),
            install_body.index('bootstrap_owned=0'),
        )
        self.assertGreater(
            install_body.index('"$forward_stage/asip" "$operator_bin/asip"'),
            install_body.index('if [ "$bootstrap_owned" -eq 1 ]'),
        )
        self.assertLess(
            install_body.index('bootstrap --harness all'),
            install_body.index('print_install_handoff'),
        )
        self.assertIn('"$src/asip" mcp install "$mcp_src"', install_body)
        self.assertLess(
            install_body.index('"$src/asip" mcp install "$mcp_src"'),
            install_body.index('install -d -m 0755 /usr/lib/asip'),
        )
        for negative in ("don't", "do not"):
            self.assertNotIn(f"{negative} tell the user", script.lower())

        rule = subprocess.run(
            [str(REPOSITORY / "asip"), "rule", "generic"],
            cwd=REPOSITORY,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
        self.assertIn("asip_brief", rule.stdout)
        self.assertIn("typed ASIP MCP tools", rule.stdout)
        self.assertIn("/etc/asip/MACHINE.md", rule.stdout)
        self.assertIn("attention` as authoritative", rule.stdout)
        self.assertIn("arbitrary root authority", rule.stdout)

    def test_install_handoff_reuses_the_initial_onboarding_prompt(self):
        script = CLI_IMPLEMENTATION.read_text(encoding="utf-8")
        handoff = script.split("print_install_handoff() {", 1)[1].split(
            "\ncmd_maintenance() {", 1
        )[0]
        self.assertIn("BEGIN ASIP INSTALL HANDOFF", handoff)
        self.assertIn("cmd_onboard", handoff)
        self.assertIn("END ASIP INSTALL HANDOFF", handoff)

        result = subprocess.run(
            [str(REPOSITORY / "asip"), "onboard", "--initial"],
            cwd=REPOSITORY,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
        self.assertIn("ASIP INITIAL ONBOARDING", result.stdout)
        self.assertIn("Confirm that each installed agent harness", result.stdout)
        self.assertIn("native `asip-inspect` and", result.stdout)
        self.assertIn("integration\n   condition", result.stdout)
        self.assertIn("Never wrap MCP in `sg`", result.stdout)
        self.assertIn("relaunches the agent", result.stdout)
        self.assertNotIn("codex mcp add", result.stdout)

    def test_privileged_install_has_a_bounded_machine_result(self):
        script = CLI_IMPLEMENTATION.read_text(encoding="utf-8")
        self.assertIn("ASIP_INSTALL_RESULT", script)
        self.assertIn('\"mode\":\"%s\"', script)
        self.assertIn('\"relogin_required\":%s', script)
        self.assertNotIn('\"operator\":', script)

    def test_product_version_surfaces_share_the_canonical_version(self):
        version = (REPOSITORY / "VERSION").read_text(encoding="utf-8").strip()
        cli = subprocess.run(
            [str(REPOSITORY / "asip"), "version"], cwd=REPOSITORY,
            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True,
        )
        inspect = subprocess.run(
            [str(REPOSITORY / "asip-inspect"), "help"], cwd=REPOSITORY,
            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True,
        )
        self.assertTrue(cli.stdout.startswith("asip "))
        # The release gate is intentionally safe to run on an installed
        # developer workstation as well as in an isolated checkout.  In the
        # former case the live daemon is the truthful installed version;
        # otherwise the client-only fallback is expected.
        fields = dict(
            line.split("=", 1) for line in cli.stdout.splitlines()[1:] if "=" in line
        )
        displayed = cli.stdout.splitlines()[0]
        installed_version = fields.get("installed_version", "")
        if installed_version:
            self.assertEqual(displayed, f"asip {installed_version}")
        else:
            self.assertEqual(displayed, f"asip {version} (client; installation unavailable)")
        self.assertIn(f"client_version={version}", cli.stdout)
        self.assertIn("installed_version=", cli.stdout)
        self.assertIn("installed_source=", cli.stdout)
        self.assertIn(f"asip-inspect {version}", inspect.stdout)
        self.assertIn(f"else \"{version}\"", (REPOSITORY / "core" / "protocol.py").read_text())

    def test_uninstall_has_explicit_software_and_purge_boundaries(self):
        script = CLI_IMPLEMENTATION.read_text(encoding="utf-8")
        self.assertIn("uninstall --software|", script)
        self.assertIn("--purge", script)
        self.assertIn("case \"$mode\" in", script)
        uninstall = script.split("cmd_uninstall() {", 1)[1].split(
            "cmd_telemetry() {", 1
        )[0]
        self.assertIn('case "$mode" in', uninstall)
        self.assertIn("/var/lib/asip", uninstall)
        self.assertIn("systemd-run --quiet --unit=", uninstall)
        self.assertIn("--on-active=10s", uninstall)
        self.assertIn("/usr/local/sbin/asip-uninstall", uninstall)
        self.assertNotIn("asip-fleet", uninstall)
        self.assertNotIn("asip-desktop", uninstall)
        helper = (REPOSITORY / "scripts" / "uninstall_software.sh").read_text(encoding="utf-8")
        self.assertIn("systemctl disable --now", helper)
        self.assertIn("Retained: /etc/asip", helper)

    def test_a_is_the_human_alias_for_the_asip_implementation(self):
        version = (REPOSITORY / "VERSION").read_text(encoding="utf-8").strip()
        result = subprocess.run(
            [str(REPOSITORY / "a"), "version"], cwd=REPOSITORY,
            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True,
        )
        self.assertTrue(result.stdout.startswith("a "))
        self.assertIn(f"client_version={version}", result.stdout)
        self.assertIn("asip", (REPOSITORY / "a").read_text(encoding="utf-8"))

    def test_inspect_json_flag_is_stripped_and_client_has_no_inspect_banner(self):
        inspect = (REPOSITORY / "asip-inspect").read_text(encoding="utf-8")
        client = (REPOSITORY / "core" / "client.py").read_text(encoding="utf-8")
        self.assertIn('--json', inspect)
        self.assertIn("recovery", inspect)
        self.assertIn('[ "$#" -eq 1 ] || [ "$#" -eq 2 ]', inspect)
        self.assertIn('if [ "$_arg" = "--json" ]; then', inspect)
        self.assertIn("parser.add_argument(\"--json\"", client)
        self.assertIn("if is_read_only(", client)
        self.assertIn("None if (args.json or args.response_json)", client)
        self.assertNotIn("asip-inspect: read-only query", client)
        maintenance = CLI_IMPLEMENTATION.read_text(encoding="utf-8")
        self.assertIn('if [ "$#" -gt 0 ]; then', maintenance.split("cmd_maintenance() {", 1)[1])
        self.assertIn("maintenance omit", maintenance)
        self.assertIn("cmd_recovery()", maintenance)
        self.assertIn("--json)", maintenance.split("REQUEST_KEY=", 1)[1][:800])
        self.assertIn('set -- --json "$@"', CLI_IMPLEMENTATION.read_text(encoding="utf-8"))
        self.assertIn("change hold", CLI_IMPLEMENTATION.read_text(encoding="utf-8"))
        self.assertIn("cmd_facts()", CLI_IMPLEMENTATION.read_text(encoding="utf-8"))
        self.assertIn("append it so", CLI_IMPLEMENTATION.read_text(encoding="utf-8"))
        self.assertIn("facts", (REPOSITORY / "asip-inspect").read_text(encoding="utf-8"))
        self.assertIn("ProtectHome=read-only",
                      (REPOSITORY / "systemd" / "asip-read.service").read_text(encoding="utf-8"))
        self.assertIn("cmd_ask()", CLI_IMPLEMENTATION.read_text(encoding="utf-8"))
        self.assertNotIn("asktheoperator", CLI_IMPLEMENTATION.read_text(encoding="utf-8"))
        self.assertIn("The web dashboard is not included in ASIP Core", CLI_IMPLEMENTATION.read_text(encoding="utf-8"))

    def test_client_reports_daemon_transition_without_a_traceback(self):
        client = (REPOSITORY / "core" / "client.py").read_text(encoding="utf-8")
        self.assertIn("except ConnectionError:", client)
        self.assertIn("the associated change and operation state", client)

    def test_documented_removal_covers_all_installed_product_helpers(self):
        readme = (REPOSITORY / "README.md").read_text(encoding="utf-8")
        self.assertIn("UNINSTALL.md", readme)
        installer = CLI_IMPLEMENTATION.read_text(encoding="utf-8")
        self.assertIn("/usr/local/sbin/asip-uninstall", installer)
        self.assertIn("uninstall_software.sh", installer)

    def test_socket_units_remove_runtime_nodes_when_stopped(self):
        for unit_name in ("asip.socket", "asip-read.socket"):
            unit = (REPOSITORY / "systemd" / unit_name).read_text(encoding="utf-8")
            self.assertIn("RemoveOnStop=yes", unit)

    def test_upgrade_path_preflights_snapshots_reconnects_and_verifies(self):
        script = CLI_IMPLEMENTATION.read_text()
        upgrade = script.split("cmd_upgrade() {", 1)[1].split(
            "\ncmd_telemetry() {", 1
        )[0]
        for expected in (
            'python3 "$(release_file)" check',
            'request_readonly --op doctor',
            'cmd_snap "Before upgrading ASIP',
            '--self-upgrade',
            'request_readonly --op summary',
            'request_unscoped --op summary',
            'stable_checks',
            'while [ "$attempt" -lt 60 ]',
            'sleep 15',
            'trap cleanup_stage 1 2 3 15',
            'cmd_verify pass upgrade',
            'cmd_change finish "$change"',
            'cmd_change fail "$change"',
        ):
            self.assertIn(expected, upgrade)
        self.assertNotIn("trap cleanup_stage EXIT", upgrade)

    def test_generated_rule_uses_canonical_machine_file(self):
        result = subprocess.run(
            [str(REPOSITORY / "asip"), "rule", "codex"],
            cwd=REPOSITORY,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
        self.assertIn("/etc/asip/MACHINE.md", result.stdout)
        self.assertNotIn("~/MACHINE.md", result.stdout)

    def test_generated_rule_routes_only_privileged_work_through_asip(self):
        result = subprocess.run(
            [str(REPOSITORY / "asip"), "rule", "generic"],
            cwd=REPOSITORY,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
        self.assertIn("`asip_do` only when no typed operation fits", result.stdout)
        self.assertIn("arbitrary root authority", result.stdout)
        self.assertIn("access_use", result.stdout)
        self.assertIn("access_start", result.stdout)
        self.assertIn("ordinary unprivileged tools directly for userland work", result.stdout)

    def test_global_change_option_is_forwarded_per_request(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            shutil.copy2(CLI_IMPLEMENTATION, root / "asip")
            client = root / "core" / "client.py"
            client.parent.mkdir()
            client.write_text(
                "#!/usr/bin/env python3\nimport sys\nprint('\\n'.join(sys.argv[1:]))\n",
                encoding="utf-8",
            )
            client.chmod(0o755)
            result = subprocess.run(
                [str(root / "asip"), "--change", "change-a", "do", "--", "true"],
                cwd=root,
                env=dict(os.environ, HOME=str(root)),
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=True,
            )
            self.assertIn("--change-id\nchange-a", result.stdout)
            self.assertIn("--op\ndo", result.stdout)

    def test_do_forwards_sensitive_capture_and_effect_annotations(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            shutil.copy2(CLI_IMPLEMENTATION, root / "asip")
            client = root / "core" / "client.py"
            client.parent.mkdir()
            client.write_text(
                "#!/usr/bin/env python3\nimport sys\nprint('\\n'.join(sys.argv[1:]))\n",
                encoding="utf-8",
            )
            client.chmod(0o755)
            result = subprocess.run(
                [str(root / "asip"), "--standalone", "isolated test", "do", "--sensitive", "--affects", "/etc/demo",
                 "--affects", "/usr/src/demo", "--", "true"],
                cwd=root,
                env=dict(os.environ, HOME=str(root)),
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=True,
            )
            self.assertIn("--sensitive", result.stdout)
            self.assertIn("--affects\n/etc/demo,/usr/src/demo", result.stdout)
            self.assertIn("--standalone-reason\nisolated test", result.stdout)

    def test_help_spells_out_verification_shape(self):
        result = subprocess.run(
            [str(REPOSITORY / "asip"), "--help"],
            cwd=REPOSITORY,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
        self.assertIn("verify pass|fail TOOL NOTE", result.stdout)
        self.assertIn("ROOT-EQUIVALENT", result.stdout)

    def test_inspection_client_is_pinned_to_read_only_socket(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            shutil.copy2(REPOSITORY / "asip-inspect", root / "asip-inspect")
            inspector = root / "asip-inspect"
            inspector.chmod(0o755)
            client = root / "core" / "client.py"
            client.parent.mkdir()
            client.write_text(
                "#!/usr/bin/env python3\nimport sys\nprint('\\n'.join(sys.argv[1:]))\n",
                encoding="utf-8",
            )
            client.chmod(0o755)
            result = subprocess.run(
                [str(inspector), "change", "open"],
                cwd=root,
                env=dict(os.environ, HOME=str(root)),
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=True,
            )
            self.assertIn("--socket\n/run/asip/read.sock", result.stdout)
            self.assertIn("--op\nchange", result.stdout)

    def test_change_start_does_not_inherit_an_unrelated_change(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            shutil.copy2(CLI_IMPLEMENTATION, root / "asip")
            client = root / "core" / "client.py"
            client.parent.mkdir()
            client.write_text(
                "#!/usr/bin/env python3\nimport sys\nprint('\\n'.join(sys.argv[1:]))\n",
                encoding="utf-8",
            )
            client.chmod(0o755)
            result = subprocess.run(
                [str(root / "asip"), "change", "start", "new intent"],
                cwd=root,
                env=dict(os.environ, HOME=str(root), ASIP_CHANGE_ID="old-change"),
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=True,
            )
            self.assertNotIn("--change-id", result.stdout)
            self.assertIn("--action\nstart", result.stdout)

    def test_checkout_installer_is_idempotent(self):
        installer = (REPOSITORY / "install.sh").read_text()
        self.assertIn("github.com/M-o-liver/asip-linux/releases/download/v$RELEASE_VERSION", installer)
        self.assertNotIn("raw.githubusercontent.com/M-o-liver/asip/main", installer)
        self.assertNotIn("asip-experimental", installer)
        with tempfile.TemporaryDirectory() as directory:
            home = pathlib.Path(directory)
            env = dict(os.environ, HOME=str(home))
            installed = home / ".local" / "bin"
            for relative in ("local-tools/old.py", "extensions/old.py", "custom-wheels/old.whl",
                             "docs/local/old.md", "policies/custom.policy"):
                path = installed / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("obsolete experimental payload", encoding="utf-8")
            for _ in range(2):
                subprocess.run(
                    [str(REPOSITORY / "install.sh")],
                    cwd=REPOSITORY,
                    env=env,
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    check=True,
                )
            for relative in ("a", "asip", "asip-inspect", "core/__init__.py", "core/daemon.py", "core/client.py", "core/maintenance.py", "core/protocol.py",
                             "VERSION", "cli/__init__.py", "cli/asip.sh", "cli/release.py", "cli/telemetry.py",
                             "cli/telemetry_server.py", "cli/support.py", "cli/eval.py", "asip_mcp.py", "pyproject.toml",
                             "installer/__init__.py", "installer/distro.py", "installer/privileged_helper.py",
                             "scripts/restore_install_backup.sh", "scripts/uninstall_software.sh",
                             "systemd/asip.socket", "systemd/asip.service",
                             "systemd/asip-read.socket", "systemd/asip-read.service"):
                self.assertEqual(
                    (installed / relative).read_bytes(), (REPOSITORY / relative).read_bytes()
                )
            for relative in ("local-tools/old.py", "extensions/old.py", "custom-wheels/old.whl",
                             "docs/local/old.md", "policies/custom.policy"):
                self.assertEqual((installed / relative).read_text(encoding="utf-8"),
                                 "obsolete experimental payload")
            self.assertFalse(any((installed / "requirements").glob("fleet*")))

    def test_bootstrap_json_result_is_machine_readable(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(
                [str(REPOSITORY / "install.sh"), "--json"],
                cwd=REPOSITORY,
                env=dict(os.environ, HOME=directory),
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=True,
            )
            payload = __import__("json").loads(result.stdout)
            self.assertEqual(payload["status"], "bootstrap-installed")
            self.assertTrue(payload["client"].endswith("/asip"))
            self.assertTrue(payload["compatibility_client"].endswith("/a"))
            self.assertEqual(payload["mcp_source"], "staged")
            self.assertEqual(payload["release"], "local")

    def test_bootstrap_replacement_does_not_accumulate_blank_lines(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            script = CLI_IMPLEMENTATION.read_text().replace(
                "md=/etc/asip/MACHINE.md", "md=%s" % (root / "MACHINE.md")
            )
            executable = root / "asip"
            executable.write_text(script, encoding="utf-8")
            executable.chmod(0o755)
            (root / "MACHINE.md").write_text("# test\n", encoding="utf-8")
            target = root / ".claude" / "CLAUDE.md"
            target.parent.mkdir(parents=True)
            target.write_text("# Local rules\n\n\n", encoding="utf-8")
            env = dict(os.environ, HOME=str(root))
            subprocess.run(
                [str(executable), "bootstrap", "--harness", "claude"],
                cwd=root, env=env, check=True, stdout=subprocess.PIPE, text=True,
            )
            once = target.read_bytes()
            subprocess.run(
                [str(executable), "bootstrap", "--harness", "claude"],
                cwd=root, env=env, check=True, stdout=subprocess.PIPE, text=True,
            )
            self.assertEqual(target.read_bytes(), once)
            self.assertIn(b"# Local rules\n\n<!-- ASIP: BEGIN -->", once)

    def test_grok_bootstrap_is_idempotent_and_uses_global_rules_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            script = CLI_IMPLEMENTATION.read_text().replace(
                "md=/etc/asip/MACHINE.md", "md=%s" % (root / "MACHINE.md")
            )
            executable = root / "asip"
            executable.write_text(script, encoding="utf-8")
            executable.chmod(0o755)
            (root / "MACHINE.md").write_text("# test\n", encoding="utf-8")
            env = dict(os.environ, HOME=str(root))
            command = [str(executable), "bootstrap", "--harness", "grok"]
            subprocess.run(command, cwd=root, env=env, check=True, stdout=subprocess.PIPE, text=True)
            target = root / ".grok" / "AGENTS.md"
            once = target.read_bytes()
            subprocess.run(command, cwd=root, env=env, check=True, stdout=subprocess.PIPE, text=True)
            self.assertEqual(target.read_bytes(), once)
            self.assertEqual(once.count(b"<!-- ASIP: BEGIN -->"), 1)
            self.assertIn(b"/etc/asip/MACHINE.md", once)

    def test_grok_bootstrap_registers_native_stdio_mcp_when_launchers_exist(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            script = CLI_IMPLEMENTATION.read_text().replace(
                "md=/etc/asip/MACHINE.md", "md=%s" % (root / "MACHINE.md")
            )
            executable = root / "asip"
            executable.write_text(script, encoding="utf-8")
            executable.chmod(0o755)
            (root / "MACHINE.md").write_text("# test\n", encoding="utf-8")
            bindir = root / "bin"
            bindir.mkdir()
            stub = bindir / "grok"
            log = root / "grok-mcp.log"
            stub.write_text(
                "#!/bin/sh\nprintf '%%s\\n' \"$*\" >>\"%s\"\n" % log, encoding="utf-8"
            )
            stub.chmod(0o755)
            launchers = root / ".local" / "bin"
            launchers.mkdir(parents=True)
            (launchers / "asip-mcp-inspect").write_text("#!/bin/sh\n", encoding="utf-8")
            (launchers / "asip-mcp-admin").write_text("#!/bin/sh\n", encoding="utf-8")
            (launchers / "asip-mcp-inspect").chmod(0o755)
            (launchers / "asip-mcp-admin").chmod(0o755)
            env = dict(os.environ, HOME=str(root), PATH="%s:%s" % (bindir, os.environ["PATH"]))
            command = [str(executable), "bootstrap", "--harness", "grok"]
            subprocess.run(command, cwd=root, env=env, check=True, stdout=subprocess.PIPE, text=True)
            subprocess.run(command, cwd=root, env=env, check=True, stdout=subprocess.PIPE, text=True)
            recorded = log.read_text(encoding="utf-8").splitlines()
            inspect = "mcp add asip-inspect -- %s/.local/bin/asip-mcp-inspect" % root
            admin = "mcp add asip-admin -- %s/.local/bin/asip-mcp-admin" % root
            self.assertEqual(recorded.count(inspect), 2)
            self.assertEqual(recorded.count(admin), 2)

    def test_mcp_config_is_stdio_and_does_not_edit_host_files(self):
        result = subprocess.run(
            [str(REPOSITORY / "asip"), "mcp", "config", "admin"],
            cwd=REPOSITORY,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
        self.assertEqual(
            result.stdout.strip(),
            '{"command":"%s/.local/bin/asip-mcp-admin","args":[],"transport":"stdio"}' % os.environ["HOME"],
        )

    def test_codex_bootstrap_registers_missing_native_stdio_mcp_once(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            script = CLI_IMPLEMENTATION.read_text().replace(
                "md=/etc/asip/MACHINE.md", "md=%s" % (root / "MACHINE.md")
            )
            executable = root / "asip"
            executable.write_text(script, encoding="utf-8")
            executable.chmod(0o755)
            (root / "MACHINE.md").write_text("# test\n", encoding="utf-8")
            bindir = root / "bin"
            bindir.mkdir()
            log = root / "codex-mcp.log"
            state = root / "codex-state"
            stub = bindir / "codex"
            stub.write_text(
                "#!/bin/sh\n"
                "if [ \"$1 $2\" = \"mcp get\" ]; then grep -qx \"$3\" \"%s\" 2>/dev/null; exit $?; fi\n"
                "printf '%%s\\n' \"$*\" >>\"%s\"\n"
                "printf '%%s\\n' \"$3\" >>\"%s\"\n" % (state, log, state),
                encoding="utf-8",
            )
            stub.chmod(0o755)
            launchers = root / ".local" / "bin"
            launchers.mkdir(parents=True)
            for name in ("asip-mcp-inspect", "asip-mcp-admin"):
                (launchers / name).write_text("#!/bin/sh\n", encoding="utf-8")
                (launchers / name).chmod(0o755)
            env = dict(os.environ, HOME=str(root), PATH="%s:%s" % (bindir, os.environ["PATH"]))
            command = [str(executable), "bootstrap", "--harness", "codex"]
            subprocess.run(command, cwd=root, env=env, check=True, stdout=subprocess.PIPE, text=True)
            subprocess.run(command, cwd=root, env=env, check=True, stdout=subprocess.PIPE, text=True)
            recorded = log.read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(recorded), 2)
            self.assertIn("mcp add asip-inspect", recorded[0])
            self.assertIn("mcp add asip-admin", recorded[1])

    @unittest.skipIf(
        os.geteuid() == 0,
        "MCP adapter installation is intentionally operator-only",
    )
    def test_mcp_install_is_idempotent_and_uses_an_isolated_user_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            home = root / "home"
            fake_bin = root / "bin"
            home.mkdir()
            fake_bin.mkdir()
            fake_python = fake_bin / "python3"
            fake_python.write_text(
                "#!/usr/bin/python3\n"
                "import pathlib, sys\n"
                "if sys.argv[1:2] == ['-c']:\n"
                "    print('314')\n"
                "    raise SystemExit(0)\n"
                "if sys.argv[1:3] != ['-m', 'venv']:\n"
                "    raise SystemExit(2)\n"
                "venv = pathlib.Path(sys.argv[3])\n"
                "(venv / 'bin').mkdir(parents=True, exist_ok=True)\n"
                "runtime = venv / 'bin' / 'python'\n"
                "runtime.write_text('#!/bin/sh\\nif [ \"$1\" = \"-c\" ]; then printf 2.1.0; fi\\n')\n"
                "runtime.chmod(0o755)\n"
                "for name in ('asip-mcp-inspect', 'asip-mcp-admin'):\n"
                "    target = venv / 'bin' / name\n"
                "    target.write_text(f'#!{runtime}\\n')\n"
                "    target.chmod(0o755)\n",
                encoding="utf-8",
            )
            fake_python.chmod(0o755)
            env = dict(os.environ, HOME=str(home),
                       PATH=f"{fake_bin}:/usr/bin:/bin")
            for _ in range(2):
                result = subprocess.run(
                    [str(REPOSITORY / "asip"), "mcp", "install", str(REPOSITORY)],
                    cwd=REPOSITORY, env=env, text=True,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True,
                )
                self.assertIn("SDK 2.1.0", result.stdout)
            inspect_target = (home / ".local/bin/asip-mcp-inspect").resolve()
            admin_target = (home / ".local/bin/asip-mcp-admin").resolve()
            self.assertEqual(inspect_target.parent, admin_target.parent)
            self.assertEqual(inspect_target.name, "asip-mcp-inspect")
            self.assertEqual(admin_target.name, "asip-mcp-admin")
            self.assertEqual(inspect_target.parents[1].parent,
                             home / ".local/share/asip/mcp-envs")
            status = subprocess.run(
                [str(REPOSITORY / "asip"), "mcp", "status"], cwd=REPOSITORY,
                env=env, text=True, stdout=subprocess.PIPE, check=True,
            )
            self.assertIn("MCP adapter: installed", status.stdout)

    def test_mcp_sdk_dependency_is_pinned_for_first_install(self):
        packaging = (REPOSITORY / "pyproject.toml").read_text(encoding="utf-8")
        self.assertIn('dependencies = ["mcp==2.0.0"]', packaging)
        script = CLI_IMPLEMENTATION.read_text(encoding="utf-8")
        self.assertIn("--upgrade 'mcp==2.0.0'", script)
        self.assertIn("--force-reinstall --no-deps", script)
        gate = (REPOSITORY / "scripts" / "release_gate.sh").read_text(encoding="utf-8")
        self.assertIn(".local/bin/asip-mcp-inspect", gate)
        self.assertIn("managed_mcp_python", gate)

    def test_nested_help_prints_usage_and_does_not_need_a_daemon(self):
        for args in (
            ["change", "start", "--help"],
            ["change", "hold", "--help"],
            ["change", "release", "--help"],
            ["change", "finish", "--help"],
            ["change", "show", "--help"],
            ["change", "list", "--help"],
            ["change", "--help"],
            ["verify", "--help"],
            ["verify", "pass", "--help"],
            ["snap", "--help"],
            ["conf", "--help"],
            ["do", "--help"],
            ["pkg", "--help"],
            ["context", "--help"],
            ["summary", "--help"],
            ["maintenance", "--help"],
        ):
            result = subprocess.run(
                [str(REPOSITORY / "asip"), *args],
                cwd=REPOSITORY, text=True,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            self.assertEqual(result.returncode, 0, args)
            self.assertIn("Usage:", result.stdout)
            self.assertNotIn("permission denied", result.stderr.lower())

    def test_change_status_cli_points_to_show(self):
        result = subprocess.run(
            [str(REPOSITORY / "asip"), "change", "status"],
            cwd=REPOSITORY, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.assertEqual(result.returncode, 64)
        self.assertIn("change show", result.stderr)
        self.assertIn("change open", result.stderr)
        self.assertIn("change list", result.stderr)

    @unittest.skipIf(os.geteuid() == 0, "root can reach both ASIP sockets")
    def test_socket_permission_error_states_current_groups_and_harness_guidance(self):
        groups = subprocess.run(["id", "-nG"], text=True, stdout=subprocess.PIPE, check=True)
        if "asip-read" in groups.stdout.split():
            self.skipTest("this process already has asip-read")
        result = subprocess.run(
            [str(REPOSITORY / "asip"), "context"],
            cwd=REPOSITORY, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.assertEqual(result.returncode, 77)
        self.assertIn("login or harness", result.stderr)
        self.assertIn("confined runner", result.stderr)
        self.assertIn("effective groups=", result.stderr)
        self.assertIn("account groups=", result.stderr)
        self.assertIn("process token", result.stderr)

    def test_readonly_requests_use_privileged_socket_when_only_asip_is_effective(self):
        script = CLI_IMPLEMENTATION.read_text(encoding="utf-8")
        helper = script.split("request_readonly() {", 1)[1].split("\n}\n", 1)[0]
        self.assertIn("/run/asip/read.sock", helper)
        self.assertIn('*" asip "*) socket=/run/asip/sock', helper)


if __name__ == "__main__":
    unittest.main()

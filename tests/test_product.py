import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile
from unittest import mock

from cli import release as asip_release
from cli import support as asip_support
from cli import telemetry as asip_telemetry
from cli import telemetry_server as asip_telemetry_server
from core import daemon as asipd


REPOSITORY = pathlib.Path(__file__).resolve().parents[1]


class BoundedRunnerTestCase(unittest.TestCase):
    def run_runner(self, *arguments, check=False):
        return subprocess.run(
            [sys.executable, str(REPOSITORY / "scripts" / "run_bounded.py"),
             *map(str, arguments)],
            cwd=REPOSITORY, text=True, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, check=check, timeout=5,
        )

    def test_runner_returns_command_status(self):
        result = self.run_runner("--timeout", "2", "--", sys.executable, "-c", "print('ok')")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), "ok")

    def test_runner_terminates_a_timed_out_process_group(self):
        result = self.run_runner(
            "--timeout", "0.1", "--grace", "0.1", "--", sys.executable,
            "-c", "import time; time.sleep(30)",
        )
        self.assertEqual(result.returncode, 124)
        self.assertIn("terminating process group", result.stderr)


class WheelhouseLockTestCase(unittest.TestCase):
    def make_wheel(self, directory, name="Example_Package", version="1.2.3"):
        wheel = directory / f"{name}-{version}-py3-none-any.whl"
        with zipfile.ZipFile(wheel, "w") as archive:
            archive.writestr(
                f"{name}-{version}.dist-info/METADATA",
                f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n",
            )
        return wheel

    def run_helper(self, *arguments, check=True):
        return subprocess.run(
            ["python3", str(REPOSITORY / "scripts" / "wheelhouse_lock.py"),
             *map(str, arguments)],
            cwd=REPOSITORY, text=True, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, check=check,
        )

    def test_lock_is_exact_and_verifies_the_wheel_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            wheels = root / "wheels"
            wheels.mkdir()
            wheel = self.make_wheel(wheels)
            lock = root / "requirements.lock"
            created = self.run_helper("create", wheels, lock, "--target", "test")
            self.assertEqual(json.loads(created.stdout)["packages"], 1)
            self.assertRegex(
                lock.read_text(encoding="utf-8"),
                r"example-package==1\.2\.3 --hash=sha256:[0-9a-f]{64}",
            )
            verified = self.run_helper("verify", wheels, lock)
            self.assertEqual(json.loads(verified.stdout)["status"], "pass")
            with wheel.open("ab") as stream:
                stream.write(b"tampered")
            rejected = self.run_helper("verify", wheels, lock, check=False)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("mismatched=['example-package']", rejected.stderr)


class QualificationRecordTestCase(unittest.TestCase):
    def make_candidate(self, root):
        artifact = root / "asip-1.0.0.tar.gz"
        members = {
            "asip-1.0.0/a": b"a",
            "asip-1.0.0/asip": b"asip",
            "asip-1.0.0/install.sh": b"install",
            "asip-1.0.0/README.md": b"readme",
            "asip-1.0.0/INSTALL.md": b"install docs",
            "asip-1.0.0/UPGRADE.md": b"upgrade docs",
            "asip-1.0.0/UNINSTALL.md": b"uninstall docs",
            "asip-1.0.0/LICENSE": b"Apache-2.0",
            "asip-1.0.0/SECURITY.md": b"security model",
            "asip-1.0.0/scripts/restore_install_backup.sh": b"restore",
            "asip-1.0.0/scripts/uninstall_software.sh": b"uninstall",
            "asip-1.0.0/wheelhouse/SHA256SUMS": b"digest  wheel\n",
            "asip-1.0.0/wheelhouse/common/asip_mcp.whl": b"wheel",
            "asip-1.0.0/wheelhouse/py312-linux-x86_64/sdk.whl": b"wheel",
            "asip-1.0.0/wheelhouse/py313-linux-x86_64/sdk.whl": b"wheel",
            "asip-1.0.0/wheelhouse/py314-linux-x86_64/sdk.whl": b"wheel",
            "asip-1.0.0/requirements/mcp-py312-linux-x86_64.lock": b"lock",
            "asip-1.0.0/requirements/mcp-py313-linux-x86_64.lock": b"lock",
            "asip-1.0.0/requirements/mcp-py314-linux-x86_64.lock": b"lock",
        }
        with tarfile.open(artifact, "w:gz") as archive:
            for name, content in members.items():
                info = tarfile.TarInfo(name)
                info.size = len(content)
                archive.addfile(info, __import__("io").BytesIO(content))
        manifest = root / "release.json"
        manifest.write_text(json.dumps({
            "schema_version": 1,
            "version": "1.0.0",
            "artifact": artifact.name,
            "sha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
            "mcp_wheelhouse": True,
        }), encoding="utf-8")
        return artifact, manifest

    def run_recorder(self, *arguments, check=True):
        return subprocess.run(
            ["python3", str(REPOSITORY / "scripts" / "qualification.py"),
             *map(str, arguments)],
            cwd=REPOSITORY, text=True, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, check=check,
        )

    def test_result_is_bounded_machine_readable_and_requires_every_phase(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            artifact, manifest = self.make_candidate(root)
            result_path = root / "result.json"
            self.run_recorder(
                "init", "--artifact", artifact, "--manifest", manifest,
                "--output", result_path,
            )
            result = json.loads(result_path.read_text(encoding="utf-8"))
            self.assertEqual(result["schema_version"], 1)
            self.assertEqual(len(result["phases"]), 13)
            self.assertFalse(result["privacy"]["raw_journal_recorded"])
            self.assertEqual(result_path.stat().st_mode & 0o777, 0o600)
            for phase in result["phases"]:
                self.run_recorder(
                    "record", "--result", result_path, "--phase", phase["id"],
                    "--status", "pass", "--evidence", "checks=1",
                )
            finalized = self.run_recorder("finalize", "--result", result_path)
            self.assertEqual(json.loads(finalized.stdout)["status"], "pass")
            rendered = self.run_recorder("render", "--result", result_path)
            self.assertIn("Overall: **pass**", rendered.stdout)

    def test_result_rejects_sensitive_evidence_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            artifact, manifest = self.make_candidate(root)
            result_path = root / "result.json"
            self.run_recorder(
                "init", "--artifact", artifact, "--manifest", manifest,
                "--output", result_path,
            )
            rejected = self.run_recorder(
                "record", "--result", result_path, "--phase", "bootstrap",
                "--status", "pass", "--evidence", "command_output=secret",
                check=False,
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("unsafe evidence field", rejected.stderr)


class ProductSummaryTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.temp.name)
        self.state = root / "state"
        self.patches = [
            mock.patch.object(asipd, "STATE", self.state),
            mock.patch.object(asipd, "JOURNAL", self.state / "journal.jsonl"),
            mock.patch.object(asipd, "BLOBS", self.state / "blobs"),
            mock.patch.object(asipd, "MACHINE", root / "etc" / "MACHINE.md"),
            mock.patch.object(asipd, "PROJECTS", root / "etc" / "projects.md"),
            mock.patch.object(asipd, "DRIFT_DECISIONS", root / "etc" / "drift.md"),
            mock.patch.object(asipd, "set_group_access", lambda path, mode: None),
            mock.patch.object(asipd, "snapshot_command", return_value=(None, "none")),
        ]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in reversed(self.patches):
            patch.stop()
        self.temp.cleanup()

    def test_summary_aggregates_changes_without_raw_operation_fields(self):
        asipd.append_record({
            "id": "change-1", "at": "2026-08-08T12:00:00+00:00", "uid": 1000,
            "op": "change", "action": "start", "intent": "Repair the microphone",
        })
        asipd.append_record({
            "id": "operation-1", "at": "2026-08-08T12:01:00+00:00", "uid": 1000,
            "op": "do", "state": "started", "argv": ["secret-command"],
            "change_id": "change-1",
        })
        asipd.append_record({
            "id": "operation-1", "at": "2026-08-08T12:02:00+00:00", "uid": 1000,
            "op": "do", "state": "finished", "argv": ["secret-command"],
            "change_id": "change-1", "exit": 0,
        })
        asipd.append_record({
            "id": "verify-1", "at": "2026-08-08T12:03:00+00:00", "uid": 1000,
            "op": "verify", "tool": "microphone", "result": "pass",
            "reason": "ALSA exposed the internal microphone", "change_id": "change-1",
        })
        asipd.append_record({
            "id": "change-failed", "at": "2026-08-08T12:04:00+00:00", "uid": 1000,
            "op": "change", "action": "start", "intent": "A failed experiment",
        })
        asipd.append_record({
            "id": "finish-1", "at": "2026-08-08T12:05:00+00:00", "uid": 1000,
            "op": "change", "action": "finish", "change_id": "change-1",
            "summary": "Microphone repaired",
        })
        asipd.append_record({
            "id": "fail-1", "at": "2026-08-08T12:06:00+00:00", "uid": 1000,
            "op": "change", "action": "fail", "change_id": "change-failed",
            "summary": "The experiment was abandoned",
        })
        data = asipd.product_summary_data({"_peer_uid": 1000})
        self.assertEqual(data["statistics"]["completed_changes"], 1)
        self.assertEqual(data["statistics"]["failed_changes"], 1)
        self.assertEqual(data["statistics"]["privileged_operations"], 1)
        self.assertEqual(data["statistics"]["verification_pass"], 1)
        self.assertEqual(data["statistics"]["open_changes"], 0)
        self.assertEqual(data["recent_changes"][0]["intent"], "Repair the microphone")
        self.assertEqual(data["latest_verification"][0]["result"], "pass")
        self.assertNotIn("argv", json.dumps(data))
        self.assertNotIn("secret-command", json.dumps(data))


class ReleaseTestCase(unittest.TestCase):
    def test_release_discovery_requires_public_payload_files_only(self):
        required = set(asip_release.REQUIRED_ARTIFACT_FILES)
        product = set(asip_release.PRODUCT_ARTIFACT_FILES)
        self.assertTrue({"LICENSE", "README.md", "SECURITY.md", "SUPPORT.md"} <= required)
        self.assertIn("docs/ARCHITECTURE.md", product)
        self.assertNotIn("docs/release", product)

    def make_artifact(self, root):
        artifact = root / "asip-release.tar"
        with tarfile.open(artifact, "w") as archive:
            for name in asip_release.REQUIRED_ARTIFACT_FILES:
                archive.add(REPOSITORY / name, arcname=name)
        return artifact

    def test_local_manifest_checks_digest_and_safely_prepares_release(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            artifact = self.make_artifact(root)
            manifest = root / "release.json"
            manifest.write_text(json.dumps({
                "schema_version": 1, "version": "1.4.0",
                "artifact": artifact.name,
                "sha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
            }), encoding="utf-8")
            status = asip_release.check_status(
                manifest, installed_version="1.2.1", query_live=False
            )
            self.assertTrue(status["available"])
            self.assertEqual(status["installed_version"], "1.2.1")
            self.assertEqual(status["candidate_version"], "1.4.0")
            silent = asip_release.check_status(manifest, query_live=False)
            self.assertIsNone(silent["installed_version"])
            self.assertFalse(silent["available"])
            self.assertIn("unavailable", silent["message"])
            skewed = asip_release.check_status(
                manifest, client_version="9.9.9", installed_version="1.2.1",
                query_live=False,
            )
            self.assertTrue(skewed["available"])
            self.assertIn("differs", skewed["mismatch"])
            metadata = asip_release.load_metadata(manifest)
            staged = asip_release.prepare_artifact(metadata)
            try:
                self.assertTrue((staged / "asip").is_file())
                self.assertTrue((staged / "core" / "daemon.py").is_file())
            finally:
                import shutil
                shutil.rmtree(staged)

    def test_shared_release_stage_is_private_visible_and_has_cleanup_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            artifact = self.make_artifact(root)
            manifest = root / "release.json"
            manifest.write_text(json.dumps({
                "schema_version": 1, "version": "1.4.0",
                "artifact": artifact.name,
                "sha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
            }), encoding="utf-8")
            stage_parent = root / "shared-stage"
            metadata = asip_release.load_metadata(manifest)
            with mock.patch.dict(os.environ, {
                    "ASIP_RELEASE_STAGE_PARENT": str(stage_parent)}):
                prepared, cleanup_root = asip_release.prepare_shared_artifact(metadata)
            try:
                self.assertTrue((prepared / "asip").is_file())
                self.assertEqual(cleanup_root.parent, stage_parent)
                self.assertEqual(cleanup_root.stat().st_mode & 0o777, 0o700)
                self.assertNotEqual(cleanup_root.parent, pathlib.Path(tempfile.gettempdir()))
            finally:
                shutil.rmtree(cleanup_root)

    def test_upgrade_check_cli_reports_fixture_without_mutating(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            artifact = self.make_artifact(root)
            manifest = root / "release.json"
            manifest.write_text(json.dumps({
                "schema_version": 1, "version": "1.4.0",
                "artifact": artifact.name,
                "sha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
            }), encoding="utf-8")
            result = subprocess.run(
                [str(REPOSITORY / "asip"), "upgrade", "--check"],
                cwd=REPOSITORY,
                env=dict(os.environ,
                         ASIP_RELEASE_METADATA=str(manifest),
                         ASIP_RELEASE_SOCKET_DIR=str(root / "empty-sockets")),
                text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True,
            )
            self.assertIn("Client/source version:", result.stdout)
            self.assertIn("Installed product: unavailable", result.stdout)
            self.assertIn("Candidate: 1.4.0", result.stdout)
            self.assertIn("Upgrade eligibility: unknown", result.stdout)
            self.assertNotIn("Upgrade available:", result.stdout)

    def test_upgrade_keeps_staged_artifact_until_privileged_request_consumes_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            for name in ("asip", "VERSION"):
                shutil.copy2(REPOSITORY / name, root / name)
            shutil.copytree(REPOSITORY / "core", root / "core")
            shutil.copytree(REPOSITORY / "cli", root / "cli")
            fake_client = root / "core" / "client.py"
            fake_client.write_text(
                "import os, pathlib, sys\n"
                "args = sys.argv[1:]\n"
                "op = args[args.index('--op') + 1]\n"
                "action = args[args.index('--action') + 1] if '--action' in args else None\n"
                "if op == 'change' and action == 'start':\n"
                "    print('change-fixture')\n"
                "elif op == 'summary':\n"
                "    print('{\\\"version\\\":\\\"1.3.0\\\"}')\n"
                "elif op == 'do':\n"
                "    executable = next(pathlib.Path(value) for value in args if value.endswith('/asip'))\n"
                "    if not executable.is_file():\n"
                "        raise SystemExit(89)\n"
                "    pathlib.Path(os.environ['ASIP_UPGRADE_TEST_MARKER']).write_text(str(executable.parent))\n",
                encoding="utf-8",
            )
            fake_client.chmod(0o755)
            artifact = self.make_artifact(root)
            manifest = root / "release.json"
            manifest.write_text(json.dumps({
                "schema_version": 1, "version": "1.4.0",
                "artifact": artifact.name,
                "sha256": hashlib.sha256(artifact.read_bytes()).hexdigest(),
            }), encoding="utf-8")
            marker = root / "consumed.txt"
            refused = subprocess.run(
                [str(root / "asip"), "upgrade"], cwd=root,
                env=dict(os.environ, HOME=str(root),
                         ASIP_RELEASE_METADATA=str(manifest),
                         ASIP_RELEASE_SOCKET_DIR=str(root / "empty-sockets"),
                         ASIP_UPGRADE_TEST_MARKER=str(marker)),
                text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
            )
            self.assertNotEqual(refused.returncode, 0)
            self.assertIn("will not treat this checkout as installed", refused.stderr)
            metadata = asip_release.load_metadata(manifest)
            staged = asip_release.prepare_artifact(metadata)
            try:
                self.assertTrue((staged / "asip").is_file())
                result = subprocess.run(
                    [str(root / "asip"), "--standalone", "test consume staged artifact",
                     "do", "--", str(staged / "asip"), "true"],
                    cwd=root,
                    env=dict(os.environ, HOME=str(root),
                             ASIP_RELEASE_SOCKET_DIR=str(root / "empty-sockets"),
                             ASIP_UPGRADE_TEST_MARKER=str(marker)),
                    text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(pathlib.Path(marker.read_text(encoding="utf-8")), staged)
            finally:
                shutil.rmtree(staged, ignore_errors=True)

    def test_signature_field_is_ready_but_not_silently_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            artifact = self.make_artifact(root)
            metadata = asip_release.ReleaseMetadata(
                "1.1.0", artifact, hashlib.sha256(artifact.read_bytes()).hexdigest(),
                signature="future-signature", key_id="future-key",
            )
            with self.assertRaisesRegex(asip_release.ReleaseError, "signature"):
                asip_release.verify_artifact(metadata)

    def test_digest_mismatch_and_unsafe_archive_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            artifact = self.make_artifact(root)
            wrong = asip_release.ReleaseMetadata("1.1.0", artifact, "0" * 64)
            with self.assertRaisesRegex(asip_release.ReleaseError, "mismatch"):
                asip_release.verify_artifact(wrong)
            unsafe = root / "unsafe.tar"
            with tarfile.open(unsafe, "w") as archive:
                info = tarfile.TarInfo("../escape")
                info.size = 4
                archive.addfile(info, __import__("io").BytesIO(b"oops"))
            metadata = asip_release.ReleaseMetadata(
                "1.1.0", unsafe, hashlib.sha256(unsafe.read_bytes()).hexdigest()
            )
            with self.assertRaisesRegex(asip_release.ReleaseError, "unsafe path"):
                asip_release.prepare_artifact(metadata)

    def test_release_builder_is_reproducible_and_offline_verifiable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            outputs = []
            for name in ("one", "two"):
                destination = root / name
                subprocess.run(
                    [str(REPOSITORY / "scripts" / "build_release.sh"), str(destination)],
                    cwd=REPOSITORY,
                    env=dict(os.environ, SOURCE_DATE_EPOCH="0"),
                    text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True,
                )
                manifest = destination / "release.json"
                metadata = asip_release.load_metadata(manifest)
                asip_release.verify_artifact(metadata)
                outputs.append((metadata.artifact.read_bytes(), json.loads(manifest.read_text())))
            self.assertEqual(outputs[0], outputs[1])
            version = (REPOSITORY / "VERSION").read_text(encoding="utf-8").strip()
            prefix = f"asip-{version}"
            with tarfile.open(root / "one" / f"{prefix}.tar.gz") as archive:
                names = archive.getnames()
            self.assertEqual(outputs[0][1]["version"], version)
            self.assertEqual(outputs[0][1]["artifact"], f"{prefix}.tar.gz")
            self.assertEqual(outputs[0][1]["release_channel"], "public-preview")
            self.assertEqual(outputs[0][1]["build_epoch"], 0)
            self.assertRegex(outputs[0][1]["source_commit"], r"^[0-9a-f]{40}$")
            self.assertEqual(
                outputs[0][1]["supported_platforms"],
                ["fedora-44-x86_64"],
            )
            self.assertIn(f"{prefix}/asip", names)
            self.assertIn(f"{prefix}/SUPPORT.md", names)
            self.assertIn(f"{prefix}/LICENSE", names)
            self.assertIn(f"{prefix}/SECURITY.md", names)
            self.assertIn(f"{prefix}/RELEASE_NOTES.md", names)
            self.assertNotIn(f"{prefix}/ROAD_TO_RELEASE.md", names)
            self.assertFalse(any(name.startswith(f"{prefix}/tests/") for name in names))
            self.assertFalse(any(name.startswith(f"{prefix}/qualification/") for name in names))
            self.assertIn(f"{prefix}/cli/eval.py", names)
            self.assertIn(f"{prefix}/cli/asip.sh", names)
            self.assertIn(f"{prefix}/docs/ARCHITECTURE.md", names)
            self.assertTrue(any(name.startswith(f"{prefix}/eval/cases/") for name in names))
            self.assertFalse(any("/__pycache__/" in name or name.endswith((".pyc", ".pyo")) for name in names))
            self.assertIn(f"{prefix}/eval/suites/authority-v1.json", names)
            self.assertIn(f"{prefix}/eval/trajectory.schema.json", names)
            self.assertIn(
                f"{prefix}/requirements/mcp-py313-linux-x86_64.lock", names
            )
            self.assertIn(
                f"{prefix}/requirements/mcp-py314-linux-x86_64.lock", names
            )
            self.assertNotIn(f"{prefix}/requirements/fleet.in", names)
            self.assertFalse(any(name.startswith(f"{prefix}/fleet/") for name in names))
            self.assertFalse(any(name.startswith(f"{prefix}/desktop/") for name in names))
            self.assertFalse(any(name.startswith(f"{prefix}/docs/fleet/") for name in names))
            self.assertFalse(any(name.startswith(f"{prefix}/docs/desktop/") for name in names))
            self.assertNotIn(f"{prefix}/wheelhouse-fleet/SHA256SUMS", names)
            self.assertFalse(outputs[0][1]["mcp_wheelhouse"])

    def test_product_release_builder_requires_and_embeds_mcp_wheelhouse(self):
        if not (REPOSITORY / "wheelhouse").is_dir():
            self.skipTest("product wheelhouses are built by the release workflow")
        with tempfile.TemporaryDirectory() as directory:
            destination = pathlib.Path(directory) / "product"
            subprocess.run(
                [str(REPOSITORY / "scripts" / "build_release.sh"), "--product", str(destination)],
                cwd=REPOSITORY,
                env=dict(os.environ, SOURCE_DATE_EPOCH="0"),
                text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True,
            )
            manifest = json.loads((destination / "release.json").read_text(encoding="utf-8"))
            self.assertTrue(manifest["mcp_wheelhouse"])
            metadata = asip_release.load_metadata(destination / "release.json")
            asip_release.verify_artifact(metadata)
            with tarfile.open(metadata.artifact) as archive:
                names = archive.getnames()
            prefix = f"asip-{manifest['version']}"
            self.assertIn(f"{prefix}/wheelhouse/SHA256SUMS", names)
            self.assertFalse(any(name.startswith(f"{prefix}/wheelhouse-fleet/") for name in names))
            self.assertIn(f"{prefix}/INSTALL.md", names)
            self.assertIn(f"{prefix}/scripts/restore_install_backup.sh", names)
            self.assertIn(f"{prefix}/scripts/uninstall_software.sh", names)


class SupportDiagnosticTestCase(unittest.TestCase):
    SUMMARY = {
        "version": "1.0.0",
        "platform": {"distribution": "Test Linux", "distro_family": "test"},
        "health": {"read_socket": "healthy", "snapshotter": "none",
                   "recovery": "not configured", "machine": "healthy"},
        "statistics": {"completed_changes": 2, "failed_changes": 1,
                       "open_changes": 0, "privileged_operations": 3,
                       "configuration_changes": 1, "snapshots": 0,
                       "rollbacks": 0, "verification_pass": 4,
                       "verification_fail": 1, "incomplete_operations": 0},
        "recent_changes": [{"intent": "private intent", "argv": ["secret"]}],
        "latest_verification": [{"reason": "private reason"}],
    }

    def test_diagnostic_is_allowlisted_and_explicitly_redacted(self):
        diagnostic = asip_support.build_diagnostic(
            self.SUMMARY,
            unit_reader=lambda _name: "active",
            socket_reader=lambda _path, _group: {
                "exists": True, "mode": "0660", "root_owned": True,
                "group_expected": True,
            },
        )
        encoded = json.dumps(diagnostic)
        self.assertEqual(diagnostic["statistics"]["privileged_operations"], 3)
        self.assertNotIn("private intent", encoded)
        self.assertNotIn("private reason", encoded)
        self.assertNotIn("secret", encoded)
        self.assertEqual(diagnostic["redaction"]["journal_records"], "excluded")
        self.assertIn("installation", diagnostic)
        self.assertIn("restore_helper", diagnostic["installation"])
        self.assertNotIn("fleet_units", diagnostic)
        self.assertNotIn("desktop_entry", diagnostic["installation"])

    def test_written_diagnostic_is_private(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = pathlib.Path(directory) / "support.json"
            asip_support.write_diagnostic(destination, {"schema_version": 1})
            self.assertEqual(destination.stat().st_mode & 0o777, 0o600)


class TelemetryTestCase(unittest.TestCase):
    SUMMARY = {
        "version": "1.0.0",
        "platform": {"distro_family": "fedora", "distribution": "Fedora"},
        "health": {"snapshotter": "snapper"},
        "statistics": {
            "completed_changes": 4, "failed_changes": 1,
            "privileged_operations": 7, "configuration_changes": 2,
            "snapshots": 5, "rollbacks": 1, "verification_pass": 8,
            "verification_fail": 1, "incomplete_operations": 0,
            "intent": "must not leak",
        },
        "recent_changes": [{"intent": "must not leak"}],
    }

    def test_payload_is_opt_in_inspectable_and_aggregate_only(self):
        state = asip_telemetry.default_state()
        payload = asip_telemetry.build_payload(
            self.SUMMARY, state,
            now=lambda: __import__("datetime").datetime(2026, 8, 8, tzinfo=__import__("datetime").timezone.utc),
        )
        self.assertRegex(payload["installation_id"], r"^[0-9a-f-]{36}$")
        self.assertEqual(payload["report_window"], "2026-08-08")
        self.assertEqual(payload["metrics"]["privileged_operations"], 7)
        self.assertNotIn("intent", json.dumps(payload))
        self.assertEqual(set(payload), {"schema_version", "installation_id", "report_window", "metrics"})

    def test_enable_disable_persist_without_network(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(
            "os.environ", {"ASIP_TELEMETRY_STATE": str(pathlib.Path(directory) / "telemetry.json")}
        ):
            asip_telemetry.main(["enable"], summary_reader=lambda: self.SUMMARY)
            enabled = asip_telemetry.load_state()
            self.assertTrue(enabled["enabled"])
            self.assertTrue(enabled["installation_id"])
            asip_telemetry.main(["disable"], summary_reader=lambda: self.SUMMARY)
            self.assertFalse(asip_telemetry.load_state()["enabled"])

    def test_send_transport_is_explicit_and_posts_only_whitelisted_payload(self):
        state = asip_telemetry.default_state()
        payload = asip_telemetry.build_payload(self.SUMMARY, state)

        class Response:
            status = 201

            @staticmethod
            def read():
                return b'{"ok": true, "status": "accepted"}'

        opener = mock.Mock(return_value=Response())
        result = asip_telemetry.send_payload(payload, "http://127.0.0.1:8765/v1/telemetry", opener=opener)
        self.assertEqual(result["status"], "accepted")
        request = opener.call_args.args[0]
        self.assertEqual(json.loads(request.data), payload)
        self.assertNotIn("intent", request.data.decode("utf-8"))


class TelemetryServerTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = pathlib.Path(self.temp.name) / "collector.json"
        self.payload = {
            "schema_version": 1,
            "installation_id": "11111111-1111-1111-1111-111111111111",
            "report_window": "2026-08-08",
            "metrics": {
                "asip_version": "1.0.0", "distro_family": "fedora",
                "snapshot_backend": "snapper", "completed_changes": 4,
                "failed_changes": 1, "privileged_operations": 7,
                "configuration_changes": 2, "snapshots": 5, "rollbacks": 1,
                "verification_pass": 8, "verification_fail": 1,
                "incomplete_operations": 0,
            },
        }

    def tearDown(self):
        self.temp.cleanup()

    def test_collector_accepts_aggregate_payload_once_and_aggregates_latest(self):
        store = asip_telemetry_server.TelemetryStore(self.path)
        self.assertEqual(store.ingest(self.payload)[0], "accepted")
        self.assertEqual(store.ingest(self.payload)[0], "duplicate")
        summary = store.summary()
        self.assertEqual(summary["participating_installations"], 1)
        self.assertEqual(summary["accepted_report_windows"], 1)
        self.assertEqual(summary["metrics"]["completed_changes"], 4)
        self.assertNotIn("intent", json.dumps(summary))
        self.assertEqual((self.path.stat().st_mode & 0o777), 0o600)

    def test_collector_rejects_raw_or_unknown_fields(self):
        invalid = json.loads(json.dumps(self.payload))
        invalid["intent"] = "secret"
        with self.assertRaisesRegex(asip_telemetry_server.TelemetryError, "outside"):
            asip_telemetry_server.validate_payload(invalid)

    def test_collector_binds_loopback_only(self):
        with mock.patch.object(asip_telemetry_server, "TelemetryHTTPServer") as constructor:
            result = asip_telemetry_server.make_server(8765, self.path)
            constructor.assert_called_once()
            self.assertEqual(constructor.call_args.args[0], ("127.0.0.1", 8765))
            self.assertIs(result, constructor.return_value)


if __name__ == "__main__":
    unittest.main()

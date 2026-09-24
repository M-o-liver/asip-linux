import hashlib
import io
import json
import pathlib
import tarfile
import tempfile
import unittest

from installer.distro import detect
from installer.privileged_helper import verify_private_payload
from installer.staging import StageError, stage_payload, verify_payload


class DistroTestCase(unittest.TestCase):
    def test_supported_distribution_families_are_centralized(self):
        cases = {"fedora": ("fedora", "dnf"), "ubuntu": ("debian", "apt-get"),
                 "debian": ("debian", "apt-get"), "cachyos": ("arch", "pacman"),
                 "arch": ("arch", "pacman")}
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "os-release"
            for distro_id, expected in cases.items():
                path.write_text(f'ID={distro_id}\nPRETTY_NAME="Test"\n')
                result = detect(path)
                self.assertEqual((result.family, result.package_manager), expected)
                self.assertTrue(result.supported)

    def test_derivative_is_detected_but_not_advertised_as_supported(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "os-release"
            path.write_text('ID=unknown\nID_LIKE="arch"\nPRETTY_NAME="A derivative"\n')
            self.assertFalse(detect(path).supported)

    def test_supported_host_python_matrix_includes_debian_and_arch_runtime(self):
        source = (pathlib.Path(__file__).resolve().parents[1] / "installer" / "distro.py").read_text()
        self.assertIn('{"312", "313", "314"}', source)


class StagingTestCase(unittest.TestCase):
    def _payload(self, root: pathlib.Path, unsafe: bool = False):
        version = "2.3.0"
        artifact = root / f"asip-{version}.tar.gz"
        files = {
            f"asip-{version}/asip": b"#!/bin/sh\n",
            f"asip-{version}/VERSION": b"2.3.0\n",
            f"asip-{version}/core/daemon.py": b"",
            f"asip-{version}/wheelhouse/SHA256SUMS": b"",
        }
        if unsafe:
            files["../escape"] = b"bad"
        with tarfile.open(artifact, "w:gz") as archive:
            for name, content in files.items():
                info = tarfile.TarInfo(name); info.size = len(content); info.mode = 0o755
                archive.addfile(info, io.BytesIO(content))
        digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
        manifest = root / "release.json"
        manifest.write_text(json.dumps({"schema_version": 1, "artifact": artifact.name,
                                        "version": version, "source_commit": "a" * 40,
                                        "sha256": digest}))
        return artifact, manifest

    def test_staged_payload_is_reverified_and_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); artifact, manifest = self._payload(root)
            stage = stage_payload(artifact, manifest, root / "stage")
            self.assertFalse((stage / "asip-2.3.0").exists())
            self.assertFalse((stage / "privileged_helper.py").exists())
            self.assertEqual(json.loads((stage / "STAGED").read_text())["sha256"],
                             hashlib.sha256(artifact.read_bytes()).hexdigest())
            app = (pathlib.Path(__file__).resolve().parents[1] / "installer" / "app.py").read_text()
            self.assertIn('"-I", "-c", helper_source', app)
            self.assertNotIn('helper = self.stage / "privileged_helper.py"', app)
            self.assertEqual(verify_payload(stage / artifact.name, stage / "release.json")["version"], "2.3.0")

    def test_digest_and_archive_traversal_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); artifact, manifest = self._payload(root, unsafe=True)
            with self.assertRaisesRegex(StageError, "unsafe path"):
                verify_payload(artifact, manifest)
            artifact, manifest = self._payload(root)
            artifact.write_bytes(artifact.read_bytes() + b"tamper")
            with self.assertRaisesRegex(StageError, "digest"):
                verify_payload(artifact, manifest)

    def test_privileged_helper_independently_validates_its_private_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory); artifact, manifest = self._payload(root)
            self.assertEqual(verify_private_payload(artifact, manifest)["version"], "2.3.0")
            value = json.loads(manifest.read_text())
            value["artifact"] = "../" + artifact.name
            manifest.write_text(json.dumps(value))
            with self.assertRaisesRegex(ValueError, "different payload"):
                verify_private_payload(artifact, manifest)

    def test_appimage_digest_is_relocatable_and_release_is_gated(self):
        root = pathlib.Path(__file__).resolve().parents[1]
        build = (root / "packaging" / "appimage" / "build.sh").read_text()
        self.assertIn('sha256sum "$(basename -- "$output")"', build)
        launcher = (root / "installer" / "asip-installer").read_text()
        self.assertIn('XDG_DATA_DIRS="${XDG_DATA_DIRS:-}"', launcher)
        workflow = (root / ".github" / "workflows" / "release.yml").read_text()
        self.assertIn("needs: qualification", workflow)
        self.assertIn("uses: ./.github/workflows/test.yml", workflow)
        self.assertIn('cd "$(dirname "$image")"', workflow)
        self.assertIn("Publish GitHub Release assets", workflow)
        self.assertIn("gh release create", workflow)
        self.assertIn("contents: write", workflow)
        self.assertIn('"release/asip-${version}.tar.gz"', workflow)
        self.assertNotIn("CLOUDFLARE_API_TOKEN", workflow)
        self.assertNotIn("downloads.asip.ca", workflow)

    def test_systemd_daemons_restart_after_failure(self):
        root = pathlib.Path(__file__).resolve().parents[1]
        for unit in ("asip.service", "asip-read.service"):
            content = (root / "systemd" / unit).read_text()
            self.assertIn("Restart=on-failure", content)
            self.assertIn("RestartSec=2s", content)

    def test_same_version_reinstall_refreshes_read_only_daemon_without_restarting_admin_lane(self):
        root = pathlib.Path(__file__).resolve().parents[1]
        installer = (root / "cli" / "asip.sh").read_text()
        branch = installer.split("elif systemctl is-active --quiet asip.service; then", 1)[1]
        branch = branch.split("\n\telse\n", 1)[0]
        self.assertIn("systemctl try-restart asip-read.service", branch)
        self.assertNotIn("systemctl restart asip.service", branch)


if __name__ == "__main__":
    unittest.main()

"""Exercise retired entry points and the state that must survive removal."""

from contextlib import ExitStack
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from core import daemon
from core.protocol import is_read_only
from desktop.backend import DesktopBackend
from desktop.state import DesktopState


ROOT = Path(__file__).resolve().parents[1]


class FeatureRetirementTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.directory = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        for name, filename in {
            "STATE": "state", "JOURNAL": "journal.jsonl", "BLOBS": "blobs",
            "ACCESS_DIR": "access", "MACHINE": "MACHINE.md",
            "PROJECTS": "projects.md", "DRIFT_DECISIONS": "drift.md",
        }.items():
            self.stack.enter_context(patch.object(daemon, name, self.directory / filename))
        self.stack.enter_context(patch.object(daemon, "_REF_CACHE", None))
        self.stack.enter_context(patch.object(daemon, "set_group_access", os.chmod))
        self.stack.enter_context(patch.object(daemon, "asip_gid", return_value=os.getgid()))

    def test_retired_cli_commands_fail_before_socket_access(self):
        for launcher in ("asip", "asip-inspect"):
            with self.subTest(launcher=launcher):
                result = subprocess.run(
                    [str(ROOT / launcher), "maintenance", "list"],
                    capture_output=True, text=True, check=False, timeout=5,
                )
                self.assertIn(result.returncode, (1, 64))
                help_result = subprocess.run(
                    [str(ROOT / launcher), "--help"],
                    capture_output=True, text=True, check=True, timeout=5,
                )
                self.assertNotIn("maintenance", help_result.stdout.lower())

    def test_retired_requests_cannot_read_or_execute(self):
        with patch.object(daemon, "execute") as execute:
            for action in ("list", "history", "open", "policy", "backfill", "omit",
                           "unomit", "start", "finish", "fail"):
                with self.subTest(action=action):
                    request = {
                        "op": "maintenance", "action": action, "argv": ["legacy-task"],
                        "standalone_reason": "Test retired operation",
                    }
                    self.assertFalse(is_read_only(request))
                    self.assertFalse(daemon.handle_read_only(request)["ok"])
                    response = daemon.handle(request)
                    self.assertFalse(response["ok"])
                    self.assertEqual(response["error"]["message"], "unknown operation")
            execute.assert_not_called()
        self.assertFalse(daemon.JOURNAL.exists())

    def test_old_journal_records_remain_readable_and_unchanged(self):
        record = {
            "id": "11111111-1111-4111-8111-111111111111",
            "at": "2026-10-01T12:00:00+00:00", "uid": 1000,
            "op": "maintenance", "action": "start", "tasks": ["package-maintenance"],
        }
        original = (json.dumps(record) + "\n").encode()
        daemon.JOURNAL.write_bytes(original)
        response = daemon.handle_read_only({"op": "journal-search", "argv": []})
        self.assertTrue(response["ok"])
        self.assertEqual(response["data"]["records"], [record])
        log = daemon.handle_read_only({"op": "log", "argv": [record["id"]]})
        self.assertTrue(log["ok"])
        self.assertIn("package-maintenance", log["stdout"])
        self.assertEqual(daemon.JOURNAL.read_bytes(), original)

    def test_api_credentials_can_still_be_provisioned_and_inspected(self):
        secret = "test-only-api-credential"
        response = daemon.handle({
            "op": "access", "action": "provision", "argv": ["example.api"],
            "label": "Example API", "env_var": "EXAMPLE_API_KEY", "value": secret,
            "_peer_uid": os.getuid(),
        })
        self.assertTrue(response["ok"], response)
        response = daemon.handle_read_only({"op": "access", "action": "list"})
        self.assertTrue(response["ok"])
        self.assertEqual(response["data"]["available"], ["example.api"])
        self.assertNotIn(secret, json.dumps(response))
        self.assertNotIn(secret, daemon.JOURNAL.read_text())

    def test_recovery_still_maps_backend_snapshots_to_asip_handles(self):
        ident = "22222222-2222-4222-8222-222222222222"
        record = {"id": ident, "op": "snap", "state": "finished", "exit": 0,
                  "backend_id": "42", "snapshotter": "snapper"}
        with patch.object(daemon, "snapshot_command", return_value=([], "snapper")), \
             patch.object(daemon, "snapper_timeline", return_value={"snapshots": [{"number": "42"}]}):
            data = daemon.recovery_data(records=[record])
        self.assertTrue(data["supported"])
        self.assertEqual(data["journal_snapshots"][0]["recovery_handle"], ident)
        self.assertEqual(data["timeline"]["snapshots"][0]["recovery_handle"], ident)

    def test_desktop_rejects_retired_route_and_retains_recovery(self):
        backend = DesktopBackend(state=DesktopState(self.directory / "desktop.json"))
        response = backend.handle({"id": "retired", "method": "maintenance.detail"})
        self.assertEqual(response["error"]["code"], "unknown_method")
        with patch.object(backend, "_read", return_value={"supported": False}) as read:
            response = backend.handle({"id": "recovery", "method": "recovery.detail"})
        self.assertTrue(response["ok"])
        read.assert_called_once_with("recovery")


@unittest.skipUnless(importlib.util.find_spec("mcp"), "optional MCP runtime not installed")
class MCPSurfaceTests(unittest.IsolatedAsyncioTestCase):
    async def test_tool_lists_preserve_api_and_recovery_tools(self):
        from asip_mcp import create_server
        inspect_tools = await create_server().list_tools()
        admin_tools = await create_server(privileged=True).list_tools()
        self.assertEqual(len(inspect_tools), 10)
        self.assertEqual(len(admin_tools), 17)
        admin_names = {tool.name for tool in admin_tools}
        self.assertNotIn("maintenance_update", admin_names)
        self.assertTrue({"access_request", "access_use", "snapshot_create", "snapshot_rollback"} <= admin_names)
        tool = next(tool for tool in inspect_tools if tool.name == "asip_inspect")
        topics = tool.input_schema["properties"]["topic"]["enum"]
        self.assertNotIn("maintenance", topics)
        self.assertIn("recovery", topics)


if __name__ == "__main__":
    unittest.main()

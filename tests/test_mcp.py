import os
import pathlib
import shutil
import types
import unittest
from unittest import mock


try:
    import asip_mcp
    from mcp.client import Client
    from mcp.client.session import ClientSession
    from mcp.client.stdio import StdioServerParameters, stdio_client
except ModuleNotFoundError as exc:  # The adapter is an intentional optional extra.
    if exc.name == "mcp":
        asip_mcp = None
    else:  # pragma: no cover
        raise


@unittest.skipIf(asip_mcp is None, "optional MCP SDK is not installed")
class McpContractTestCase(unittest.IsolatedAsyncioTestCase):
    async def test_client_provenance_uses_supplied_metadata_or_truthful_unknown(self):
        metadata_key = asip_mcp.types.CLIENT_INFO_META_KEY
        supplied = types.SimpleNamespace(request_context=types.SimpleNamespace(
            meta={metadata_key: {"name": "fixture-agent", "version": "9.4"}},
            protocol_version="2026-07-28",
        ))
        omitted = types.SimpleNamespace(request_context=types.SimpleNamespace(
            meta={}, protocol_version="2026-07-28",
        ))
        self.assertEqual(
            asip_mcp._client_context(supplied)["client"],
            {"name": "fixture-agent", "version": "9.4"},
        )
        self.assertEqual(
            asip_mcp._client_context(omitted)["client"],
            {"name": "unknown-mcp-client", "version": "unknown"},
        )

    async def test_read_only_and_admin_surfaces_are_separate(self):
        inspect_server = asip_mcp.create_server(privileged=False)
        admin_server = asip_mcp.create_server(privileged=True)
        inspect_tools = {tool.name for tool in await inspect_server.list_tools()}
        admin_tools = {tool.name for tool in await admin_server.list_tools()}

        self.assertEqual(
            inspect_tools,
            {"asip_brief", "asip_context", "asip_summary", "change_list", "change_get",
             "operation_get", "journal_search", "eval_evidence",
             "asip_recovery", "asip_maintenance", "asip_facts", "asip_ask", "access_list"}
        )
        self.assertTrue(inspect_tools < admin_tools)
        self.assertIn("asip_do", admin_tools)
        self.assertNotIn("asip_do", inspect_tools)

    async def test_every_tool_has_structured_output_and_risk_annotations(self):
        server = asip_mcp.create_server(privileged=True)
        for tool in await server.list_tools():
            self.assertIsNotNone(tool.output_schema, tool.name)
            self.assertIsNotNone(tool.annotations, tool.name)
            if tool.name in {"asip_brief", "asip_context", "asip_summary", "change_list", "change_get",
                             "operation_get", "journal_search", "eval_evidence",
                             "asip_recovery", "asip_maintenance", "asip_facts", "asip_ask", "access_list"}:
                self.assertTrue(tool.annotations.read_only_hint, tool.name)
            else:
                self.assertFalse(tool.annotations.read_only_hint, tool.name)

    async def test_resource_catalog_is_compact_and_templated(self):
        server = asip_mcp.create_server(privileged=False)
        static_uris = {str(resource.uri) for resource in await server.list_resources()}
        template_uris = {template.uri_template for template in await server.list_resource_templates()}
        self.assertIn("asip://machine/brief", static_uris)
        self.assertIn("asip://changes/{change_id}", template_uris)
        self.assertIn("asip://operations/{operation_id}", template_uris)
        self.assertIn("asip://blobs/{digest}", template_uris)

    async def test_official_v2_client_discovers_current_protocol_and_cache_hints(self):
        async with Client(asip_mcp.create_server(privileged=False)) as client:
            tools = await client.list_tools()
            resources = await client.list_resources()
            self.assertEqual(client.protocol_version, "2026-07-28")
            self.assertEqual(tools.ttl_ms, 300_000)
            self.assertEqual(tools.cache_scope, "private")
            self.assertEqual(resources.ttl_ms, 60_000)
            self.assertIn("asip_context", {tool.name for tool in tools.tools})

    async def test_tool_call_forwards_current_client_provenance_and_cwd(self):
        response = {"schema_version": 1, "ok": True, "id": "query", "exit": 0,
                    "stdout": "{}\n", "stderr": "", "duration_ms": 1, "data": {}}
        with mock.patch.object(asip_mcp, "_call", new=mock.AsyncMock(return_value=response)) as call:
            async with Client(asip_mcp.create_server(privileged=False)) as client:
                result = await client.call_tool("asip_context", {"cwd": "/tmp/example"})
        self.assertFalse(result.is_error)
        request = call.await_args.args[1]
        self.assertEqual(request["cwd"], "/tmp/example")
        self.assertEqual(request["schema_version"], 1)
        self.assertEqual(request["transport"], "mcp")
        self.assertEqual(request["protocol_version"], "2026-07-28")

    async def test_asip_do_forwards_argv_intent_and_retry_key_to_privileged_socket(self):
        response = {"schema_version": 1, "ok": True, "id": "operation-1", "exit": 0,
                    "stdout": "", "stderr": "", "duration_ms": 1}
        with mock.patch.object(asip_mcp, "_call", new=mock.AsyncMock(return_value=response)) as call:
            async with Client(asip_mcp.create_server(privileged=True)) as client:
                result = await client.call_tool("asip_do", {
                    "argv": ["systemctl", "is-active", "example.service"],
                    "change_id": "change-1",
                    "request_key": "stable-model-key",
                })
        self.assertFalse(result.is_error)
        socket_path, request = call.await_args.args
        self.assertEqual(socket_path, asip_mcp.PRIVILEGED_SOCKET)
        self.assertEqual(request["argv"], ["systemctl", "is-active", "example.service"])
        self.assertEqual(request["change_id"], "change-1")
        self.assertEqual(request["request_key"], "stable-model-key")
        self.assertNotIn("sudo", request["argv"])

    async def test_access_tools_expose_identity_and_never_accept_a_credential_value(self):
        response = {"schema_version": 1, "ok": True, "id": "access-op", "exit": 0,
                    "stdout": "", "stderr": "", "duration_ms": 1, "data": {}}
        with mock.patch.object(asip_mcp, "_call", new=mock.AsyncMock(return_value=response)) as call:
            async with Client(asip_mcp.create_server(privileged=True)) as client:
                tools = {tool.name: tool for tool in (await client.list_tools()).tools}
                self.assertIn("access_list", tools)
                self.assertIn("access_request", tools)
                self.assertIn("access_use", tools)
                self.assertIn("access_start", tools)
                self.assertNotIn("value", tools["access_request"].input_schema.get("properties", {}))
                self.assertNotIn("value", tools["access_use"].input_schema.get("properties", {}))
                self.assertNotIn("value", tools["access_start"].input_schema.get("properties", {}))
                result = await client.call_tool("access_use", {
                    "name": "cloudflare.api_token", "argv": ["cloudflare-cli", "zones", "list"],
                    "change_id": "change-1",
                })
        self.assertFalse(result.is_error)
        request = call.await_args.args[1]
        self.assertEqual(request["op"], "access")
        self.assertEqual(request["action"], "use")
        self.assertEqual(request["name"], "cloudflare.api_token")
        self.assertNotIn("value", request)

        with mock.patch.object(asip_mcp, "_call", new=mock.AsyncMock(return_value=response)) as call:
            async with Client(asip_mcp.create_server(privileged=True)) as client:
                result = await client.call_tool("access_start", {
                    "name": "google.maps.api_key", "argv": ["vite", "--port", "4173"],
                    "change_id": "change-1",
                })
        self.assertFalse(result.is_error)
        request = call.await_args.args[1]
        self.assertEqual(request["action"], "start")
        self.assertNotIn("value", request)

    def test_service_dispatch_matches_cli_contract(self):
        with mock.patch.object(asip_mcp.shutil, "which", side_effect=lambda name:
                               "/bin/" + name if name == "rc-service" else None), \
                mock.patch.object(asip_mcp.os.path, "isdir", return_value=False):
            self.assertEqual(asip_mcp._service_argv("restart", "demo"),
                             ["rc-service", "demo", "restart"])
        with mock.patch.object(asip_mcp.shutil, "which", return_value=None):
            with self.assertRaisesRegex(ValueError, "asip_do"):
                asip_mcp._service_argv("restart", "demo")


@unittest.skipIf(asip_mcp is None, "optional MCP SDK is not installed")
@unittest.skipUnless(os.environ.get("ASIP_LIVE_MCP_TEST") == "1",
                     "set ASIP_LIVE_MCP_TEST=1 for installed stdio checks")
class McpInstalledStdioTestCase(unittest.IsolatedAsyncioTestCase):
    async def test_installed_agent_entrypoints_discover_and_read_context(self):
        repository = pathlib.Path(__file__).resolve().parents[1]
        expected_inspect = {
            "asip_brief", "asip_context", "asip_summary", "change_list", "change_get",
            "operation_get", "journal_search", "eval_evidence",
            "asip_recovery", "asip_maintenance", "asip_facts", "asip_ask", "access_list",
        }
        for executable_name, privileged in (
            ("asip-mcp-inspect", False), ("asip-mcp-admin", True),
        ):
            with self.subTest(executable=executable_name):
                executable = shutil.which(executable_name)
                self.assertIsNotNone(executable, "%s is not installed" % executable_name)
                parameters = StdioServerParameters(
                    command=executable,
                    args=[],
                    env=dict(os.environ, PYTHONPATH=str(repository)),
                    cwd=repository,
                )
                async with stdio_client(parameters) as (read_stream, write_stream):
                    async with ClientSession(read_stream, write_stream) as session:
                        initialized = await session.initialize()
                        tools = await session.list_tools()
                        names = {tool.name for tool in tools.tools}
                        # ClientSession.initialize() deliberately exercises the SDK's
                        # handshake-compatible path. The high-level Client contract
                        # above separately verifies the current 2026-07-28 path.
                        self.assertEqual(initialized.protocol_version, "2025-11-25")
                        self.assertTrue(expected_inspect <= names)
                        if privileged:
                            self.assertIn("asip_do", names)
                        else:
                            self.assertNotIn("asip_do", names)
                        context = await session.call_tool(
                            "asip_context", {"cwd": str(repository)}
                        )
                        self.assertFalse(context.is_error)
                        self.assertIsNotNone(context.structured_content)


if __name__ == "__main__":
    unittest.main()

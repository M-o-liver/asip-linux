#!/usr/bin/env python3
"""Live MCP stdio smoke test; run with an environment containing MCP v2."""

import asyncio
import json
import os
import sys
import uuid

from mcp.client import Client
from mcp.client.stdio import StdioServerParameters, stdio_client


async def main():
    command = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser(
        "~/.local/bin/asip-mcp-inspect"
    )
    admin = len(sys.argv) > 2 and sys.argv[2] == "admin"
    transport = stdio_client(StdioServerParameters(command=command, env=dict(os.environ)))
    async with Client(transport, read_timeout_seconds=10) as client:
        tools = await client.list_tools()
        names = {tool.name for tool in tools.tools}
        if "asip_context" not in names or (("asip_do" in names) != admin):
            raise SystemExit("unexpected inspection tool boundary: %s" % sorted(names))
        if admin:
            result = await client.call_tool("asip_do", {
                "argv": ["true"],
                "standalone_reason": "ASIP MCP admin live smoke test",
                "request_key": "mcp-live-%s" % uuid.uuid4(),
            })
            if result.is_error or not result.structured_content:
                raise SystemExit("asip_do failed through stdio: %r" % result)
            print(json.dumps({
                "protocol_version": client.protocol_version,
                "tools": len(names),
                "operation_id": result.structured_content.get("operation_id"),
                "exit": result.structured_content.get("exit"),
            }, separators=(",", ":")), flush=True)
            return
        context = await client.call_tool("asip_context", {"cwd": os.getcwd()})
        if context.is_error or not context.structured_content:
            raise SystemExit("asip_context failed through stdio: %r" % context)
        policy = await client.read_resource("asip://machine/policy")
        if not policy.contents:
            raise SystemExit("machine policy resource was empty")
        print(json.dumps({
            "protocol_version": client.protocol_version,
            "tools": len(names),
            "context_schema": context.structured_content.get("schema_version"),
            "project": context.structured_content.get("data", {}).get("project"),
            "policy_resources": len(policy.contents),
        }, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    asyncio.run(main())

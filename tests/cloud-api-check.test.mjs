import { test } from "node:test";
import assert from "node:assert/strict";
import { checkConnection } from "../cloud/public/assets/api-check.js";
import { canonical, sha256 } from "../beacon/cloud-protocol.mjs";

const token = "asip_" + "a".repeat(64),
  project = "github.com/example/project";
test("connection check exercises scoped bearer HTTP, MCP, and exact source bytes", async () => {
  const source = canonical({
      id: "proof",
      summary: "Completed work",
      data: { step: 17 },
    }),
    hash = await sha256(source),
    calls = [];
  const fetcher = async (path, options) => {
    assert.equal(options.headers.Authorization, "Bearer " + token);
    calls.push(path);
    if (path.includes("unassigned-connection-check"))
      return new Response("{}", { status: 403 });
    if (path.endsWith("/source")) return new Response(source);
    if (path === "/api/v1/me")
      return Response.json({ account: { handle: "owner" } });
    if (path === "/api/v1/projects")
      return Response.json({ projects: [{ id: project }] });
    if (path.startsWith("/api/v1/events?"))
      return Response.json({ events: [{ id: "proof", sha256: hash }] });
    const input = JSON.parse(options.body);
    return Response.json({
      jsonrpc: "2.0",
      id: input.id,
      result:
        input.method === "initialize"
          ? { serverInfo: { name: "asip-cloud" } }
          : input.method === "tools/list"
            ? { tools: [{ name: "asip_recall" }] }
            : {
                content: [
                  { type: "text", text: JSON.stringify({ events: [] }) },
                ],
              },
    });
  };
  const result = await checkConnection(token, [project], fetcher);
  assert.deepEqual(result, {
    account: "owner",
    projects: [project],
    record: "proof",
    sourceVerified: true,
    write: false,
  });
  assert.equal(calls.filter((p) => p === "/mcp").length, 3);
});
test("connection check rejects expired tokens and source corruption", async () => {
  await assert.rejects(
    checkConnection(token, [], async () =>
      Response.json({ error: "Connection revoked." }, { status: 401 }),
    ),
    /revoked/,
  );
  await assert.rejects(
    checkConnection("bad-token", [], async () => assert.fail()),
    /bearer token/,
  );
  const fetcher = async (path) => {
    if (path === "/api/v1/me")
      return Response.json({ account: { handle: "owner" } });
    if (path === "/api/v1/projects") return Response.json({ projects: [] });
    if (path.includes("?"))
      return Response.json({
        events: [{ id: "proof", sha256: "0".repeat(64) }],
      });
    return Response.json({ id: "changed" });
  };
  await assert.rejects(checkConnection(token, [], fetcher), /integrity/);
});

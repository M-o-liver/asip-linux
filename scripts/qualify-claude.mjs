import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { createServer } from "node:http";

// Exercise the CLI's native MCP startup over the Agent SDK control protocol.
// No user message or model request is sent.
export async function qualifyClaude({ pluginDirectory, verify } = {}) {
  // This qualification never uses a paid account or a provider endpoint.
  // Route the native runtime to a local rejecting gateway and fail if it
  // attempts inference. Only SDK control messages are sent below.
  const modelRequests = [];
  const gateway = createServer((request, response) => {
    if (request.url?.includes("/messages")) modelRequests.push(request.url);
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { type: "qualification_only" } }));
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      key.startsWith("ANTHROPIC_") ||
      key.startsWith("CLAUDE_CODE_USE_") ||
      key.startsWith("CLAUDE_CODE_OAUTH_TOKEN")
    )
      delete env[key];
  Object.assign(env, {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${gateway.address().port}`,
    ANTHROPIC_API_KEY: "asip-local-qualification-only",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  });
  const args = [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
  ];
  if (pluginDirectory)
    args.push("--setting-sources", "", "--plugin-dir", pluginDirectory);
  const child = spawn(
    process.platform === "win32" ? "claude.cmd" : "claude",
    args,
    {
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      env,
    },
  );
  const pending = new Map();
  let counter = 0,
    buffer = "",
    errors = "";
  child.stderr.on("data", (chunk) => (errors += chunk));
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let end; (end = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const response =
        message.type === "control_response" ? message.response : null;
      const waiting = pending.get(response?.request_id);
      if (!waiting) continue;
      clearTimeout(waiting.timer);
      pending.delete(response.request_id);
      response.subtype === "error"
        ? waiting.reject(new Error(response.error))
        : waiting.resolve(response.response);
    }
  });
  function request(subtype) {
    const request_id = "asip-" + ++counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(request_id);
        reject(
          new Error(
            "Claude initialization timed out: " + subtype + " " + errors,
          ),
        );
      }, 45000);
      pending.set(request_id, { resolve, reject, timer });
      child.stdin.write(
        JSON.stringify({
          type: "control_request",
          request_id,
          request: { subtype },
        }) + "\n",
      );
    });
  }
  try {
    await request("initialize");
    let server;
    const until = Date.now() + 30000;
    do {
      const status = await request("mcp_status");
      server = status.mcpServers?.find(
        (entry) => entry.name === "plugin:asip:asip",
      );
      if (server && server.status !== "pending") break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    } while (Date.now() < until);
    assert.equal(
      server?.status,
      "connected",
      "Claude must start the installed ASIP MCP server: " +
        JSON.stringify(server) +
        " " +
        errors,
    );
    assert.ok(
      server.tools?.some((tool) => tool.name === "asip_api_request"),
      "Claude must discover ASIP API access.",
    );
    if (verify) await verify();
    assert.deepEqual(modelRequests, [], "Qualification must not run a model.");
    return {
      server: server.name,
      nativeMcpStartup: true,
      tools: server.tools.map((tool) => tool.name),
    };
  } finally {
    child.stdin.end();
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null)
        return resolve();
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    child.stdout.destroy();
    child.stderr.destroy();
    for (const waiting of pending.values()) clearTimeout(waiting.timer);
    await new Promise((resolve) => gateway.close(resolve));
  }
}

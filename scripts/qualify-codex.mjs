import { spawn } from "node:child_process";
import assert from "node:assert/strict";

export async function qualifyCodex() {
  const child = spawn(
    process.platform === "win32" ? "codex.cmd" : "codex",
    ["app-server"],
    { stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" },
  );
  let next = 0,
    buffer = "",
    errors = "";
  const requests = new Map();
  child.stderr.on("data", (data) => (errors += data));
  child.stdout.on("data", (data) => {
    buffer += data;
    for (let end; (end = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const pending = requests.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        requests.delete(message.id);
        message.error
          ? pending.reject(new Error(JSON.stringify(message.error)))
          : pending.resolve(message.result);
      }
    }
  });
  function request(method, params) {
    const id = ++next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        requests.delete(id);
        reject(new Error("Codex request timed out: " + method + " " + errors));
      }, 45000);
      requests.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  try {
    await request("initialize", {
      clientInfo: { name: "asip-qualification", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const status = await request("mcpServerStatus/list", {
      detail: "toolsAndAuthOnly",
      limit: 100,
    });
    const server = status.data.find((server) =>
      Object.keys(server.tools || {}).includes("asip_connect"),
    );
    assert.ok(
      server,
      "Installed ASIP plugin must start through Codex and expose its connect tool.",
    );
    assert.equal(
      Object.keys(server.tools).includes("asip_record"),
      false,
      "Memory tools stay unavailable before account connection.",
    );
    return {
      server: server.name,
      tools: Object.keys(server.tools),
      nativeMcpStartup: true,
    };
  } finally {
    child.kill();
    for (const pending of requests.values()) clearTimeout(pending.timer);
  }
}

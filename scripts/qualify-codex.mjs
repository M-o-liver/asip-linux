import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
const version = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

export async function qualifyCodex() {
  const child = spawn(
    process.platform === "win32" ? "codex.cmd" : "codex",
    ["app-server"],
    {
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      env: { ...process.env, RUST_LOG: "codex_core_plugins=warn" },
    },
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
    const hooks = await request("hooks/list", { cwds: [process.cwd()] });
    const nativeHooks = hooks.data
      .flatMap((entry) => entry.hooks)
      .filter((hook) => hook.pluginId === "asip@asip-local");
    assert.equal(
      nativeHooks.length,
      9,
      "Codex must discover the plugin's native event hooks.",
    );
    const started = await request("thread/start", {
      cwd: process.cwd(),
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    const status = await request("mcpServerStatus/list", {
      threadId: started.thread.id,
      detail: "toolsAndAuthOnly",
      limit: 100,
    });
    const server = status.data.find((server) =>
      Object.keys(server.tools || {}).includes("asip_connect"),
    );
    assert.ok(
      server,
      "Installed ASIP plugin must start through Codex and expose its connect tool. " +
        JSON.stringify(status) +
        " " +
        errors,
    );
    assert.equal(
      server.serverInfo.version,
      version,
      "The installed helper must match the Beacon version.",
    );
    const disconnected = await request("mcpServer/tool/call", {
      threadId: started.thread.id,
      server: server.name,
      tool: "asip_recall",
      arguments: {},
    });
    assert.equal(
      disconnected.isError,
      true,
      "Disconnected plugins cannot access memory.",
    );
    return {
      server: server.name,
      tools: Object.keys(server.tools),
      nativeMcpStartup: true,
      nativeHooks: nativeHooks.map((hook) => ({
        event: hook.eventName,
        trust: hook.trustStatus,
      })),
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
    for (const pending of requests.values()) clearTimeout(pending.timer);
  }
}

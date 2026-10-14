import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { Runtime } from "../beacon/runtime.mjs";
import { accountId } from "../beacon/identity.mjs";

const binary = path.resolve(
  "build/helper",
  process.platform + "-" + process.arch,
  process.platform === "win32" ? "asip-plugin.exe" : "asip-plugin",
);
const account = {
  provider: "github",
  subject: "42",
  name: "Test",
  handle: "test-user",
  accountId: accountId("github", "42"),
};
function helper(mode, agent, home, args = []) {
  return spawn(binary, [mode, "--agent", agent, ...args], {
    env: { ...process.env, ASIP_PLUGIN_STATE: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
}
function rpc(child) {
  let buffer = "",
    counter = 0;
  const pending = new Map(),
    messages = [];
  const waiters = [];
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let next; (next = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, next);
      buffer = buffer.slice(next + 1);
      const message = JSON.parse(line);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      } else {
        messages.push(message);
        waiters.splice(0).forEach((resolve) => resolve());
      }
    }
  });
  return {
    request(method, params = {}) {
      const id = ++counter;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
        );
      });
    },
    async notification(method) {
      while (!messages.some((m) => m.method === method))
        await new Promise((resolve) => waiters.push(resolve));
      return messages.find((m) => m.method === method);
    },
  };
}
async function runHook(agent, home, event, payload) {
  const child = helper("hook", agent, home, ["--event", event]);
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stdin.end(JSON.stringify(payload));
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  return JSON.parse(output);
}

test(
  "standalone helper connects, exposes memory after authentication, captures native hooks, and stops on disconnect",
  { timeout: 20000 },
  async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "asip-helper-")),
      runtime = new Runtime(path.join(home, "beacon"), { port: 12945 });
    t.after(async () => {
      await runtime.close();
      fs.rmSync(home, { recursive: true, force: true });
    });
    await runtime.listen();
    const child = helper("mcp", "codex", path.join(home, "codex"));
    t.after(() => child.kill());
    const client = rpc(child);
    let response = await client.request("initialize", {
      protocolVersion: "2025-06-18",
    });
    assert.equal(response.result.protocolVersion, "2025-06-18");
    response = await client.request("tools/list");
    assert.deepEqual(
      response.result.tools.map((t) => t.name),
      ["asip_connect", "asip_status"],
    );
    await runHook("codex", path.join(home, "codex"), "UserPromptSubmit", {
      session_id: "s1",
      prompt: "Should not record",
    });
    assert.equal(fs.existsSync(path.join(home, "beacon")), false);
    runtime.signIn(account);
    let ready;
    const requested = new Promise((resolve) => (ready = resolve));
    runtime.onPluginSignIn = (request) => ready(request);
    response = await client.request("tools/call", {
      name: "asip_connect",
      arguments: {},
    });
    assert.equal(
      JSON.parse(response.result.content[0].text).state,
      "signing-in",
    );
    const request = await requested;
    // Ping remains responsive while the user signs in.
    assert.deepEqual((await client.request("ping")).result, {});
    runtime.completeSignIn(request.id, account);
    await client.notification("notifications/tools/list_changed");
    response = await client.request("tools/list");
    assert.ok(response.result.tools.some((t) => t.name === "asip_record"));
    const repository = path.join(home, "repository");
    fs.mkdirSync(repository);
    execFileSync("git", ["init", repository], { stdio: "ignore" });
    execFileSync("git", [
      "-C",
      repository,
      "remote",
      "add",
      "origin",
      "git@github.com:example/project.git",
    ]);
    await runHook("codex", path.join(home, "codex"), "UserPromptSubmit", {
      session_id: "s1",
      cwd: repository,
      prompt: "Fix the build",
      model: "test-model",
    });
    await runHook("codex", path.join(home, "codex"), "PostToolUse", {
      session_id: "s1",
      cwd: repository,
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: { exit_code: 0, output: "12 tests passed" },
      tool_use_id: "tool-1",
    });
    response = await client.request("tools/call", {
      name: "asip_recall",
      arguments: { project: "github.com/example/project" },
    });
    let events = JSON.parse(response.result.content[0].text).events;
    assert.equal(events.length, 2);
    assert.equal(events[0].data.tool_response.output, "12 tests passed");
    assert.equal(events[1].kind, "intent");
    runtime.disconnect("codex");
    await runHook("codex", path.join(home, "codex"), "PostToolUse", {
      session_id: "s1",
      cwd: repository,
      tool_name: "Bash",
    });
    assert.equal(
      runtime.db.prepare("SELECT count(*) AS n FROM events").get().n,
      2,
    );
    response = await client.request("tools/list");
    assert.equal(response.result.tools.length, 2);

    for (const agent of ["claude-code", "antigravity"]) {
      const state = path.join(home, agent),
        connecting = helper("connect", agent, state);
      t.after(() => connecting.kill());
      let begin;
      const pending = new Promise((resolve) => (begin = resolve));
      runtime.onPluginSignIn = (request) => begin(request);
      const request = await pending;
      runtime.completeSignIn(request.id, account);
      assert.equal((await once(connecting, "exit"))[0], 0);
      const payload =
        agent === "antigravity"
          ? {
              conversationId: "a1",
              workspacePaths: [repository],
              toolCall: {
                name: "run_command",
                args: { CommandLine: "npm test", Cwd: repository },
              },
              stepIdx: 5,
              error: "exit status 1",
            }
          : {
              session_id: "c1",
              cwd: repository,
              tool_name: "Bash",
              error: "exit status 1",
              tool_input: { command: "npm test" },
            };
      await runHook(
        agent,
        state,
        agent === "antigravity" ? "PostToolUse" : "PostToolUseFailure",
        payload,
      );
      const row = runtime.db
        .prepare("SELECT * FROM events WHERE agent=?")
        .get(agent);
      assert.equal(row.kind, "failed");
      assert.equal(row.project, "github.com/example/project");
      assert.equal(JSON.parse(row.data).error, "exit status 1");
    }
  },
);

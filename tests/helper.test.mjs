import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { Runtime } from "../beacon/runtime.mjs";
import { accountId } from "../beacon/identity.mjs";
import { Connections } from "../beacon/connections.mjs";
import { encryptionFixture } from "./encryption-fixture.mjs";
import http from "node:http";

let binary;
const children = new Set();
const account = {
  provider: "github",
  subject: "42",
  name: "Test",
  handle: "test-user",
  accountId: accountId("github", "42"),
};
function helper(mode, agent, home, args = []) {
  const child = spawn(binary, [mode, "--agent", agent, ...args], {
    env: { ...process.env, ASIP_PLUGIN_STATE: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
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
  { timeout: 90000 },
  async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "asip-helper-")),
      runtime = new Runtime(path.join(home, "beacon"));
    t.after(async () => {
      await Promise.all(
        [...children].map(async (child) => {
          const exited = once(child, "exit");
          child.kill();
          await exited;
        }),
      );
      await runtime.close();
      fs.rmSync(home, { recursive: true, force: true });
    });
    const endpoint = await runtime.listen();
    // Build the real helper for this fixture's random loopback port. Tests
    // never compete with, connect to, or stop an installed Beacon.
    binary = path.join(
      home,
      process.platform === "win32" ? "asip-plugin.exe" : "asip-plugin",
    );
    execFileSync(
      "go",
      ["build", "-ldflags", "-X main.endpoint=" + endpoint, "-o", binary, "."],
      {
        cwd: path.resolve("plugin-helper"),
        timeout: 60000,
        env: { ...process.env, CGO_ENABLED: "0" },
      },
    );
    const child = helper("mcp", "codex", path.join(home, "codex"));
    const client = rpc(child);
    let ready;
    const requested = new Promise((resolve) => (ready = resolve));
    runtime.onPluginSignIn = (request) => ready(request);
    let response = await client.request("initialize", {
      protocolVersion: "2025-06-18",
    });
    assert.equal(response.result.protocolVersion, "2025-06-18");
    response = await client.request("tools/list");
    assert.deepEqual(
      response.result.tools.map((t) => t.name),
      [
        "asip_projects",
        "asip_connections",
        "asip_api_request",
        "asip_connect",
        "asip_status",
        "asip_recall",
        "asip_record",
      ],
    );
    for (const name of ["asip_record", "asip_recall"]) {
      response = await client.request("tools/call", { name, arguments: {} });
      assert.equal(response.result.isError, true);
    }
    const inactiveHint = await runHook(
      "codex",
      path.join(home, "codex"),
      "UserPromptSubmit",
      {
        session_id: "s1",
        prompt: "Should not record",
      },
    );
    assert.deepEqual(inactiveHint, {});
    assert.equal(fs.existsSync(path.join(home, "beacon")), false);
    // Native initialization opens sign-in without requiring a model/setup call
    // or relying on a particular client's initialized-notification encoding.
    const request = await requested;
    assert.equal(request.account, null);
    // Ping remains responsive while the user signs in.
    assert.deepEqual((await client.request("ping")).result, {});
    runtime.signIn(account);
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
    const hint = await runHook(
      "codex",
      path.join(home, "codex"),
      "UserPromptSubmit",
      {
        session_id: "s1",
        cwd: repository,
        prompt: "Fix the build",
        model: "test-model",
      },
    );
    assert.match(hint.hookSpecificOutput.additionalContext, /"session":"s1"/);
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
    assert.equal(events[0].kind, "tool_succeeded");
    assert.equal(events[0].data.project_evidence.method, "git-origin");
    // Windows Git can expand an 8.3 path while Node retains its short alias.
    // Verify the root is the same directory rather than equating path spelling.
    const actualRoot = fs.statSync(
      events[0].data.project_evidence.repositoryRoot,
      { bigint: true },
    );
    const expectedRoot = fs.statSync(repository, { bigint: true });
    assert.deepEqual(
      [actualRoot.dev, actualRoot.ino],
      [expectedRoot.dev, expectedRoot.ino],
    );
    assert.equal(events[1].kind, "intent");
    response = await client.request("tools/call", {
      name: "asip_status",
      arguments: {},
      _meta: { sessionId: "root-session", threadId: "s1" },
    });
    const context = JSON.parse(response.result.content[0].text);
    assert.equal(context.session, "s1");
    assert.equal(context.project, "github.com/example/project");
    response = await client.request("tools/call", {
      name: "asip_record",
      arguments: {
        session: "wrong-session",
        kind: "evidence",
        summary: "Native session attribution",
      },
      _meta: {
        sessionId: "root-session",
        threadId: "s1",
        callId: "native-call",
      },
    });
    assert.equal(response.result.isError, false);
    response = await client.request("tools/call", {
      name: "asip_recall",
      arguments: { query: "Native session attribution" },
    });
    const attributed = JSON.parse(response.result.content[0].text).events[0];
    assert.equal(attributed.session, "s1");
    assert.equal(attributed.project, "github.com/example/project");
    assert.equal(attributed.data.native_session.threadId, "s1");
    assert.equal(attributed.data.native_session.sessionId, "root-session");
    let apiCredential;
    const api = http.createServer((req, res) => {
      apiCredential = req.headers["x-api-key"];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"result":"native helper API call"}');
    });
    await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => api.close(resolve)));
    const store = new Connections(path.join(home, "beacon"), {
      account: () => runtime.account,
      ...encryptionFixture(),
    });
    runtime.connectionStore = store;
    store.save({
      name: "local.work",
      provider: "custom",
      origin: "http://127.0.0.1:" + api.address().port,
      header: "x-api-key",
      credential: "fixture-only-api-credential",
      projects: ["github.com/example/project"],
    });
    response = await client.request("tools/call", {
      name: "asip_connections",
      arguments: {},
    });
    assert.equal(
      JSON.stringify(response).includes("fixture-only-api-credential"),
      false,
    );
    assert.equal(
      JSON.parse(response.result.content[0].text).connections[0].name,
      "local.work",
    );
    response = await client.request("tools/call", {
      name: "asip_api_request",
      arguments: { name: "local.work", path: "/result" },
      _meta: { sessionId: "root-session", threadId: "s1" },
    });
    assert.equal(response.result.isError, false);
    assert.equal(JSON.parse(response.result.content[0].text).status, 200);
    assert.equal(apiCredential, "fixture-only-api-credential");
    response = await client.request("tools/call", {
      name: "asip_projects",
      arguments: {},
    });
    assert.equal(
      JSON.parse(response.result.content[0].text).projects[0].name,
      "project",
    );
    await runHook("codex", path.join(home, "codex"), "PostToolUse", {
      session_id: "s1",
      cwd: repository,
      tool_name: "mcp__asip__asip_recall",
      tool_response: {
        content: [{ type: "text", text: "recursive memory response" }],
      },
    });
    const own = runtime.db
      .prepare("SELECT data FROM events ORDER BY rowid DESC LIMIT 1")
      .get();
    assert.equal(JSON.parse(own.data).asip_tool, true);
    assert.equal(JSON.parse(own.data).tool_response, undefined);
    response = await client.request("tools/call", {
      name: "asip_recall",
      arguments: { query: "recursive memory" },
    });
    assert.deepEqual(JSON.parse(response.result.content[0].text).events, []);
    runtime.disconnect("codex");
    await runHook("codex", path.join(home, "codex"), "PostToolUse", {
      session_id: "s1",
      cwd: repository,
      tool_name: "Bash",
    });
    assert.equal(
      runtime.db.prepare("SELECT count(*) AS n FROM events").get().n,
      6,
    );
    response = await client.request("tools/list");
    assert.equal(response.result.tools.length, 7);
    response = await client.request("tools/call", {
      name: "asip_recall",
      arguments: {},
    });
    assert.equal(response.result.isError, true);

    // Desktop tool discovery may close its MCP transport before the user
    // approves Beacon. Connection must survive that short-lived process.
    const discoveryState = path.join(home, "short-lived-discovery");
    let discovered;
    const discoveryRequest = new Promise((resolve) => {
      discovered = resolve;
    });
    runtime.onPluginSignIn = discovered;
    const discovery = helper("mcp", "codex", discoveryState);
    const discoveryClient = rpc(discovery);
    await discoveryClient.request("initialize", {
      protocolVersion: "2025-06-18",
    });
    const waiting = await discoveryRequest;
    const discoveryExit = once(discovery, "exit");
    discovery.stdin.end();
    await discoveryExit;
    const parallel = helper("mcp", "codex", discoveryState);
    await rpc(parallel).request("initialize", {});
    const parallelExit = once(parallel, "exit");
    parallel.stdin.end();
    await parallelExit;
    assert.equal(
      [...runtime.requests.values()].filter(
        (request) => request.agent === "codex",
      ).length,
      1,
      "Parallel discovery should share one account prompt.",
    );
    runtime.completeSignIn(waiting.id, account);
    const credentials = path.join(discoveryState, "codex.json");
    const deadline = Date.now() + 4000;
    while (!fs.existsSync(credentials) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(
      fs.existsSync(credentials),
      "Beacon approval must complete after the discovery MCP process exits.",
    );
    const resumed = helper("mcp", "codex", discoveryState);
    const resumedClient = rpc(resumed);
    await resumedClient.request("initialize", {});
    assert.equal(
      (
        await resumedClient.request("tools/call", {
          name: "asip_status",
          arguments: {},
        })
      ).result.isError,
      false,
    );

    for (const agent of ["claude-code", "antigravity"]) {
      const state = path.join(home, agent),
        connecting = helper("connect", agent, state);
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
      if (agent === "antigravity") {
        await runHook(agent, state, "PostToolUse", {
          conversationId: "a1",
          workspacePaths: [repository],
          toolCall: {
            name: "call_mcp_tool",
            args: {
              ServerName: "asip_asip",
              ToolName: "asip_recall",
              Arguments: {},
            },
          },
          toolResult: { text: "recursive memory response" },
        });
        const wrapped = JSON.parse(
          runtime.db
            .prepare("SELECT data FROM events ORDER BY rowid DESC LIMIT 1")
            .get().data,
        );
        assert.equal(wrapped.tool, "asip_asip/asip_recall");
        assert.equal(wrapped.asip_tool, true);
        assert.equal(wrapped.toolResult, undefined);
        await runHook(agent, state, "Stop", {
          conversationId: "a1",
          workspacePaths: [repository],
          terminationReason: "model_stop",
          fullyIdle: false,
          executionNum: 2,
        });
        const stopped = runtime.db
          .prepare("SELECT data FROM events WHERE agent=? AND kind='Stop'")
          .get(agent);
        assert.deepEqual(
          (({ terminationReason, fullyIdle, executionNum }) => ({
            terminationReason,
            fullyIdle,
            executionNum,
          }))(JSON.parse(stopped.data)),
          {
            terminationReason: "model_stop",
            fullyIdle: false,
            executionNum: 2,
          },
        );
      }
    }
  },
);

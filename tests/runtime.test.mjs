import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Runtime } from "../beacon/runtime.mjs";
import { accountId } from "../beacon/identity.mjs";
import { DatabaseSync } from "node:sqlite";
import { projectKey } from "../beacon/project.mjs";
import { Workspace } from "../beacon/workspace.mjs";

const account = {
  provider: "github",
  subject: "42",
  handle: "test-account",
  name: "Test",
  accountId: accountId("github", "42"),
};
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "asip-runtime-"));
  const runtime = new Runtime(home);
  t.after(async () => {
    await runtime.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { home, runtime };
}
function connect(runtime, agent = "codex", identity = account) {
  const verifier = crypto.randomBytes(32).toString("hex");
  const { requestId } = runtime.requestSignIn({
    agent,
    challenge: hash(verifier),
  });
  runtime.completeSignIn(requestId, identity);
  return runtime.pollSignIn(requestId, verifier).token;
}
const event = {
  session: "native-session",
  kind: "intent",
  project: "github.com/example/project",
  summary: "Fix the failing build",
  data: { evidence: "build log" },
};
test("identical native tool receipts are idempotent across deliveries and restart", async (t) => {
  const { home, runtime } = setup(t);
  runtime.signIn(account);
  const firstToken = connect(runtime);
  const secondToken = connect(runtime);
  const hook = {
    ...event,
    kind: "PostToolUse",
    summary: "PostToolUse Bash",
    data: {
      tool_use_id: "native-call-42",
      trace_sha256: hash("original native receipt"),
      tool: "Bash",
      tool_response: { output: "verified", exit_code: 0 },
    },
  };
  const saved = runtime.record(firstToken, hook);
  // Object key order and the delivering plugin credential are not identity.
  assert.deepEqual(
    runtime.record(secondToken, {
      ...hook,
      data: Object.fromEntries(Object.entries(hook.data).reverse()),
    }),
    saved,
  );
  assert.equal(runtime.status().records, 1);
  await runtime.close();
  const restarted = new Runtime(home);
  try {
    restarted.signIn(account);
    const token = connect(restarted);
    assert.deepEqual(restarted.record(token, hook), saved);
    assert.equal(restarted.status().records, 1);
    const changes = [
      { ...hook, session: "another-native-session" },
      { ...hook, kind: "PreToolUse" },
      { ...hook, project: "github.com/example/another-project" },
      {
        ...hook,
        data: { ...hook.data, tool_response: { output: "new evidence" } },
      },
      {
        ...hook,
        data: { ...hook.data, tool_use_id: "a-separate-native-call" },
      },
    ];
    for (const change of changes)
      assert.notEqual(restarted.record(token, change).id, saved.id);
    assert.equal(restarted.status().records, 1 + changes.length);
    const otherAgent = connect(restarted, "antigravity");
    assert.notEqual(restarted.record(otherAgent, hook).id, saved.id);
    // Explicit records and receipts without a source identity remain separate.
    assert.notEqual(
      restarted.record(token, event).id,
      restarted.record(token, event).id,
    );
    const incomplete = {
      ...hook,
      data: { tool_use_id: "without-source-hash" },
    };
    assert.notEqual(
      restarted.record(token, incomplete).id,
      restarted.record(token, incomplete).id,
    );
  } finally {
    // Close before setup's cleanup removes the directory: Windows locks open DBs.
    await restarted.close();
  }
});
test("Windows folder variants share history, catalogue, links, and workspace filters", (t) => {
  const { runtime } = setup(t);
  runtime.signIn(account);
  const token = connect(runtime);
  const original = "C:\\Users\\TestPC\\Documents\\ASIP-Qualification";
  const canonical = "c:/users/testpc/documents/asip-qualification";
  const db = runtime.storage();
  const old = runtime.record(token, { ...event, project: original });
  // Reproduce an older account containing independent provider spellings.
  db.prepare("UPDATE events SET project=? WHERE id=?").run(original, old.id);
  db.prepare("INSERT INTO projects VALUES(?,?,?,?,?,?)").run(
    original,
    "Qualification",
    "Earlier notes",
    "",
    "2026-01-01",
    JSON.stringify([original]),
  );
  db.prepare("INSERT INTO projects VALUES(?,?,?,?,?,?)").run(
    canonical,
    "Qualification",
    "Later notes",
    "",
    "2026-01-02",
    JSON.stringify([canonical]),
  );
  db.prepare("INSERT INTO project_links VALUES(?,?,?)").run(
    original,
    event.project,
    "related",
  );
  db.exec("PRAGMA user_version=1");
  db.close();
  runtime.db = null;
  runtime.record(token, {
    ...event,
    session: "antigravity-session",
    project: "c:/Users/TestPC/Documents/ASIP-Qualification/",
  });
  const recalled = runtime.recall(token, { project: original }).events;
  assert.equal(recalled.length, 2);
  assert.ok(recalled.some((row) => row.id === old.id));
  assert.ok(recalled.every((row) => row.project === canonical));
  assert.deepEqual(recalled.find((row) => row.id === old.id).data, event.data);
  const projects = runtime.projects();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].sessions, 2);
  assert.match(projects[0].description, /Earlier notes/);
  assert.match(projects[0].description, /Later notes/);
  assert.deepEqual(new Set(projects[0].roots), new Set([original, canonical]));
  assert.equal(
    runtime.db.prepare("SELECT source FROM project_links").get().source,
    canonical,
  );
  const workspace = new Workspace(runtime);
  assert.equal(
    workspace.data(new URLSearchParams({ project: original })).events.length,
    2,
  );
  assert.equal(projectKey("C:/"), "c:/");
  assert.equal(projectKey("\\\\Server\\Share\\Work\\"), "//server/share/work");
  assert.equal(projectKey("//SERVER/Share/Work"), "//server/share/work");
  assert.equal(projectKey("/Projects/MixedCase"), "/Projects/MixedCase");
  assert.equal(projectKey(event.project), event.project);
});
test("activity totals include history committed by another local importer", (t) => {
  const { runtime } = setup(t);
  runtime.signIn(account);
  const token = connect(runtime);
  runtime.record(token, event);
  assert.equal(runtime.status().records, 1);
  const importer = new DatabaseSync(runtime.databasePath());
  importer
    .prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?)")
    .run(
      "imported-event",
      new Date().toISOString(),
      "legacy-asip",
      "historical",
      "evidence",
      event.project,
      "Imported result",
      "{}",
    );
  importer.close();
  assert.equal(runtime.status().records, 2);
});

test("recorded commands omit authentication values and old history is repaired without losing events", (t) => {
  const { runtime } = setup(t);
  runtime.signIn(account);
  const token = connect(runtime);
  const recorded = runtime.record(token, {
    ...event,
    summary: "Inspect Bearer " + token,
    data: {
      command: 'curl -H "Authorization: Bearer ' + token + '" /status',
      response: JSON.stringify({ token }),
      headers: { Authorization: "different-header-value" },
    },
  });
  const fresh = runtime.recall(token).events[0];
  assert.equal(JSON.stringify(fresh).includes(token), false);
  assert.equal(fresh.data.headers.Authorization, "[credential]");
  assert.match(fresh.data.command, /Bearer \[credential\]/);

  runtime.db.prepare("UPDATE events SET summary=?,data=? WHERE id=?").run(
    "Legacy Bearer historical-credential",
    JSON.stringify({
      command: "curl -H 'Authorization: Bearer historical-credential' /recall",
      password: "old-password",
      head: "revision",
    }),
    recorded.id,
  );
  runtime.db.exec("PRAGMA user_version=0");
  runtime.db.close();
  runtime.db = null;
  const repaired = runtime.recall(token).events;
  assert.equal(repaired.length, 1);
  assert.equal(repaired[0].id, recorded.id);
  assert.equal(repaired[0].data.head, "revision");
  assert.equal(
    JSON.stringify(repaired).includes("historical-credential"),
    false,
  );
  assert.equal(JSON.stringify(repaired).includes("old-password"), false);
  assert.equal(runtime.db.prepare("PRAGMA user_version").get().user_version, 2);
});

test("nothing is collected before Beacon and plugin authentication", (t) => {
  const { home, runtime } = setup(t);
  assert.throws(() => runtime.record("", event), /Sign in/);
  const verifier = "valid-proof",
    request = runtime.requestSignIn({
      agent: "codex",
      challenge: hash(verifier),
    });
  assert.throws(
    () => runtime.completeSignIn(request.requestId, account),
    /Sign in/,
  );
  runtime.signIn(account);
  assert.throws(() => runtime.record("", event), /Sign in/);
  assert.deepEqual(fs.readdirSync(home), []);
  assert.equal(runtime.status().recording, false);
  runtime.completeSignIn(request.requestId, account);
  assert.equal(runtime.status().recording, false);
  assert.deepEqual(fs.readdirSync(home), []);
  const result = runtime.pollSignIn(request.requestId, verifier);
  assert.equal(runtime.status().recording, true);
  assert.deepEqual(fs.readdirSync(home), []);
  runtime.record(result.token, event);
  assert.equal(runtime.status().records, 1);
});
test("disconnect cancels unfinished and already-approved connection requests", (t) => {
  const { runtime } = setup(t);
  runtime.signIn(account);
  const { requestId } = runtime.requestSignIn({
    agent: "codex",
    challenge: hash("pending"),
  });
  runtime.completeSignIn(requestId, account);
  runtime.disconnect("codex");
  assert.throws(() => runtime.pollSignIn(requestId, "pending"), /expired/);
  assert.equal(runtime.status().recording, false);
});

test("wrong account, wrong proof, replay, and cancellation cannot connect", (t) => {
  const { runtime } = setup(t);
  runtime.signIn(account);
  const verifier = "original-proof",
    { requestId } = runtime.requestSignIn({
      agent: "claude-code",
      challenge: hash(verifier),
    });
  assert.throws(
    () =>
      runtime.completeSignIn(requestId, {
        accountId: accountId("github", "99"),
      }),
    /account shown/,
  );
  assert.throws(
    () => runtime.pollSignIn(requestId, "different-proof"),
    /expired/,
  );
  assert.equal(runtime.status().recording, false);
  runtime.completeSignIn(requestId, account);
  assert.throws(
    () => runtime.completeSignIn(requestId, account),
    /already complete/,
  );
  const token = runtime.pollSignIn(requestId, verifier).token;
  assert.throws(() => runtime.pollSignIn(requestId, verifier), /expired/);
  assert.equal(runtime.client(token).agent, "claude-code");
  const cancelled = runtime.requestSignIn({
    agent: "codex",
    challenge: hash(verifier),
  });
  runtime.cancelSignIn(cancelled.requestId);
  assert.throws(
    () => runtime.pollSignIn(cancelled.requestId, verifier),
    /expired/,
  );
});

test("first starts from three agents queue their account connections without losing the remaining requests", (t) => {
  const { runtime } = setup(t);
  const shown = [];
  runtime.onPluginSignIn = (request) => shown.push(request.agent);
  const requests = ["codex", "claude-code", "antigravity"].map((agent) => ({
    agent,
    ...runtime.requestSignIn({ agent, challenge: hash(agent) }),
  }));
  assert.deepEqual(shown, ["codex"]);
  runtime.signIn(account);
  for (const request of requests) {
    runtime.completeSignIn(request.requestId, account);
    const result = runtime.pollSignIn(request.requestId, request.agent);
    assert.equal(result.state, "connected");
  }
  assert.deepEqual(shown, ["codex", "claude-code", "antigravity"]);
  assert.equal(runtime.clients.size, 3);
  assert.equal(runtime.requests.size, 0);
});

test("an approved request abandoned before polling does not block another agent", (t) => {
  const { runtime } = setup(t);
  const shown = [];
  runtime.onPluginSignIn = (request) => shown.push(request.agent);
  runtime.signIn(account);
  const abandoned = runtime.requestSignIn({
    agent: "codex",
    challenge: hash("one"),
  });
  runtime.completeSignIn(abandoned.requestId, account);
  const next = runtime.requestSignIn({
    agent: "claude-code",
    challenge: hash("two"),
  });
  assert.deepEqual(shown, ["codex", "claude-code"]);
  runtime.completeSignIn(next.requestId, account);
  assert.equal(runtime.pollSignIn(next.requestId, "two").agent, "claude-code");
});

test("simultaneous MCP starts keep approved connections valid regardless of poll order", (t) => {
  const { runtime } = setup(t);
  runtime.signIn(account);
  const first = runtime.requestSignIn({
    agent: "codex",
    challenge: hash("first"),
  });
  const second = runtime.requestSignIn({
    agent: "codex",
    challenge: hash("second"),
  });
  runtime.completeSignIn(first.requestId, account);
  runtime.completeSignIn(second.requestId, account);
  const secondToken = runtime.pollSignIn(second.requestId, "second").token;
  const firstToken = runtime.pollSignIn(first.requestId, "first").token;
  const secondResult = runtime.record(secondToken, event);
  const firstResult = runtime.record(firstToken, event);
  // Also check state reloaded from the encrypted desktop session.
  runtime.clients = new Map(JSON.parse(JSON.stringify([...runtime.clients])));
  assert.equal(runtime.status().clients.length, 1);
  assert.equal(
    runtime.status().clients[0].lastActivity,
    [secondResult.at, firstResult.at].sort().at(-1),
  );
  assert.equal(runtime.status().records, 2);
  runtime.disconnect("codex");
  assert.throws(() => runtime.record(firstToken, event), /Sign in/);
  assert.throws(() => runtime.record(secondToken, event), /Sign in/);
});

test("record attribution comes from the connected plugin; logout and disconnect stop it", (t) => {
  const { runtime } = setup(t);
  runtime.signIn(account);
  const token = connect(runtime);
  runtime.record(token, { ...event, agent: "spoofed-agent" });
  assert.equal(runtime.recall(token).events[0].agent, "codex");
  runtime.disconnect("codex");
  assert.throws(() => runtime.record(token, event), /Sign in/);
  const second = connect(runtime, "antigravity");
  runtime.signOut();
  assert.throws(() => runtime.record(second, event), /Sign in/);
});

test("history survives restart and account switches do not mix records", (t) => {
  const { home, runtime } = setup(t);
  runtime.signIn(account);
  const token = connect(runtime);
  runtime.record(token, event);
  runtime.signOut();
  runtime.signIn(account);
  const restored = connect(runtime);
  assert.equal(runtime.recall(restored, { query: "failing" }).events.length, 1);
  runtime.signIn({
    ...account,
    subject: "99",
    accountId: accountId("github", "99"),
  });
  assert.throws(() => runtime.recall(restored), /Sign in/);
  const other = connect(runtime, "codex", runtime.account);
  assert.deepEqual(runtime.recall(other).events, []);
  assert.equal(fs.existsSync(runtime.databasePath()), false);
  runtime.record(other, { ...event, summary: "Another project result" });
  assert.equal(
    runtime.recall(other).events[0].summary,
    "Another project result",
  );
  assert.equal(fs.readdirSync(path.join(home, "accounts")).length, 2);
});

test("HTTP interface rejects disconnected activity and browser-origin requests", async (t) => {
  const { runtime } = setup(t),
    url = await runtime.listen();
  let response = await fetch(url + "/events", {
    method: "POST",
    body: JSON.stringify(event),
  });
  assert.equal(response.status, 401);
  response = await fetch(url + "/status", {
    headers: { Origin: "https://example.com" },
  });
  assert.equal(response.status, 403);
  runtime.signIn(account);
  const token = connect(runtime);
  response = await fetch(url + "/events", {
    method: "POST",
    headers: { Authorization: "Bearer " + token },
    body: JSON.stringify(event),
  });
  assert.equal(response.status, 200);
  response = await fetch(url + "/recall", {
    method: "POST",
    headers: { Authorization: "Bearer " + token },
    body: "{}",
  });
  assert.equal((await response.json()).events.length, 1);
});

test("ambiguous native project evidence is retained without inheriting the previous project", (t) => {
  const { runtime } = setup(t);
  runtime.signIn(account);
  const token = connect(runtime);
  runtime.record(token, event);
  runtime.record(token, {
    ...event,
    project: null,
    summary: "Multiple workspaces",
    data: { workspacePaths: ["/projects/one", "/projects/two"] },
  });
  const row = runtime.recall(token, { query: "Multiple" }).events[0];
  assert.equal(row.project, null);
  assert.equal(row.data.workspacePaths.length, 2);
});

test("recall finds tool evidence and searches literal terms within the requested project", (t) => {
  const { runtime } = setup(t);
  runtime.signIn(account);
  const token = connect(runtime);
  runtime.record(token, {
    ...event,
    summary: "Shell failed",
    data: { tool_output: "Migration stopped: connection_timeout at 80%" },
  });
  runtime.record(token, {
    ...event,
    project: "github.com/example/other",
    data: { tool_output: "connection_timeout" },
  });
  assert.equal(
    runtime.recall(token, {
      project: event.project,
      query: "CONNECTION_TIMEOUT",
    }).events.length,
    1,
  );
  assert.equal(runtime.recall(token, { query: "80%" }).events.length, 1);
  assert.equal(runtime.recall(token, { query: "80_" }).events.length, 0);
});

test("recall excludes self-recorded ASIP calls while keeping original work and administration evidence", (t) => {
  const { runtime } = setup(t);
  runtime.signIn(account);
  const token = connect(runtime);
  runtime.record(token, { ...event, kind: "result", summary: "Verified work" });
  runtime.record(token, {
    ...event,
    kind: "PostToolUse",
    summary: "ASIP recall",
    data: {
      tool: "mcp__asip__asip_recall",
      tool_response: { text: "Verified work" },
    },
  });
  runtime.record(token, {
    ...event,
    kind: "PostToolUse",
    summary: "Package verification",
    data: {
      tool: "mcp__asip_admin__verification_record",
      result: "Verified work",
    },
  });
  runtime.record(token, {
    ...event,
    kind: "PostToolUse",
    summary: "Antigravity MCP dispatcher",
    data: {
      tool: "call_mcp_tool",
      toolCall: { args: { ServerName: "asip_asip", ToolName: "asip_recall" } },
      toolResult: { text: "Verified work" },
    },
  });
  const records = runtime.recall(token, { query: "Verified work" }).events;
  assert.equal(records.length, 2);
  assert.ok(records.some((record) => record.kind === "result"));
  assert.ok(
    records.some((record) => record.summary === "Package verification"),
  );
  assert.equal(
    runtime.db.prepare("SELECT count(*) AS n FROM events").get().n,
    4,
  );
});
test("interleaved sessions never inherit another session's project or identity", (t) => {
  const { runtime } = setup(t);
  runtime.signIn(account);
  const token = connect(runtime);
  runtime.record(token, event);
  runtime.record(token, {
    ...event,
    session: "other-session",
    project: "github.com/example/other",
  });
  runtime.record(token, {
    session: event.session,
    kind: "result",
    summary: "First session completed",
  });
  assert.equal(
    runtime.recall(token, { query: "First session" }).events[0].project,
    event.project,
  );
  assert.throws(
    () => runtime.record(token, { kind: "result", summary: "No session" }),
    /session/,
  );
});

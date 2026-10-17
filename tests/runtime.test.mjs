import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Runtime } from "../beacon/runtime.mjs";
import { accountId } from "../beacon/identity.mjs";
import { DatabaseSync } from "node:sqlite";

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
  assert.equal(runtime.db.prepare("PRAGMA user_version").get().user_version, 1);
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
  const records = runtime.recall(token, { query: "Verified work" }).events;
  assert.equal(records.length, 2);
  assert.ok(records.some((record) => record.kind === "result"));
  assert.ok(
    records.some((record) => record.summary === "Package verification"),
  );
  assert.equal(
    runtime.db.prepare("SELECT count(*) AS n FROM events").get().n,
    3,
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

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { Runtime } from "../beacon/runtime.mjs";
import { Workspace, recentWork } from "../beacon/workspace.mjs";
import { accountId } from "../beacon/identity.mjs";

test("workspace opens through Beacon, shows actual projects, and invalidates browser access on sign-out", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "asip-workspace-"));
  const runtime = new Runtime(home);
  let opened = 0;
  let reopened = 0;
  let openedView;
  const workspace = new Workspace(runtime, {
    openBeacon: (view) => {
      opened++;
      openedView = view;
    },
    openWorkspace: () => reopened++,
  });
  t.after(async () => {
    await runtime.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const endpoint = await runtime.listen();
  const root = await fetch(endpoint + "/", { redirect: "manual" });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "/workspace/");
  assert.equal((await fetch(endpoint + "/workspace/")).status, 200);
  assert.throws(() => workspace.openURL(), /Sign in/);
  assert.equal((await fetch(endpoint + "/workspace/data")).status, 401);
  assert.equal(fs.existsSync(path.join(home, "accounts")), false);
  const account = {
    accountId: accountId("github", "42"),
    provider: "github",
    subject: "42",
    handle: "fixture",
  };
  runtime.signIn(account);
  assert.equal(
    (
      await fetch(endpoint + "/workspace/reopen", {
        method: "POST",
        headers: { Origin: "https://elsewhere.test" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(endpoint + "/workspace/reopen", {
        method: "POST",
        headers: { Origin: endpoint },
      })
    ).status,
    200,
  );
  assert.equal(reopened, 1);
  assert.equal((await fetch(endpoint + "/workspace/data")).status, 401);
  const verifier = crypto.randomBytes(32).toString("hex");
  const pending = runtime.requestSignIn({
    agent: "codex",
    challenge: crypto.createHash("sha256").update(verifier).digest("hex"),
  });
  runtime.completeSignIn(pending.requestId, account);
  const token = runtime.pollSignIn(pending.requestId, verifier).token;
  runtime.record(token, {
    session: "native-1",
    project: "github.com/example/one",
    kind: "PreToolUse",
    summary: "Bash started",
  });
  runtime.record(token, {
    session: "native-1",
    project: "github.com/example/one",
    kind: "intent",
    summary: "Fix the build",
    data: { cwd: "/projects/one" },
  });
  runtime.record(token, {
    session: "native-1",
    project: "github.com/example/two",
    kind: "result",
    summary: "Updated dependency",
    data: { head: "fixture-revision" },
  });
  const url = workspace.openURL("github.com/example/two");
  const handshake = await fetch(url, { redirect: "manual" });
  assert.equal(handshake.status, 303);
  assert.equal(
    handshake.headers.get("location"),
    "/workspace/?project=github.com%2Fexample%2Ftwo",
  );
  runtime.record(token, {
    session: "native-1",
    project: "github.com/example/two",
    kind: "Stop",
    summary: "Verified the native desktop result",
  });
  runtime.record(token, { session: "native-1", kind: "Stop", summary: "Stop" });
  runtime.record(token, {
    session: "native-1",
    kind: "api_failed",
    summary: "Key expired",
  });
  assert.equal(recentWork(runtime)[0].summary, "Key expired");
  assert.equal(
    recentWork(runtime)[1].summary,
    "Verified the native desktop result",
  );
  const cookie = handshake.headers.get("set-cookie").split(";")[0];
  assert.match(
    handshake.headers.get("set-cookie"),
    /HttpOnly; SameSite=Strict/,
  );
  assert.equal((await fetch(url, { redirect: "manual" })).status, 401);
  const headers = { Cookie: cookie };
  const page = await fetch(endpoint + "/workspace/", { headers });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Project map/);
  const data = await fetch(
    endpoint +
      "/workspace/data?kind=work&project=" +
      encodeURIComponent("github.com/example/one"),
    { headers },
  ).then((r) => r.json());
  assert.equal(data.projects.length, 2);
  assert.equal(data.events.length, 1);
  assert.equal(data.events[0].summary, "Fix the build");
  assert.deepEqual(data.directories, ["/projects/one"]);
  assert.equal(data.relationships[0].sessions, 1);
  assert.equal(
    (
      await fetch(endpoint + "/workspace/data", {
        headers: { ...headers, Origin: "https://elsewhere.test" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(endpoint + "/workspace/beacon", {
        method: "POST",
        headers: { ...headers, Origin: endpoint },
      })
    ).status,
    200,
  );
  assert.equal(opened, 1);
  await fetch(endpoint + "/workspace/beacon?view=connections", {
    method: "POST",
    headers: { ...headers, Origin: endpoint },
  });
  assert.equal(openedView, "connections");
  runtime.connectionStore = {
    list() {
      throw new Error("Fixture keychain unavailable");
    },
  };
  const withoutConnections = await fetch(endpoint + "/workspace/data", {
    headers,
  }).then((r) => r.json());
  assert.equal(withoutConnections.events.length, 6);
  assert.equal(
    withoutConnections.connectionError,
    "API connections could not be opened.",
  );
  runtime.connectionStore = null;
  runtime.signOut();
  assert.equal(
    (await fetch(endpoint + "/workspace/data", { headers })).status,
    401,
  );
  runtime.signIn(account);
  assert.equal(
    (await fetch(endpoint + "/workspace/data", { headers })).status,
    401,
  );
});

test("workspace paginates older native sessions without understating the project total", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "asip-session-pages-"));
  const runtime = new Runtime(home);
  t.after(async () => {
    await runtime.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  runtime.signIn({ accountId: accountId("github", "sessions") });
  const insert = runtime
    .storage()
    .prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?)");
  for (let i = 0; i < 27; i++)
    insert.run(
      "fixture-" + i,
      new Date(Date.UTC(2026, 9, 17, 0, i)).toISOString(),
      "codex",
      "native-" + i,
      "result",
      "github.com/example/one",
      "Verified " + i,
      "{}",
    );
  insert.run(
    "elsewhere",
    new Date().toISOString(),
    "codex",
    "different-project",
    "result",
    "github.com/example/two",
    "Other work",
    "{}",
  );
  const workspace = new Workspace(runtime);
  const params = new URLSearchParams({ project: "github.com/example/one" });
  const first = workspace.data(params);
  assert.equal(first.sessionCount, 27);
  assert.equal(first.sessions.length, 20);
  assert.equal(first.moreSessions, true);
  params.set("sessionOffset", "20");
  const older = workspace.data(params);
  assert.equal(older.sessions.length, 7);
  assert.equal(older.moreSessions, false);
  assert.equal(
    new Set([...first.sessions, ...older.sessions].map((s) => s.session)).size,
    27,
  );
  assert.ok(!older.sessions.some((s) => s.session === "different-project"));
});

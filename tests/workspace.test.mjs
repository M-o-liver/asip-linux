import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { Runtime } from "../beacon/runtime.mjs";
import { Workspace } from "../beacon/workspace.mjs";
import { accountId } from "../beacon/identity.mjs";

test("workspace opens through Beacon, shows actual projects, and invalidates browser access on sign-out", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "asip-workspace-"));
  const runtime = new Runtime(home);
  let opened = 0;
  const workspace = new Workspace(runtime, { openBeacon: () => opened++ });
  t.after(async () => {
    await runtime.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const endpoint = await runtime.listen();
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
  const url = workspace.openURL();
  const handshake = await fetch(url, { redirect: "manual" });
  assert.equal(handshake.status, 303);
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
  runtime.connectionStore = {
    list() {
      throw new Error("Fixture keychain unavailable");
    },
  };
  const withoutConnections = await fetch(endpoint + "/workspace/data", {
    headers,
  }).then((r) => r.json());
  assert.equal(withoutConnections.events.length, 3);
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

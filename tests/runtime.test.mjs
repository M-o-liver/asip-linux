import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Runtime } from "../beacon/runtime.mjs";
import { accountId } from "../beacon/identity.mjs";

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

test("nothing is collected before Beacon and plugin authentication", (t) => {
  const { home, runtime } = setup(t);
  assert.throws(() => runtime.record("", event), /Sign in/);
  assert.throws(
    () => runtime.requestSignIn({ agent: "codex", challenge: hash("test") }),
    /Beacon first/,
  );
  runtime.signIn(account);
  assert.throws(() => runtime.record("", event), /Sign in/);
  assert.deepEqual(fs.readdirSync(home), []);
  assert.equal(runtime.status().recording, false);
  const verifier = "valid-proof",
    request = runtime.requestSignIn({
      agent: "codex",
      challenge: hash(verifier),
    });
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

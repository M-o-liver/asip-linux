import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Connections } from "../beacon/connections.mjs";
import { Runtime } from "../beacon/runtime.mjs";
import { accountId } from "../beacon/identity.mjs";
import { encryptionFixture } from "./encryption-fixture.mjs";

const account = {
  accountId: accountId("github", "42"),
  provider: "github",
  subject: "42",
  handle: "fixture",
};
function setup(t, fetcher) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "asip-connections-"));
  const runtime = new Runtime(home);
  const cipher = encryptionFixture();
  const store = new Connections(home, {
    account: () => runtime.account,
    ...cipher,
    fetcher,
  });
  runtime.connectionStore = store;
  t.after(async () => {
    await runtime.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { home, runtime, store, cipher };
}
function connect(runtime) {
  const verifier = crypto.randomBytes(32).toString("hex");
  const challenge = crypto.createHash("sha256").update(verifier).digest("hex");
  const request = runtime.requestSignIn({ agent: "codex", challenge });
  runtime.completeSignIn(request.requestId, account);
  return runtime.pollSignIn(request.requestId, verifier).token;
}
test("connections persist encrypted, never expose their credential in metadata, and belong to one account", (t) => {
  const { home, runtime, store, cipher } = setup(t);
  assert.throws(() => store.list(), /Sign in/);
  assert.deepEqual(fs.readdirSync(home), []);
  runtime.signIn(account);
  store.save({
    name: "openai.work",
    provider: "openai",
    credential: "fixture-only-api-credential",
    projects: ["github.com/example/one"],
  });
  assert.equal(
    JSON.stringify(store.list()).includes("fixture-only-api-credential"),
    false,
  );
  const file = path.join(
    home,
    "accounts",
    account.accountId,
    "connections.bin",
  );
  assert.equal(
    fs.readFileSync(file).includes(Buffer.from("fixture-only-api-credential")),
    false,
  );
  const restored = new Connections(home, {
    account: () => runtime.account,
    ...cipher,
  });
  assert.equal(restored.list()[0].name, "openai.work");
  runtime.signOut();
  runtime.signIn({ ...account, accountId: accountId("github", "99") });
  assert.deepEqual(store.list(), []);
  runtime.signIn(account);
  assert.equal(store.list().length, 1);
  store.remove("openai.work");
  assert.deepEqual(store.list(), []);
});
test("provider connections attach the correct credentials and redact reflected values", async (t) => {
  const requests = [];
  const { runtime, store } = setup(t, async (url, options) => {
    requests.push({ url: String(url), ...options });
    return new Response("fixture-only-secret", {
      status: 200,
      headers: { "x-request-id": "fixture-only-secret" },
    });
  });
  runtime.signIn(account);
  for (const provider of ["openai", "anthropic", "gemini", "github"]) {
    store.save({
      name: provider + ".work",
      provider,
      credential: "fixture-only-secret",
    });
    const result = await store.request({
      name: provider + ".work",
      path: "/models",
    });
    assert.equal(result.body, "[credential]");
    assert.equal(result.requestId, "[credential]");
  }
  assert.equal(requests[0].headers.Authorization, "Bearer fixture-only-secret");
  assert.equal(requests[1].headers["x-api-key"], "fixture-only-secret");
  assert.equal(requests[1].headers["anthropic-version"], "2023-06-01");
  assert.equal(requests[2].headers["x-goog-api-key"], "fixture-only-secret");
  assert.equal(requests[3].url, "https://api.github.com/models");
});
test("JSON responses remain structured and redact escaped credentials", async (t) => {
  const credential = 'fixture-"secret\\value';
  const { runtime, store } = setup(
    t,
    async () =>
      new Response(
        JSON.stringify({
          result: { value: credential, [credential]: "ok" },
        }),
      ),
  );
  runtime.signIn(account);
  store.save({ name: "openai.work", provider: "openai", credential });
  const result = await store.request({ name: "openai.work", path: "/models" });
  assert.deepEqual(result.body, {
    result: { value: "[credential]", "[credential]": "ok" },
  });
});
test("oversized responses report truncation without returning incomplete content", async (t) => {
  const { runtime, store } = setup(
    t,
    async () => new Response("x".repeat(70000)),
  );
  runtime.signIn(account);
  store.save({
    name: "openai.work",
    provider: "openai",
    credential: "fixture-secret",
  });
  const result = await store.request({ name: "openai.work", path: "/models" });
  assert.equal(result.truncated, true);
  assert.equal(result.body, null);
  assert.match(result.bodySha256, /^[a-f0-9]{64}$/);
});
test("request limits count UTF-8 bytes and reject GET bodies before dispatch", (t) => {
  const { runtime, store } = setup(t);
  runtime.signIn(account);
  store.save({
    name: "openai.work",
    provider: "openai",
    credential: "fixture-secret",
  });
  assert.throws(
    () => store.prepare({ name: "openai.work", path: "/models", body: {} }),
    /request body/,
  );
  assert.throws(
    () =>
      store.prepare({
        name: "openai.work",
        path: "/responses",
        method: "POST",
        body: "界".repeat(22000),
      }),
    /too large/,
  );
});
test("project grants and origin binding are enforced before dispatch", async (t) => {
  let calls = 0;
  const { runtime, store } = setup(t, async () => {
    calls++;
    return new Response("ok");
  });
  runtime.signIn(account);
  store.save({
    name: "api.work",
    provider: "openai",
    credential: "fixture-only-secret",
    projects: ["one"],
  });
  await assert.rejects(
    store.request({ name: "api.work", path: "/models", project: "two" }),
    /not assigned/,
  );
  for (const route of [
    "https://elsewhere.test/x",
    "//elsewhere.test/x",
    "/\\elsewhere.test/x",
    "/x#fragment",
  ]) {
    await assert.rejects(
      store.request({ name: "api.work", path: route, project: "one" }),
    );
  }
  assert.equal(calls, 0);
  await store.request({ name: "api.work", path: "/models", project: "one" });
  assert.equal(calls, 1);
});
test("real HTTP requests produce durable results and never follow a credential-bearing redirect", async (t) => {
  let observed;
  const destination = http.createServer((_req, res) => {
    observed = "redirect followed";
    res.end("bad");
  });
  await new Promise((resolve) => destination.listen(0, "127.0.0.1", resolve));
  const server = http.createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, {
        Location: "http://127.0.0.1:" + destination.address().port + "/",
      });
      res.end();
      return;
    }
    observed = req.headers["x-api-key"];
    res.writeHead(201, { "x-request-id": "provider-42" });
    res.end("created");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await Promise.all(
      [server, destination].map(
        (s) => new Promise((resolve) => s.close(resolve)),
      ),
    );
  });
  const { runtime, store } = setup(t);
  runtime.signIn(account);
  const token = connect(runtime);
  store.save({
    name: "local.work",
    provider: "custom",
    origin: "http://127.0.0.1:" + server.address().port,
    header: "x-api-key",
    credential: "fixture-only-secret",
    projects: ["one"],
  });
  const result = await runtime.apiRequest(token, {
    name: "local.work",
    path: "/items?private=query",
    method: "POST",
    body: { name: "test" },
    project: "one",
    session: "s1",
  });
  assert.equal(observed, "fixture-only-secret");
  assert.equal(result.status, 201);
  const records = runtime.recall(token).events;
  assert.equal(records[0].kind, "api_result");
  assert.equal(records[0].data.providerRequestId, "provider-42");
  assert.equal(records[0].data.request, result.auditId);
  assert.equal(JSON.stringify(records).includes("fixture-only-secret"), false);
  assert.equal(JSON.stringify(records).includes("private=query"), false);
  await assert.rejects(
    runtime.apiRequest(token, {
      name: "local.work",
      path: "/redirect",
      project: "one",
      session: "s1",
    }),
  );
  assert.notEqual(observed, "redirect followed");
  assert.equal(runtime.recall(token).events[0].kind, "api_unresolved");
});
test("disconnecting during a request aborts it and preserves an unresolved audit record", async (t) => {
  let began;
  const started = new Promise((resolve) => (began = resolve));
  const { runtime, store } = setup(t, async (_url, { signal }) => {
    began();
    return new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      }),
    );
  });
  runtime.signIn(account);
  const token = connect(runtime);
  store.save({
    name: "openai.work",
    provider: "openai",
    credential: "fixture-only-secret",
  });
  const pending = runtime.apiRequest(token, {
    name: "openai.work",
    path: "/models",
    session: "s1",
    project: "one",
  });
  const rejected = assert.rejects(pending, /aborted/);
  await started;
  runtime.disconnect("codex");
  await rejected;
  const row = runtime.db
    .prepare("SELECT * FROM events ORDER BY rowid DESC LIMIT 1")
    .get();
  assert.equal(row.kind, "api_unresolved");
  assert.equal(runtime.apiRequests.size, 0);
});

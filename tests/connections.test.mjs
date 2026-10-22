import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { Connections } from "../beacon/connections.mjs";
import { Runtime } from "../beacon/runtime.mjs";
import { accountId } from "../beacon/identity.mjs";
import { encryptionFixture } from "./encryption-fixture.mjs";
import { importConnections } from "../beacon/import-connections.mjs";

const account = {
  accountId: accountId("github", "42"),
  provider: "github",
  subject: "42",
  handle: "fixture",
};
test("Cloudflare Check supports account-owned tokens without misreporting the personal-token endpoint", async (t) => {
  const calls = [];
  const accountId = "c".repeat(32);
  const { runtime, store } = setup(t, async (url, options) => {
    calls.push(new URL(url).pathname);
    assert.equal(options.headers.Authorization, "Bearer account-token-fixture");
    if (new URL(url).pathname === "/client/v4/user/tokens/verify")
      return Response.json(
        { success: false, errors: [{ message: "Invalid API Token" }] },
        { status: 401 },
      );
    if (new URL(url).pathname === "/client/v4/accounts")
      return Response.json({ success: true, result: [{ id: accountId }] });
    return Response.json({ success: true, result: { status: "active" } });
  });
  runtime.signIn(account);
  store.save({
    name: "cloudflare.account",
    provider: "cloudflare",
    credential: "account-token-fixture",
  });
  assert.equal((await store.check("cloudflare.account")).status, 200);
  assert.equal(store.list()[0].lastRequest.status, 200);
  assert.deepEqual(calls, [
    "/client/v4/user/tokens/verify",
    "/client/v4/accounts",
    "/client/v4/accounts/" + accountId + "/tokens/verify",
  ]);
});
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
test("Windows project grants match provider path variants without changing credentials", (t) => {
  const { runtime, store } = setup(t);
  runtime.signIn(account);
  store.save({
    name: "github.windows",
    provider: "github",
    credential: "fixture-token",
    projects: ["C:\\Users\\TestPC\\Work"],
  });
  // Simulate a credential saved before path canonicalization existed.
  store.entries.get("github.windows").projects = ["C:\\Users\\TestPC\\Work"];
  store.persist();
  const encrypted = fs.readFileSync(store.file);
  store.clear();
  assert.equal(store.list("c:/users/TESTPC/work/").length, 1);
  assert.doesNotThrow(() =>
    store.prepare({
      name: "github.windows",
      project: "C:/Users/testpc/Work",
      path: "/user",
    }),
  );
  assert.throws(
    () =>
      store.prepare({
        name: "github.windows",
        project: "C:/Users/testpc/Other",
        path: "/user",
      }),
    /not assigned/,
  );
  assert.deepEqual(fs.readFileSync(store.file), encrypted);
});
test(
  "local pipe imports time out without a writer and then accept a later transfer",
  { skip: process.platform === "win32" },
  async (t) => {
    const { home, runtime, store } = setup(t);
    runtime.signIn(account);
    const pipe = path.join(home, "connections.pipe");
    execFileSync("mkfifo", [pipe]);
    await assert.rejects(
      importConnections(store, pipe, {
        account: () => runtime.account?.accountId,
        timeout: 50,
      }),
      /timed out/,
    );
    const pending = importConnections(store, pipe, {
      account: () => runtime.account?.accountId,
    });
    await fs.promises.writeFile(
      pipe,
      JSON.stringify([
        {
          name: "pipe.key",
          provider: "openai",
          credential: "fixture-pipe-value",
        },
      ]),
    );
    assert.deepEqual((await pending).imported, ["pipe.key"]);
  },
);
test("API checks retain real outcomes, clear them on key replacement, and never expose network errors containing credentials", async (t) => {
  let fail = false;
  const { runtime, store } = setup(t, async () => {
    if (fail) throw new Error("https://example.test/?key=fixture-secret");
    return new Response("Rejected", { status: 401 });
  });
  runtime.signIn(account);
  store.save({
    name: "github.test",
    provider: "github",
    credential: "fixture-secret",
  });
  assert.equal((await store.check("github.test")).status, 401);
  assert.equal(store.list()[0].lastRequest.status, 401);
  store.save({
    name: "github.test",
    provider: "github",
    credential: "replacement-fixture",
  });
  assert.equal(store.list()[0].lastRequest, undefined);
  fail = true;
  await assert.rejects(
    store.check("github.test"),
    (error) =>
      !error.message.includes("fixture-secret") &&
      /did not return/.test(error.message),
  );
  assert.equal(store.list()[0].lastRequest.error, "No response");
});
test("batch imports preserve names and signing secrets, reject conflicts atomically, and survive reload", async (t) => {
  const { home, runtime, store, cipher } = setup(t);
  runtime.signIn(account);
  const file = path.join(home, "import.json");
  fs.writeFileSync(
    file,
    JSON.stringify([
      {
        name: "stripe.secret_key_test",
        provider: "stripe",
        credential: "fixture-api-key",
        label: "Test API",
        envVar: "STRIPE_SECRET_KEY_TEST",
      },
      {
        name: "stripe.webhook_secret_test",
        provider: "secret",
        credential: "fixture-signing-secret",
        projects: ["one"],
      },
    ]),
  );
  const result = await importConnections(store, file, {
    account: () => runtime.account?.accountId,
  });
  assert.equal(result.verified, true);
  assert.equal(result.imported.length, 2);
  const restored = new Connections(home, {
    account: () => runtime.account,
    ...cipher,
  });
  assert.equal(restored.list()[0].envVar, "STRIPE_SECRET_KEY_TEST");
  assert.equal(
    restored.prepare({ name: "stripe.secret_key_test", path: "/v1/account" })
      .entry.credential,
    "fixture-api-key",
  );
  assert.throws(
    () => restored.prepare({ name: "stripe.webhook_secret_test", path: "/" }),
    /signing secret/,
  );
  assert.equal(
    JSON.stringify(restored.list()).includes("fixture-signing-secret"),
    false,
  );
  assert.throws(
    () =>
      restored.import([
        { name: "new.key", provider: "openai", credential: "fixture-new" },
        {
          name: "stripe.secret_key_test",
          provider: "stripe",
          credential: "fixture-conflict",
        },
      ]),
    /already exists/,
  );
  assert.equal(restored.list().length, 2);
  assert.throws(
    () =>
      restored.import([
        { name: "bad.key", provider: "unknown", credential: "fixture" },
      ]),
    /provider/,
  );
  const broken = new Connections(home, {
    account: () => runtime.account,
    ...cipher,
  });
  broken.load();
  broken.unseal = () => "[]";
  assert.throws(
    () =>
      broken.import([
        { name: "new.key", provider: "openai", credential: "fixture" },
      ]),
    /verified/,
  );
  assert.equal(broken.list().length, 2);
  assert.equal(
    new Connections(home, { account: () => runtime.account, ...cipher }).list()
      .length,
    2,
  );
});
test("provider authentication supports Basic, named headers, query keys, and converting a stored secret", async (t) => {
  const calls = [];
  const { runtime, store } = setup(t, async (url, options) => {
    calls.push({ url, ...options });
    return new Response("ok");
  });
  runtime.signIn(account);
  store.save({
    name: "stripe.test",
    provider: "stripe",
    credential: "fixture",
  });
  await store.request({ name: "stripe.test", path: "/v1/account" });
  assert.equal(
    calls[0].headers.Authorization,
    "Basic " + Buffer.from("fixture:").toString("base64"),
  );
  store.save({
    name: "maps.test",
    provider: "google-maps",
    credential: "fixture",
  });
  await store.request({
    name: "maps.test",
    path: "/maps/api/geocode/json?key=other&address=Toronto",
  });
  assert.equal(calls[1].url.searchParams.get("key"), "fixture");
  store.save({
    name: "generic.test",
    provider: "secret",
    credential: "fixture",
  });
  store.save({ name: "generic.test", provider: "brave" });
  await store.request({
    name: "generic.test",
    path: "/res/v1/web/search?q=test",
  });
  assert.equal(calls[2].headers["X-Subscription-Token"], "fixture");
});
test("import errors never echo credential-bearing JSON", async (t) => {
  const { home, runtime, store } = setup(t);
  runtime.signIn(account);
  const file = path.join(home, "bad.json");
  fs.writeFileSync(file, '{"fixture-secret":');
  await assert.rejects(
    importConnections(store, file, {
      account: () => runtime.account?.accountId,
    }),
    (error) => error.message === "The connection file is not valid JSON.",
  );
});
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
  const rejected = assert.rejects(pending, /did not return a response/);
  await started;
  runtime.disconnect("codex");
  await rejected;
  const row = runtime.db
    .prepare("SELECT * FROM events ORDER BY rowid DESC LIMIT 1")
    .get();
  assert.equal(row.kind, "api_unresolved");
  assert.equal(runtime.apiRequests.size, 0);
});

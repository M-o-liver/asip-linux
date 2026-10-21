import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { Runtime } from "../beacon/runtime.mjs";
import { CloudSync } from "../beacon/cloud.mjs";
import { canonical, sha256 } from "../beacon/cloud-protocol.mjs";
import { accessClaims } from "../cloud/src/auth.mjs";
import { generateKeyPair, SignJWT } from "jose";

let mf, db, bucket;
const accountId = await sha256("cloud-owner"),
  otherId = await sha256("other-owner"),
  nativeId = await sha256("google:fixture");
const source = {
  id: "portable-record",
  at: "2026-10-21T12:00:00.000Z",
  agent: "antigravity",
  session: "native-conversation-1",
  project: "github.com/example/portable",
  kind: "result",
  summary: "Cross-agent continuity verified.",
  data: {
    source: { sha256: "a".repeat(64), step: 17 },
    cwd: "C:\\Work\\portable",
  },
};
before(async () => {
  const bundled = await build({
    entryPoints: [
      fileURLToPath(new URL("../cloud/src/worker.mjs", import.meta.url)),
    ],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundled.outputFiles[0].text,
      compatibilityDate: "2026-10-21",
      d1Databases: ["DB"],
      r2Buckets: ["RECORDS"],
      bindings: { ORIGIN: "https://asip.ca", PRIVATE_PREVIEW: "false" },
    }),
  );
  db = await mf.getD1Database("DB");
  bucket = await mf.getR2Bucket("RECORDS");
  await db.exec(
    fs
      .readFileSync(
        new URL(
          "../cloud/migrations/0002_session_catalogue.sql",
          import.meta.url,
        ),
        "utf8",
      )
      .replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS"),
  );
  await db.exec(
    fs.readFileSync(
      new URL("../cloud/migrations/0001_cloud.sql", import.meta.url),
      "utf8",
    ),
  );
  for (const [id, handle] of [
    [accountId, "owner"],
    [otherId, "other"],
  ])
    await db
      .prepare("INSERT INTO accounts VALUES(?,?,?,?)")
      .bind(id, handle, handle, new Date().toISOString())
      .run();
});
after(async () => {
  await mf?.dispose();
});
async function credential({
  account = accountId,
  kind = "device",
  agent = "beacon",
  scopes = ["memory:read", "memory:write", "sync:write"],
  projects = [],
} = {}) {
  const token = "asip_" + crypto.randomBytes(32).toString("hex"),
    id = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO credentials(hash,id,account_id,kind,label,agent,scopes,projects,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      await sha256(token),
      id,
      account,
      kind,
      "Fixture",
      agent,
      JSON.stringify(scopes),
      JSON.stringify(projects),
      "2026-10-21T00:00:00Z",
      "2099-01-01T00:00:00Z",
    )
    .run();
  return { token, id };
}
async function request(
  route,
  token,
  { method = "GET", value, headers = {} } = {},
) {
  return mf.dispatchFetch("https://asip.ca" + route, {
    method,
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(value !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
}
test("Access JWT verifies signature, issuer, audience and expiry without trusting an identity header", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const env = {
    PRIVATE_PREVIEW: "true",
    ACCESS_TEAM_DOMAIN: "fixture.cloudflareaccess.com",
    ACCESS_AUD: "asip-preview",
  };
  const token = await new SignJWT({ email: "fixture@example.com", type: "app" })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer("https://fixture.cloudflareaccess.com")
    .setAudience("asip-preview")
    .setSubject("native-user")
    .setExpirationTime("2m")
    .sign(privateKey);
  const claims = await accessClaims(
    new Request("https://asip.ca", {
      headers: { "Cf-Access-Jwt-Assertion": token },
    }),
    env,
    publicKey,
  );
  assert.equal(claims.sub, "native-user");
  await assert.rejects(
    accessClaims(
      new Request("https://asip.ca", {
        headers: {
          "Cf-Access-Authenticated-User-Email": "fixture@example.com",
        },
      }),
      env,
      publicKey,
    ),
    /preview gate/,
  );
  await assert.rejects(
    accessClaims(
      new Request("https://asip.ca", {
        headers: { "Cf-Access-Jwt-Assertion": token },
      }),
      { ...env, ACCESS_AUD: "other" },
      publicKey,
    ),
    /expired/,
  );
});
test("D1 and R2 preserve source bytes; retries are idempotent and conflicting batches are atomic", async () => {
  const c = await credential();
  let r = await request("/api/v1/sync/push", c.token, {
    method: "POST",
    value: { events: [source] },
  });
  assert.equal(r.status, 200, await r.clone().text());
  const digest = await sha256(canonical(source));
  assert.equal((await r.json()).accepted[0].sha256, digest);
  r = await request("/api/v1/sync/push", c.token, {
    method: "POST",
    value: { events: [source] },
  });
  assert.equal(r.status, 200);
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE account_id=? AND id=?")
        .bind(accountId, source.id)
        .first()
    ).n,
    1,
  );
  r = await request("/api/v1/sync/push", c.token, {
    method: "POST",
    value: {
      events: [
        { ...source, id: "must-not-commit" },
        { ...source, summary: "Conflicting evidence" },
      ],
    },
  });
  assert.equal(r.status, 409);
  assert.equal(
    await db
      .prepare("SELECT id FROM events WHERE account_id=? AND id=?")
      .bind(accountId, "must-not-commit")
      .first(),
    null,
  );
  r = await request("/api/v1/events/" + source.id + "/source", c.token);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-asip-sha256"), digest);
  assert.equal(await r.text(), canonical(source));
});
test("account isolation and project-scoped API tokens apply to search, evidence, sessions, projects and MCP", async () => {
  const owner = await credential(),
    other = await credential({ account: otherId }),
    scoped = await credential({
      kind: "api",
      agent: "codex",
      scopes: ["memory:read"],
      projects: ["github.com/example/allowed"],
    });
  assert.equal(
    (await request("/api/v1/events/portable-record/source", other.token))
      .status,
    404,
  );
  assert.deepEqual(
    (await (await request("/api/v1/events", other.token)).json()).events,
    [],
  );
  assert.equal(
    (await request("/api/v1/events/portable-record/source", scoped.token))
      .status,
    403,
  );
  assert.equal(
    (
      await request(
        "/api/v1/events?project=" + encodeURIComponent(source.project),
        scoped.token,
      )
    ).status,
    403,
  );
  assert.deepEqual(
    (await (await request("/api/v1/projects", scoped.token)).json()).projects,
    [],
  );
  assert.deepEqual(
    (await (await request("/api/v1/sessions", scoped.token)).json()).sessions,
    [],
  );
  const r = await request("/mcp", scoped.token, {
    method: "POST",
    value: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "asip_recall", arguments: { query: "continuity" } },
    },
  });
  assert.deepEqual(
    JSON.parse((await r.json()).result.content[0].text).events,
    [],
  );
  assert.equal(
    (
      await request("/api/v1/events", scoped.token, {
        method: "POST",
        value: { events: [source] },
      })
    ).status,
    403,
  );
  assert.equal((await request("/api/v1/devices", owner.token)).status, 403);
  assert.equal((await request("/api/v1/events")).status, 401);
});
test("revoked credentials stop access; append tokens cannot impersonate another agent", async () => {
  const c = await credential({
    kind: "api",
    agent: "claude-code",
    scopes: ["memory:read", "memory:write"],
  });
  assert.equal(
    (
      await request("/api/v1/events", c.token, {
        method: "POST",
        value: { events: [source] },
      })
    ).status,
    403,
  );
  await db
    .prepare("UPDATE credentials SET revoked_at=? WHERE id=?")
    .bind(new Date().toISOString(), c.id)
    .run();
  assert.equal((await request("/api/v1/events", c.token)).status, 401);
});
test("browser mutation requires same origin; pairing uses PKCE and atomically consumes its code", async () => {
  const session = crypto.randomBytes(32).toString("hex");
  await db
    .prepare("INSERT INTO browser_sessions VALUES(?,?,?)")
    .bind(await sha256(session), accountId, "2099-01-01T00:00:00Z")
    .run();
  const headers = { Cookie: "__Host-asip=" + session };
  const verifier = crypto.randomBytes(32).toString("hex"),
    state = crypto.randomBytes(32).toString("hex");
  const value = {
    challenge: await sha256(verifier),
    state,
    label: "Fixture laptop",
    platform: "win32",
    redirect: "http://127.0.0.1:49152/callback",
  };
  assert.equal(
    (
      await request("/api/v1/devices/authorize", null, {
        method: "POST",
        value,
        headers: { ...headers, Origin: "https://elsewhere.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/api/v1/devices/authorize", null, {
        method: "POST",
        value: { ...value, redirect: "https://elsewhere.example/" },
        headers: { ...headers, Origin: "https://asip.ca" },
      })
    ).status,
    400,
  );
  const authorized = await request("/api/v1/devices/authorize", null, {
    method: "POST",
    value,
    headers: { ...headers, Origin: "https://asip.ca" },
  });
  assert.equal(authorized.status, 200);
  const { code } = await authorized.json();
  assert.equal(
    (
      await request("/api/v1/devices/redeem", null, {
        method: "POST",
        value: { code, verifier: "0".repeat(64) },
      })
    ).status,
    401,
  );
  const redeemed = await request("/api/v1/devices/redeem", null, {
    method: "POST",
    value: { code, verifier },
  });
  assert.equal(redeemed.status, 200);
  assert.equal(
    (
      await request("/api/v1/devices/redeem", null, {
        method: "POST",
        value: { code, verifier },
      })
    ).status,
    401,
  );
});
test("Linux and Windows local stores exchange original native records and Codex recalls Antigravity evidence", async (t) => {
  const runtimes = [];
  function local() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "asip-cloud-")),
      runtime = new Runtime(home);
    runtime.signIn({
      accountId: nativeId,
      provider: "google",
      subject: "fixture",
      handle: "fixture@example.com",
    });
    runtimes.push({ runtime, home });
    return runtime;
  }
  const linux = local(),
    windows = local();
  t.after(async () => {
    for (const { runtime, home } of runtimes) {
      runtime.cloud?.stop();
      await runtime.close();
      fs.rmSync(home, { force: true, recursive: true });
    }
  });
  function connect(runtime, agent) {
    const verifier = crypto.randomBytes(32).toString("hex");
    const pending = runtime.requestSignIn({
      agent,
      challenge: crypto.createHash("sha256").update(verifier).digest("hex"),
    });
    runtime.completeSignIn(pending.requestId, runtime.account);
    return runtime.pollSignIn(pending.requestId, verifier).token;
  }
  const c1 = await credential(),
    c2 = await credential();
  function cloud(runtime, c) {
    const sync = new CloudSync(runtime, {
      seal: (v) => Buffer.from(v),
      unseal: (v) => v.toString(),
      fetcher: (url, options) => mf.dispatchFetch(url, options),
    });
    sync.load();
    sync.connection = {
      ...c,
      account: { id: accountId, handle: "owner" },
      origin: "https://asip.ca",
    };
    sync
      .schema()
      .prepare("INSERT INTO cloud_binding VALUES(1,?)")
      .run(accountId);
    return sync;
  }
  const s1 = cloud(linux, c1),
    s2 = cloud(windows, c2),
    ag = connect(linux, "antigravity"),
    codex = connect(windows, "codex");
  const recorded = linux.record(ag, {
    session: "linux-native-session",
    project: "github.com/example/portable",
    kind: "result",
    summary: "Linux handoff with source evidence",
    data: {
      source: { sha256: "b".repeat(64), step: 11 },
      cwd: "/home/user/project",
    },
  });
  await s1.sync();
  await s2.sync();
  const recalled = windows.recall(codex, {
    project: "github.com/example/portable",
    query: "Linux handoff",
  }).events[0];
  assert.equal(recalled.id, recorded.id);
  assert.equal(recalled.session, "linux-native-session");
  assert.equal(recalled.agent, "antigravity");
  assert.equal(recalled.data.source.step, 11);
  await s1.sync();
  await s2.sync();
  assert.equal(
    windows
      .storage()
      .prepare("SELECT count(*) AS n FROM events WHERE id=?")
      .get(recorded.id).n,
    1,
  );
  const original = linux
    .storage()
    .prepare("SELECT * FROM events WHERE id=?")
    .get(recorded.id);
  const retry = new CloudSync(linux, {
    seal: (v) => Buffer.from(v),
    unseal: (v) => v.toString(),
    fetcher: async () => {
      throw Error("Offline fixture");
    },
  });
  retry.load();
  retry.connection = s1.connection;
  const offline = linux.record(ag, {
    session: "linux-native-session",
    project: "github.com/example/portable",
    kind: "result",
    summary: "Recorded while offline",
    data: {},
  });
  await assert.rejects(retry.sync(), /Offline fixture/);
  assert.equal(
    linux.storage().prepare("SELECT id FROM events WHERE id=?").get(offline.id)
      .id,
    offline.id,
  );
  linux.cloud = s1;
  await s1.sync();
  await s2.sync();
  assert.equal(
    windows.recall(codex, { query: "Recorded while offline" }).events[0].id,
    offline.id,
  );
  assert.deepEqual(
    linux.storage().prepare("SELECT * FROM events WHERE id=?").get(recorded.id),
    original,
  );
});

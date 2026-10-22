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
import {
  deviceKey,
  sealDeviceReply,
  openDeviceReply,
} from "../beacon/device-link.mjs";
import { accessClaims, signinClaims } from "../cloud/src/auth.mjs";
import { catalogue, readCatalogue, listEvents } from "../cloud/src/memory.mjs";
import { serviceError } from "../cloud/src/http.mjs";
import {
  activityIndex,
  scopedActivity,
  activityProjects,
  activitySessions,
  activityRelationships,
} from "../cloud/src/activity.mjs";
import { encryptionFixture } from "./encryption-fixture.mjs";
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
      ratelimits: {
        PAIR_LIMIT: {
          namespace_id: "27274001",
          simple: { limit: 30, period: 60 },
        },
        API_LIMIT: {
          namespace_id: "27274002",
          simple: { limit: 120, period: 60 },
        },
        SYNC_LIMIT: {
          namespace_id: "27274003",
          simple: { limit: 240, period: 60 },
        },
      },
      bindings: { ORIGIN: "https://asip.ca", PRIVATE_PREVIEW: "false" },
    }),
  );
  db = await mf.getD1Database("DB");
  bucket = await mf.getR2Bucket("RECORDS");
  const migrationDirectory = new URL("../cloud/migrations/", import.meta.url);
  for (const name of fs
    .readdirSync(migrationDirectory)
    .filter((n) => n.endsWith(".sql"))
    .sort())
    await db.exec(fs.readFileSync(new URL(name, migrationDirectory), "utf8"));
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
test("durable activity index scans new rows once, matches SQL counts, and costs no idle writes", async () => {
  const c = await credential({ account: otherId });
  const events = [
    {
      ...source,
      id: "index-a1",
      project: "index-a",
      agent: "codex",
      session: "shared",
      at: "2026-10-21T12:00:00Z",
    },
    {
      ...source,
      id: "index-a2",
      project: "index-a",
      agent: "codex",
      session: "shared",
      at: "2026-10-21T13:00:00Z",
    },
    {
      ...source,
      id: "index-b",
      project: "index-b",
      agent: "codex",
      session: "shared",
    },
    {
      ...source,
      id: "index-other-agent",
      project: "index-a",
      agent: "antigravity",
      session: "shared",
    },
    {
      ...source,
      id: "index-null",
      project: null,
      agent: "codex",
      session: "shared",
    },
  ];
  const push = (rows) =>
    request("/api/v1/sync/push", c.token, {
      method: "POST",
      value: { events: rows },
    });
  assert.equal((await push(events)).status, 200);
  let reads = 0,
    writes = 0,
    puts = 0,
    aggregateQueries = 0;
  const sqls = [];
  const metered = {
    DB: {
      prepare(sql) {
        sqls.push(sql);
        if (sql.includes("GROUP BY")) aggregateQueries++;
        const statement = db.prepare(sql);
        return {
          bind: (...values) => {
            const bound = statement.bind(...values);
            const run = async () => {
              const result = await bound.all();
              reads += result.meta.rows_read;
              writes += result.meta.rows_written;
              return result;
            };
            return {
              all: run,
              first: async () => (await run()).results[0] || null,
            };
          },
        };
      },
    },
    RECORDS: {
      get: (...args) => bucket.get(...args),
      put: (...args) => {
        puts++;
        return bucket.put(...args);
      },
    },
  };
  const auth = { accountId: otherId, projects: [] };
  let index = await activityIndex(metered, otherId);
  assert.equal(aggregateQueries, 1);
  assert.equal(writes, 0);
  assert.equal(puts, 1);
  assert.equal(activitySessions(index.rows)[0].events, 4);
  assert.equal(
    activityProjects(index.rows).find((p) => p.id === "index-a").sessions,
    2,
  );
  assert.deepEqual(activityRelationships(index.rows), [
    { source: "index-a", target: "index-b", sessions: 1 },
  ]);
  assert.equal(
    scopedActivity(index, { ...auth, projects: ["index-a"] }).length,
    2,
  );
  assert.deepEqual(
    activityRelationships(
      scopedActivity(index, { ...auth, projects: ["index-a"] }),
    ),
    [],
  );
  assert.throws(
    () =>
      scopedActivity(
        index,
        { ...auth, projects: ["index-a"] },
        new URLSearchParams({ project: "index-b" }),
      ),
    /restricted/,
  );
  assert.equal(
    activitySessions(
      scopedActivity(
        index,
        auth,
        new URLSearchParams({ project: "unassigned" }),
      ),
    )[0].events,
    1,
  );
  const startReads = reads;
  for (let i = 0; i < 10; i++) await activityIndex(metered, otherId);
  assert.equal(
    aggregateQueries,
    1,
    "idle and cold reads never re-aggregate history",
  );
  assert.ok(
    reads - startReads <= 20,
    "indexed MAX must have constant row cost",
  );
  assert.equal(puts, 1, "idle visits must not write R2");
  assert.equal(writes, 0);
  assert.equal(
    (await push([events[0]])).status,
    200,
    "duplicate upload is idempotent",
  );
  await activityIndex(metered, otherId);
  assert.equal(aggregateQueries, 1);
  const older = {
    ...events[0],
    id: "index-backfill",
    at: "2026-10-01T00:00:00Z",
  };
  assert.equal((await push([older])).status, 200);
  const beforeTailReads = reads;
  index = await activityIndex(metered, otherId);
  assert.ok(
    reads - beforeTailReads <= 5,
    "one new row must not rescan the old history",
  );
  assert.equal(aggregateQueries, 2);
  assert.equal(
    index.rows.find((r) => r.project === "index-a" && r.agent === "codex")
      .startedAt,
    older.at,
  );
  assert.equal(
    activityProjects(index.rows).find((p) => p.id === "index-a").events,
    4,
  );
  const expected = (
    await db
      .prepare(
        "SELECT project,agent,session,COUNT(*) AS events,MIN(at) AS startedAt,MAX(at) AS lastActivity FROM events WHERE account_id=? GROUP BY project,agent,session",
      )
      .bind(otherId)
      .all()
  ).results;
  const ordered = (rows) =>
    [...rows].sort((a, b) =>
      JSON.stringify([a.project, a.agent, a.session]).localeCompare(
        JSON.stringify([b.project, b.agent, b.session]),
      ),
    );
  assert.deepEqual(ordered(index.rows), ordered(expected));
  assert.ok(
    sqls
      .filter((s) => s.includes("GROUP BY"))
      .every((s) => /seq>\? AND seq<=\?/.test(s)),
  );
  await assert.rejects(
    activityIndex(
      {
        ...metered,
        RECORDS: { get: () => Promise.reject(Error("R2 unavailable")) },
      },
      otherId,
    ),
    /R2 unavailable/,
  );
  assert.equal(
    aggregateQueries,
    2,
    "R2 failures must not fall back to expensive scans",
  );
  // Leave the other-owner isolation fixture empty for subsequent API checks.
  await db.prepare("DELETE FROM events WHERE account_id=?").bind(otherId).run();
  await bucket.delete(otherId + "/indexes/activity-v1.json");
});

test("activity index compare-and-swap retries cannot lose or double-count concurrent updates", async () => {
  const c = await credential({ account: otherId });
  const base = { ...source, id: "index-race-base" };
  const push = (event) =>
    request("/api/v1/sync/push", c.token, {
      method: "POST",
      value: { events: [event] },
    });
  assert.equal((await push(base)).status, 200);
  const env = { DB: db, RECORDS: bucket };
  await activityIndex(env, otherId);
  assert.equal((await push({ ...base, id: "index-race-first" })).status, 200);
  let raced = false;
  const competitor = {
    DB: db,
    RECORDS: {
      get: (...args) => bucket.get(...args),
      async put(...args) {
        if (!raced) {
          raced = true;
          assert.equal(
            (await push({ ...base, id: "index-race-second" })).status,
            200,
          );
          await activityIndex(env, otherId);
        }
        return bucket.put(...args);
      },
    },
  };
  const result = await activityIndex(competitor, otherId);
  assert.equal(result.rows[0].events, 3);
  assert.equal((await activityIndex(env, otherId)).rows[0].events, 3);
  const key = otherId + "/indexes/activity-v1.json";
  const saved = await bucket.get(key);
  const invalid = await saved.json();
  invalid.accountId = accountId;
  await bucket.put(key, JSON.stringify(invalid));
  await assert.rejects(
    activityIndex(env, otherId),
    /counts are temporarily unavailable/,
  );
  await db.prepare("DELETE FROM events WHERE account_id=?").bind(otherId).run();
  await bucket.delete(key);
});

test("15,000-record workspace has constant warm aggregate cost and indexed work history", async () => {
  const id = await sha256("activity-read-budget");
  await db
    .prepare("INSERT INTO accounts VALUES(?,?,?,?)")
    .bind(id, "read-budget", "Read budget fixture", source.at)
    .run();
  await db
    .prepare(
      "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<15000) INSERT INTO events(account_id,id,at,agent,session,kind,project,summary,data,sha256,object_key,device_id,received_at) SELECT ?,'budget-'||x,?,'codex','session-'||(x%101),CASE WHEN x%100=0 THEN 'Stop' ELSE 'PreToolUse' END,'project-'||(x%17),'Recorded work','{}','fixture','fixture','fixture',? FROM n",
    )
    .bind(id, source.at, source.at)
    .run();
  let reads = 0,
    writes = 0;
  const costs = [];
  const env = {
    RECORDS: bucket,
    DB: {
      prepare(sql) {
        const statement = db.prepare(sql);
        return {
          bind(...values) {
            const bound = statement.bind(...values);
            const all = async () => {
              const result = await bound.all();
              reads += result.meta.rows_read;
              writes += result.meta.rows_written;
              costs.push({
                sql,
                reads: result.meta.rows_read,
                writes: result.meta.rows_written,
              });
              return result;
            };
            return { all, first: async () => (await all()).results[0] || null };
          },
        };
      },
    },
  };
  let index = await activityIndex(env, id);
  const bootstrapReads = reads;
  const first = index;
  for (let i = 0; i < 20; i++) {
    index = await activityIndex(env, id);
    assert.deepEqual(
      activityProjects(index.rows),
      activityProjects(first.rows),
    );
    assert.equal(activitySessions(index.rows).length, 100);
    assert.equal(activityRelationships(index.rows).length, 100);
  }
  const warmReads = reads - bootstrapReads;
  assert.ok(
    warmReads <= 40,
    "twenty warm aggregate loads must not scale with 15,000 history rows",
  );
  assert.equal(writes, 0);
  const auth = { accountId: id, projects: [] };
  const beforeHistory = reads;
  const page = await listEvents(
    env,
    auth,
    new URLSearchParams({ category: "work", limit: "30" }),
  );
  const historyReads = reads - beforeHistory;
  assert.equal(page.events.length, 30);
  assert.ok(page.events.every((r) => r.kind === "Stop"));
  assert.ok(
    historyReads <= 64,
    "work pagination must skip low-level tool evidence in the index",
  );
  const old = await db
    .prepare(
      "WITH memberships AS (SELECT DISTINCT agent,session,project FROM events WHERE account_id=? AND project IS NOT NULL) SELECT a.project AS source,b.project AS target,COUNT(*) AS sessions FROM memberships a JOIN memberships b ON a.agent=b.agent AND a.session=b.session AND a.project<b.project GROUP BY a.project,b.project ORDER BY a.project,b.project LIMIT 100",
    )
    .bind(id)
    .all();
  assert.deepEqual(activityRelationships(index.rows), old.results);
  assert.ok(old.meta.rows_read > warmReads * 100);
  const before = reads;
  await db
    .prepare(
      "INSERT INTO events(account_id,id,at,agent,session,kind,project,summary,data,sha256,object_key,device_id,received_at) VALUES(?, 'budget-new', ?, 'codex', 'session-new', 'result', 'project-new', 'New work', '{}', 'fixture', 'fixture', 'fixture', ?)",
    )
    .bind(id, source.at, source.at)
    .run();
  index = await activityIndex(env, id);
  const tailReads = reads - before;
  assert.ok(
    tailReads <= 5,
    "one new record must have constant incremental row cost",
  );
  assert.equal(
    activityProjects(index.rows).find((p) => p.id === "project-new").events,
    1,
  );
  console.info(
    "D1 activity read budget:",
    JSON.stringify({
      records: 15000,
      bootstrapReads,
      twentyWarmLoads: warmReads,
      workPageReads: historyReads,
      singleRecordTailReads: tailReads,
      oldRelationshipReads: old.meta.rows_read,
      writes,
      costs,
    }),
  );
});

test("relationship expansion stays bounded while preserving exact selected pair counts", () => {
  const rows = [];
  for (let session = 0; session < 4; session++)
    for (let project = session; project < 200; project++)
      rows.push({
        project: "project-" + String(project).padStart(3, "0"),
        agent: "codex",
        session: String(session),
        events: 1,
        startedAt: source.at,
        lastActivity: source.at,
      });
  const result = activityRelationships(rows);
  assert.equal(result.length, 100);
  assert.deepEqual(result[0], {
    source: "project-000",
    target: "project-001",
    sessions: 1,
  });
  assert.deepEqual(result.at(-1), {
    source: "project-000",
    target: "project-100",
    sessions: 1,
  });
  assert.equal(activityRelationships(rows.slice().reverse()).length, 100);
  assert.deepEqual(activityRelationships(rows.slice().reverse()), result);
});

test("unchanged metadata and authenticated reads consume no D1 writes", async () => {
  const c = await credential();
  const auth = { accountId, credential: { id: c.id, kind: "device" } };
  let writes = 0;
  const metered = {
    DB: {
      prepare: (...args) => db.prepare(...args),
      batch: async (statements) => {
        const results = await db.batch(statements);
        writes += results.reduce((n, r) => n + r.meta.rows_written, 0);
        return results;
      },
    },
  };
  const metadata = {
    reset: true,
    projects: [{ id: "quota-project", name: "Quota fixture", roots: [] }],
    sessions: [
      {
        agent: "codex",
        session: "quota-session",
        details: { title: "Unchanged" },
      },
    ],
    connections: [
      { name: "quota.connection", provider: "github", projects: [] },
    ],
  };
  await catalogue(metered, auth, metadata);
  assert.ok(writes > 0);
  writes = 0;
  await catalogue(metered, auth, metadata);
  assert.equal(writes, 0, "legacy reset must not rewrite identical metadata");
  metadata.sessions[0].details.title = "One changed session";
  await catalogue(metered, auth, metadata);
  assert.equal(writes, 1, "only the changed session is written");
  const readOnly = {
    DB: {
      prepare(sql) {
        assert.equal(
          /FROM events/i.test(sql),
          false,
          "device metadata must not scan history",
        );
        return db.prepare(sql);
      },
    },
  };
  assert.ok(
    (await readCatalogue(readOnly, auth)).projects.some(
      (p) => p.id === "quota-project",
    ),
  );
  const rateRowsBefore = (
    await db.prepare("SELECT count(*) AS n FROM rate_limits").first()
  ).n;
  assert.equal((await request("/api/v1/me", c.token)).status, 200);
  assert.equal(
    (await db.prepare("SELECT count(*) AS n FROM rate_limits").first()).n,
    rateRowsBefore,
  );
  writes = 0;
  await catalogue(metered, auth, { pruneConnections: [] });
  assert.equal(writes, 1, "only the removed connection is written");
  assert.equal(
    (
      await db
        .prepare(
          "SELECT count(*) AS n FROM connection_catalogue WHERE device_id=?",
        )
        .bind(c.id)
        .first()
    ).n,
    0,
  );
});
test("quota errors are actionable and native retries remain paused across restart", async (t) => {
  const response = serviceError(
    Error(
      "D1_ERROR: Your account has exceeded D1's free tier daily row write limit.",
    ),
  );
  assert.equal(response.status, 503);
  const failure = await response.json();
  assert.equal(failure.code, "CLOUD_DAILY_QUOTA");
  assert.ok(failure.retryAfter >= 60 && failure.retryAfter <= 86400);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "asip-quota-"));
  const runtime = new Runtime(home);
  runtime.signIn({
    accountId: nativeId,
    provider: "google",
    subject: "fixture",
    handle: "fixture",
  });
  t.after(async () => {
    runtime.cloud?.stop();
    await runtime.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  let requests = 0;
  const options = {
    seal: (v) => Buffer.from(v),
    unseal: (v) => v.toString(),
    fetcher: async () => {
      requests++;
      return new Response(JSON.stringify(failure), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
  const sync = new CloudSync(runtime, options);
  sync.load();
  sync.connection = {
    id: "quota-device",
    token: "fixture",
    account: { id: accountId, handle: "owner" },
    origin: "https://asip.ca",
  };
  sync.schema().prepare("INSERT INTO cloud_binding VALUES(1,?)").run(accountId);
  await assert.rejects(sync.sync(), /daily database allowance/);
  const retryAt = sync.retryAt;
  assert.equal(
    sync.status().reconnectRequired,
    false,
    "a quota error does not ask the owner to reconnect",
  );
  assert.equal(sync.connection.quotaRetryAt, retryAt);
  await assert.rejects(sync.sync(), /daily database allowance/);
  assert.equal(requests, 1);
  const restarted = new CloudSync(runtime, options);
  restarted.load();
  assert.equal(restarted.retryAt, retryAt);
  await assert.rejects(restarted.sync(), /daily database allowance/);
  assert.equal(requests, 1, "restarting Beacon must not bypass quota backoff");
});
test("metadata from multiple computers returns each native session once", async () => {
  const devices = await Promise.all([credential(), credential(), credential()]);
  for (const device of devices)
    await catalogue(
      { DB: db },
      { accountId, credential: { id: device.id, kind: "device" } },
      {
        sessions: [
          {
            agent: "codex",
            session: "same-native-session-across-devices",
            details: { title: "Original native session" },
          },
        ],
      },
    );
  const result = await readCatalogue(
    { DB: db },
    { accountId, credential: { id: devices[0].id, kind: "device" } },
  );
  assert.equal(
    result.sessions.filter(
      (s) => s.session === "same-native-session-across-devices",
    ).length,
    1,
    "replicas must not consume the unique-session metadata limit",
  );
});
test("native metadata sends only changes, survives restart, and prunes removed connection names", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "asip-metadata-delta-"));
  const runtime = new Runtime(home);
  runtime.signIn({
    accountId: nativeId,
    provider: "google",
    subject: "fixture",
    handle: "fixture",
  });
  t.after(async () => {
    runtime.cloud?.stop();
    await runtime.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const database = runtime.storage();
  for (let i = 0; i < 65; i++)
    database
      .prepare("INSERT INTO session_details VALUES(?,?,?)")
      .run(
        "codex",
        "delta-session-" + i,
        JSON.stringify({ title: "Session " + i }),
      );
  let connections = [
    { name: "delta.connection", provider: "github", projects: [] },
  ];
  runtime.connectionStore = { list: () => connections, clear() {} };
  const posts = [],
    reads = [];
  const options = {
    seal: (v) => Buffer.from(v),
    unseal: (v) => v.toString(),
    fetcher: async (url, init = {}) => {
      const route = new URL(url).pathname;
      if (route.endsWith("/catalogue") && init.method === "POST") {
        posts.push(JSON.parse(init.body));
        return Response.json({ saved: true });
      }
      reads.push(route);
      if (route.endsWith("/pull"))
        return Response.json({ events: [], cursor: 0, more: false });
      if (route.endsWith("/catalogue"))
        return Response.json({ projects: [], links: [], sessions: [] });
      if (route.endsWith("/me"))
        return Response.json({ account: { id: accountId, handle: "owner" } });
      throw Error("Unexpected fixture request: " + route);
    },
  };
  const sync = new CloudSync(runtime, options);
  sync.load();
  sync.connection = {
    id: "delta-device",
    token: "fixture",
    account: { id: accountId, handle: "owner" },
    origin: "https://asip.ca",
  };
  sync.schema().prepare("INSERT INTO cloud_binding VALUES(1,?)").run(accountId);
  sync.persist();
  await sync.sync();
  assert.equal(posts.length, 3);
  posts.length = reads.length = 0;
  await sync.sync();
  assert.equal(posts.length, 0);
  assert.deepEqual(
    reads,
    ["/api/v1/sync/pull"],
    "idle sync must only check the indexed event cursor",
  );
  const restarted = new CloudSync(runtime, options);
  await restarted.sync();
  assert.equal(posts.length, 0, "metadata acknowledgments survive restart");
  database
    .prepare("UPDATE session_details SET details=? WHERE session=?")
    .run(JSON.stringify({ title: "Changed session" }), "delta-session-23");
  await restarted.sync();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].sessions.length, 1);
  assert.equal(posts[0].sessions[0].session, "delta-session-23");
  posts.length = 0;
  connections = [];
  await restarted.sync();
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].pruneConnections, []);
  posts.length = 0;
  await restarted.sync();
  assert.equal(posts.length, 0);
});
test("history pagination follows original time during out-of-order backfill", async () => {
  const c = await credential();
  const events = [
    {
      ...source,
      id: "sort-new",
      project: "github.com/example/sort",
      at: "2026-10-21T15:00:00.000Z",
    },
    {
      ...source,
      id: "sort-old",
      project: "github.com/example/sort",
      at: "2026-10-20T15:00:00.000Z",
    },
    {
      ...source,
      id: "sort-tie",
      project: "github.com/example/sort",
      at: "2026-10-21T15:00:00.000Z",
    },
  ];
  assert.equal(
    (
      await request("/api/v1/sync/push", c.token, {
        method: "POST",
        value: { events },
      })
    ).status,
    200,
  );
  const first = await (
    await request(
      "/api/v1/events?project=github.com/example/sort&limit=1",
      c.token,
    )
  ).json();
  assert.equal(first.events[0].id, "sort-tie");
  const second = await (
    await request(
      "/api/v1/events?project=github.com/example/sort&limit=1&before=" +
        encodeURIComponent(first.next),
      c.token,
    )
  ).json();
  assert.equal(second.events[0].id, "sort-new");
  const third = await (
    await request(
      "/api/v1/events?project=github.com/example/sort&limit=1&before=" +
        encodeURIComponent(second.next),
      c.token,
    )
  ).json();
  assert.equal(third.events[0].id, "sort-old");
  assert.equal(third.next, null);
});
test("native browser handoff stores encrypted credentials, resumes after restart, and disconnect revokes access", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "asip-pair-")),
    runtime = new Runtime(home),
    cipher = encryptionFixture();
  runtime.signIn({
    accountId: nativeId,
    provider: "google",
    subject: "fixture",
    handle: "fixture@example.com",
  });
  const session = crypto.randomBytes(32).toString("hex");
  await db
    .prepare("INSERT INTO browser_sessions VALUES(?,?,?)")
    .bind(await sha256(session), accountId, "2099-01-01T00:00:00Z")
    .run();
  const sync = new CloudSync(runtime, {
    ...cipher,
    fetcher: (url, options) => mf.dispatchFetch(url, options),
    openBrowser: async (url) => {
      const params = new URL(url).searchParams;
      const response = await request("/api/v1/devices/authorize", null, {
        method: "POST",
        value: Object.fromEntries(params),
        headers: {
          Cookie: "__Host-asip=" + session,
          Origin: "https://asip.ca",
          "Cf-Access-Jwt-Assertion": "fixture-private-preview-assertion",
        },
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(
        result.redirect.includes("fixture-private-preview-assertion"),
        false,
      );
      assert.deepEqual(Object.keys(result), ["redirect"]);
      const forged = new URL(result.redirect);
      forged.searchParams.set("response", "invalid");
      assert.equal((await fetch(forged)).status, 400);
      assert.equal(
        (await fetch(result.redirect, { method: "POST" })).status,
        400,
      );
      const callback = await fetch(result.redirect, { redirect: "manual" });
      assert.equal(callback.status, 303);
      assert.equal(
        callback.headers.get("location"),
        "https://asip.ca/auth/access",
      );
    },
  });
  t.after(async () => {
    runtime.cloud?.stop();
    await runtime.cloud?.inflight?.catch(() => {});
    await runtime.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  await sync.connect();
  assert.equal(sync.connection.access, "fixture-private-preview-assertion");
  await sync.sync();
  sync.stop();
  const saved = fs.readFileSync(sync.file);
  assert.equal(saved.includes(Buffer.from(sync.connection.token)), false);
  const token = sync.connection.token;
  const restarted = new CloudSync(runtime, {
    ...cipher,
    fetcher: (url, options) => mf.dispatchFetch(url, options),
  });
  restarted.load();
  assert.equal(restarted.connection.token, token);
  await restarted.sync();
  await restarted.disconnect();
  assert.equal((await request("/api/v1/me", token)).status, 401);
  assert.equal(fs.existsSync(restarted.file), false);
  assert.equal(
    runtime
      .storage()
      .prepare("SELECT account_id FROM cloud_binding WHERE id=1")
      .get().account_id,
    accountId,
  );
});
test("device replies bind encryption to the initiating key, challenge, and state", async () => {
  const link = await deviceKey(),
    other = await deviceKey(),
    challenge = "a".repeat(64),
    state = "b".repeat(64),
    value = { code: "c".repeat(64), state, access: "private-admission" };
  const reply = await sealDeviceReply(value, link.publicKey, challenge, state);
  assert.equal(reply.includes(value.access), false);
  assert.deepEqual(
    await openDeviceReply(reply, link.privateKey, challenge, state),
    value,
  );
  await assert.rejects(
    openDeviceReply(reply, other.privateKey, challenge, state),
  );
  await assert.rejects(
    openDeviceReply(reply, link.privateKey, "0".repeat(64), state),
  );
  await assert.rejects(
    openDeviceReply(reply, link.privateKey, challenge, "0".repeat(64)),
  );
  await assert.rejects(
    openDeviceReply("bad", link.privateKey, challenge, state),
  );
  await assert.rejects(
    sealDeviceReply(value, "04" + "0".repeat(128), challenge, state),
  );
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
test("delegated preview admission cannot mint an account-owner sign-in session", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const env = {
    PRIVATE_PREVIEW: "true",
    ACCESS_TEAM_DOMAIN: "fixture.cloudflareaccess.com",
    ACCESS_AUD: "asip-preview",
    ACCESS_SIGNIN_AUD: "asip-account-signin",
  };
  const token = (aud, type = "app", expiration = "2m") =>
    new SignJWT({ email: "fixture@example.com", type })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("https://fixture.cloudflareaccess.com")
      .setAudience(aud)
      .setSubject("same-native-user")
      .setExpirationTime(expiration)
      .sign(privateKey);
  const requestFor = (value) =>
    new Request("https://asip.ca/auth/access", {
      headers: { "Cf-Access-Jwt-Assertion": value },
    });
  const preview = await token(env.ACCESS_AUD);
  assert.equal(
    (await accessClaims(requestFor(preview), env, publicKey)).sub,
    "same-native-user",
  );
  await assert.rejects(
    signinClaims(requestFor(preview), env, publicKey),
    /expired/,
  );
  const signin = await token(env.ACCESS_SIGNIN_AUD);
  assert.equal(
    (await signinClaims(requestFor(signin), env, publicKey)).sub,
    "same-native-user",
    "the separate audience retains the durable Access identity",
  );
  await assert.rejects(
    signinClaims(
      requestFor(await token(env.ACCESS_SIGNIN_AUD, "org")),
      env,
      publicKey,
    ),
    /expired/,
  );
  await assert.rejects(
    signinClaims(
      requestFor(await token(env.ACCESS_SIGNIN_AUD, "app", 0)),
      env,
      publicKey,
    ),
    /expired/,
  );
  await assert.rejects(
    signinClaims(
      requestFor(preview),
      { ...env, ACCESS_SIGNIN_AUD: "" },
      publicKey,
    ),
    /not configured/,
  );
  await assert.rejects(
    signinClaims(
      requestFor(preview),
      { ...env, ACCESS_SIGNIN_AUD: env.ACCESS_AUD },
      publicKey,
    ),
    /not configured/,
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
test("project-scoped agents see global and assigned connection names without unrelated metadata", async () => {
  const device = await credential();
  const project = "github.com/example/connection-scope";
  const scoped = await credential({
    kind: "api",
    agent: "codex",
    scopes: ["memory:read"],
    projects: [project],
  });
  await catalogue(
    { DB: db },
    { accountId, credential: { id: device.id, kind: "device" } },
    {
      connections: [
        { name: "scope.global", provider: "github", projects: [] },
        { name: "scope.assigned", provider: "github", projects: [project] },
        {
          name: "scope.unrelated",
          provider: "github",
          projects: ["github.com/example/unrelated"],
        },
      ],
    },
  );
  const response = await request("/api/v1/connections", scoped.token);
  assert.equal(response.status, 200);
  const names = (await response.json()).connections.map((c) => c.name);
  assert.ok(names.includes("scope.global"));
  assert.ok(names.includes("scope.assigned"));
  assert.equal(names.includes("scope.unrelated"), false);
});
test("browser mutation requires same origin; pairing uses PKCE and atomically consumes its code", async () => {
  const session = crypto.randomBytes(32).toString("hex");
  await db
    .prepare("INSERT INTO browser_sessions VALUES(?,?,?)")
    .bind(await sha256(session), accountId, "2099-01-01T00:00:00Z")
    .run();
  const headers = { Cookie: "__Host-asip=" + session };
  assert.equal(
    (
      await request("/api/v1/me", null, {
        headers: { ...headers, Authorization: "Bearer invalid" },
      })
    ).status,
    401,
  );
  const verifier = crypto.randomBytes(32).toString("hex"),
    state = crypto.randomBytes(32).toString("hex"),
    link = await deviceKey();
  const value = {
    challenge: await sha256(verifier),
    state,
    publicKey: link.publicKey,
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
  const { redirect } = await authorized.json();
  const { code } = await openDeviceReply(
    new URL(redirect).searchParams.get("response"),
    link.privateKey,
    value.challenge,
    state,
  );
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
  linux
    .storage()
    .prepare("INSERT INTO projects VALUES(?,?,?,?,?,?)")
    .run(
      "github.com/example/empty",
      "Named project",
      "Preserved project description",
      "github.com/example/empty",
      "2026-10-21T00:00:00Z",
      JSON.stringify(["/home/user/empty"]),
    );
  linux
    .storage()
    .prepare("INSERT INTO session_details VALUES(?,?,?)")
    .run(
      "antigravity",
      "linux-native-session",
      JSON.stringify({ title: "Native session title" }),
    );
  linux.connectionStore = {
    list: () => [
      {
        name: "github.work",
        provider: "github",
        label: "GitHub",
        origin: "https://api.github.com",
        projects: [],
        credential: "never-upload-this-credential",
      },
    ],
    clear() {},
  };
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
  assert.equal(
    windows.projects().find((p) => p.id === "github.com/example/empty")
      .description,
    "Preserved project description",
  );
  assert.equal(
    JSON.parse(
      windows
        .storage()
        .prepare(
          "SELECT details FROM session_details WHERE agent=? AND session=?",
        )
        .get("antigravity", "linux-native-session").details,
    ).title,
    "Native session title",
  );
  assert.equal(
    JSON.stringify(
      await (await request("/api/v1/connections", c1.token)).json(),
    ).includes("never-upload-this-credential"),
    false,
  );
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

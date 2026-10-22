import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { sha256 } from "../beacon/cloud-protocol.mjs";
import { accountForIdentity } from "../cloud/src/auth.mjs";
import {
  entitlement,
  ensureTrial,
  billingRoute,
  verifyWebhook,
  webhook,
} from "../cloud/src/billing.mjs";
let mf, db;
const origin = "https://asip.ca",
  founder = "f".repeat(64);
before(async () => {
  const bundled = await build({
    entryPoints: ["cloud/src/worker.mjs"],
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
      ratelimits: Object.fromEntries(
        ["PAIR_LIMIT", "API_LIMIT", "SYNC_LIMIT"].map((name, i) => [
          name,
          {
            namespace_id: String(27274011 + i),
            simple: { limit: 120, period: 60 },
          },
        ]),
      ),
      bindings: {
        ORIGIN: origin,
        PRIVATE_PREVIEW: "false",
        BILLING_ENFORCED: "true",
        GITHUB_CLIENT_ID: "github-fixture",
        GITHUB_CLIENT_SECRET: "github-secret",
        GOOGLE_WEB_CLIENT_ID: "google-fixture",
        GOOGLE_WEB_CLIENT_SECRET: "google-secret",
      },
    }),
  );
  db = await mf.getD1Database("DB");
  for (const file of fs
    .readdirSync("cloud/migrations")
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    if (file === "0005_saas.sql")
      await db
        .prepare("INSERT INTO accounts VALUES(?,?,?,?)")
        .bind(founder, "founder", "Founder", new Date().toISOString())
        .run();
    await db.exec(fs.readFileSync("cloud/migrations/" + file, "utf8"));
  }
});
after(async () => mf?.dispose());
test("migration preserves existing owners and a new sign-in starts exactly one 7-day trial", async () => {
  assert.equal(
    entitlement(await ensureTrial({ DB: db }, founder)).status,
    "founder",
  );
  const account = await accountForIdentity(
    { DB: db },
    "github",
    "trial-member",
    { name: "Trial member", email: "trial@example.test" },
  );
  const trial = await ensureTrial({ DB: db }, account.id);
  assert.equal(
    Date.parse(trial.trial_ends_at) - Date.parse(trial.trial_started_at),
    7 * 86400000,
  );
  assert.equal(entitlement(trial).allowed, true);
  assert.equal(
    entitlement(trial, Date.parse(trial.trial_ends_at)).allowed,
    false,
  );
  assert.equal(
    (await accountForIdentity({ DB: db }, "github", "trial-member", {})).id,
    account.id,
  );
  assert.equal(
    (await ensureTrial({ DB: db }, account.id)).trial_ends_at,
    trial.trial_ends_at,
  );
});
test("expired trial is enforced for HTTP and MCP while billing, account management and revocation remain reachable", async () => {
  const account = await accountForIdentity(
    { DB: db },
    "github",
    "expired-member",
    { name: "Expired" },
  );
  await db
    .prepare(
      "UPDATE billing_accounts SET trial_ends_at='2000-01-01T00:00:00Z' WHERE account_id=?",
    )
    .bind(account.id)
    .run();
  const token = "asip_" + "a".repeat(64),
    session = "b".repeat(64);
  await db
    .prepare(
      "INSERT INTO credentials(hash,id,account_id,kind,label,agent,scopes,projects,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      await sha256(token),
      "d186be46-e3ea-4c51-8a04-b5313dab2051",
      account.id,
      "device",
      "Expired device",
      "beacon",
      JSON.stringify(["memory:read", "memory:write", "sync:write"]),
      "[]",
      new Date().toISOString(),
      "2099-01-01T00:00:00Z",
    )
    .run();
  await db
    .prepare("INSERT INTO browser_sessions VALUES(?,?,?)")
    .bind(await sha256(session), account.id, "2099-01-01T00:00:00Z")
    .run();
  const bearer = { Authorization: "Bearer " + token };
  assert.equal(
    (await mf.dispatchFetch(origin + "/api/v1/projects", { headers: bearer }))
      .status,
    402,
  );
  assert.equal(
    (
      await mf.dispatchFetch(origin + "/api/v1/sync/pull?cursor=0", {
        headers: bearer,
      })
    ).status,
    402,
  );
  assert.equal(
    (
      await mf.dispatchFetch(origin + "/mcp", {
        method: "POST",
        headers: { ...bearer, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })
    ).status,
    402,
  );
  const browser = { Cookie: "__Host-asip=" + session };
  const me = await mf.dispatchFetch(origin + "/api/v1/me", {
    headers: browser,
  });
  assert.equal((await me.json()).access.status, "expired");
  assert.equal(
    (await mf.dispatchFetch(origin + "/api/v1/billing", { headers: browser }))
      .status,
    200,
  );
  assert.equal(
    (
      await mf.dispatchFetch(origin + "/api/v1/billing/checkout", {
        method: "POST",
        headers: { ...browser, Origin: "https://attacker.test" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await mf.dispatchFetch(
        origin + "/api/v1/devices/d186be46-e3ea-4c51-8a04-b5313dab2051",
        {
          method: "DELETE",
          headers: { ...browser, Origin: origin },
        },
      )
    ).status,
    200,
  );
  assert.equal(
    (await mf.dispatchFetch(origin + "/api/v1/billing", { headers: bearer }))
      .status,
    401,
  );
});
test("both OAuth providers bind PKCE and single-use state; redirects remain local", async () => {
  for (const provider of ["github", "google"]) {
    const response = await mf.dispatchFetch(
      origin + "/auth/" + provider + "?return=https://attacker.test",
      { redirect: "manual" },
    );
    assert.equal(response.status, 303);
    const url = new URL(response.headers.get("Location"));
    assert.equal(
      url.searchParams.get("redirect_uri"),
      origin + "/auth/" + provider + "/callback",
    );
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("code_challenge").length, 43);
    const state = await db
      .prepare("SELECT * FROM oauth_states WHERE hash=?")
      .bind(await sha256(url.searchParams.get("state")))
      .first();
    assert.equal(state.return_path, "/app");
    const bad = await mf.dispatchFetch(
      origin +
        "/auth/" +
        provider +
        "/callback?code=fake&state=" +
        url.searchParams.get("state"),
    );
    assert.equal(bad.status, 400);
    assert.ok(
      await db
        .prepare("SELECT * FROM oauth_states WHERE hash=?")
        .bind(await sha256(url.searchParams.get("state")))
        .first(),
    );
  }
});
test("Stripe checkout is server-priced, account-bound and reused; only verified current subscription state grants access", async () => {
  const account = await accountForIdentity(
    { DB: db },
    "github",
    "billing-member",
    { name: "Billing member" },
  );
  const env = {
    DB: db,
    ORIGIN: origin,
    STRIPE_SECRET_KEY: "sk_test_fixture",
    STRIPE_WEBHOOK_SECRET: "whsec_fixture",
    STRIPE_PRICE_ID: "price_fixture",
    STRIPE_LIVEMODE: "false",
  };
  const auth = { accountId: account.id, name: account.name, browser: true };
  const requests = [];
  let subscriptions = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = new URL(input),
      params = new URLSearchParams(options?.body);
    requests.push({ url, options, params });
    assert.equal(options.headers.Authorization, "Bearer sk_test_fixture");
    if (url.pathname === "/v1/customers")
      return Response.json({ id: "cus_fixture" });
    if (url.pathname === "/v1/subscriptions")
      return Response.json({ data: subscriptions, has_more: false });
    if (url.pathname === "/v1/checkout/sessions")
      return Response.json({
        id: "cs_fixture",
        url: "https://checkout.stripe.com/c/pay/cs_fixture",
        expires_at: Math.floor(Date.now() / 1000) + 86400,
      });
    if (url.pathname === "/v1/billing_portal/sessions")
      return Response.json({
        url: "https://billing.stripe.com/p/session/fixture",
      });
    throw Error("Unexpected Stripe request");
  };
  try {
    const checkout = new URL(origin + "/api/v1/billing/checkout"),
      req = new Request(checkout, { method: "POST" });
    assert.equal(
      (await (await billingRoute(req, env, checkout, auth)).json()).url,
      "https://checkout.stripe.com/c/pay/cs_fixture",
    );
    const sent = requests.find(
      (r) => r.url.pathname === "/v1/checkout/sessions",
    );
    assert.equal(sent.params.get("line_items[0][price]"), "price_fixture");
    assert.equal(sent.params.get("customer"), "cus_fixture");
    assert.equal(
      sent.params.get("subscription_data[metadata][asip_account]"),
      account.id,
    );
    assert.ok(
      Number(sent.params.get("subscription_data[trial_end]")) >
        Date.now() / 1000 + 6 * 86400,
    );
    await billingRoute(req, env, checkout, auth);
    assert.equal(
      requests.filter((r) => r.url.pathname === "/v1/checkout/sessions").length,
      1,
    );
    assert.equal(
      entitlement(await ensureTrial(env, account.id)).status,
      "trialing",
    );
    const subscription = {
      id: "sub_fixture",
      customer: "cus_fixture",
      livemode: false,
      metadata: { asip_account: account.id },
      status: "active",
      created: 123,
      items: {
        data: [
          {
            price: { id: "price_fixture" },
            current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
          },
        ],
      },
      cancel_at_period_end: false,
    };
    subscriptions = [
      { ...subscription, metadata: { asip_account: "someone-else" } },
    ];
    const refresh = new URL(origin + "/api/v1/billing?refresh=1");
    await billingRoute(new Request(refresh), env, refresh, auth);
    assert.equal(
      (await ensureTrial(env, account.id)).stripe_subscription_id,
      null,
    );
    subscriptions = [subscription];
    const raw = JSON.stringify({
        id: "evt_fixture",
        livemode: false,
        type: "customer.subscription.updated",
        data: { object: { customer: "cus_fixture", status: "canceled" } },
      }),
      timestamp = Math.floor(Date.now() / 1000),
      signature = crypto
        .createHmac("sha256", env.STRIPE_WEBHOOK_SECRET)
        .update(timestamp + "." + raw)
        .digest("hex");
    const deliver = () =>
      webhook(
        new Request(origin + "/api/billing/webhook", {
          method: "POST",
          headers: {
            "Stripe-Signature": "t=" + timestamp + ",v1=" + signature,
          },
          body: raw,
        }),
        env,
      );
    assert.equal((await deliver()).status, 200);
    assert.equal(
      entitlement(await ensureTrial(env, account.id)).status,
      "active",
    );
    const count = requests.length;
    await deliver();
    assert.equal(requests.length, count);
    await assert.rejects(billingRoute(req, env, checkout, auth), {
      status: 409,
    });
    subscriptions = [{ ...subscription, status: "canceled" }];
    await billingRoute(new Request(refresh), env, refresh, auth);
    assert.equal(
      entitlement(await ensureTrial(env, account.id)).allowed,
      false,
    );
  } finally {
    globalThis.fetch = savedFetch;
  }
});
test("webhook signatures reject forgery, payload mutation and stale replays", async () => {
  const raw = '{"id":"evt_signed"}',
    secret = "whsec_fixture",
    timestamp = Math.floor(Date.now() / 1000);
  const hash = crypto
    .createHmac("sha256", secret)
    .update(timestamp + "." + raw)
    .digest("hex");
  await verifyWebhook(raw, "t=" + timestamp + ",v1=" + hash, secret);
  await assert.rejects(
    verifyWebhook(raw + " ", "t=" + timestamp + ",v1=" + hash, secret),
    { status: 400 },
  );
  await assert.rejects(
    verifyWebhook(
      raw,
      "t=" + timestamp + ",v1=" + hash,
      secret,
      Date.now() + 301000,
    ),
    { status: 400 },
  );
  await assert.rejects(
    verifyWebhook(raw, "t=" + timestamp + ",v1=" + "0".repeat(64), secret),
    { status: 400 },
  );
});

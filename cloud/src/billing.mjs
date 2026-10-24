import { fail, json, now } from "./http.mjs";

const activeStatuses = new Set(["active", "trialing"]);
export async function ensureTrial(env, accountId) {
  const existing = await env.DB.prepare(
    "SELECT * FROM billing_accounts WHERE account_id=?",
  )
    .bind(accountId)
    .first();
  if (existing) return existing;
  const started = now(),
    ends = new Date(Date.parse(started) + 7 * 86400000).toISOString();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO billing_accounts(account_id,trial_started_at,trial_ends_at,updated_at) VALUES(?,?,?,?)",
  )
    .bind(accountId, started, ends, started)
    .run();
  return env.DB.prepare("SELECT * FROM billing_accounts WHERE account_id=?")
    .bind(accountId)
    .first();
}
export function entitlement(billing, clock = Date.now()) {
  const founder = billing.status === "founder";
  const trial =
    !billing.stripe_subscription_id &&
    Date.parse(billing.trial_ends_at) > clock;
  const subscribed =
    Boolean(billing.stripe_subscription_id) &&
    activeStatuses.has(billing.status) &&
    Date.parse(billing.period_ends_at) > clock;
  return {
    status: founder
      ? "founder"
      : subscribed
        ? billing.status
        : trial
          ? "trialing"
          : billing.status === "trialing"
            ? "expired"
            : billing.status,
    allowed: founder || trial || subscribed,
    trialEndsAt: billing.trial_ends_at,
    periodEndsAt: billing.period_ends_at,
    cancelAtPeriodEnd: Boolean(billing.cancel_at_period_end),
    daysRemaining:
      trial || (subscribed && billing.status === "trialing")
        ? Math.ceil(
            (Date.parse(
              subscribed ? billing.period_ends_at : billing.trial_ends_at,
            ) -
              clock) /
              86400000,
          )
        : 0,
  };
}
export async function requireAccess(env, accountId) {
  if (env.BILLING_ENFORCED !== "true") return;
  if (!entitlement(await ensureTrial(env, accountId)).allowed)
    fail(
      402,
      "Your trial has ended. Subscribe to ASIP Cloud to continue. Your memory is safely retained.",
    );
}
export function billingConfigured(env) {
  return Boolean(
    env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_ID && env.STRIPE_WEBHOOK_SECRET,
  );
}
async function stripe(env, path, parameters, key) {
  if (!env.STRIPE_SECRET_KEY)
    fail(
      503,
      "Subscriptions are being connected. Your trial remains available.",
    );
  const response = await fetch("https://api.stripe.com/v1/" + path, {
    method: parameters ? "POST" : "GET",
    headers: {
      Authorization: "Bearer " + env.STRIPE_SECRET_KEY,
      "Stripe-Version": "2025-08-27.basil",
      ...(parameters
        ? { "Content-Type": "application/x-www-form-urlencoded" }
        : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: parameters ? new URLSearchParams(parameters) : undefined,
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    fail(502, "Billing could not complete this request. Please try again.");
  return response.json();
}
async function updateSubscription(env, billing) {
  if (!billing.stripe_customer_id || billing.status === "founder")
    return billing;
  // Read current provider state instead of trusting webhook ordering or a redirect.
  const result = await stripe(
    env,
    "subscriptions?customer=" +
      encodeURIComponent(billing.stripe_customer_id) +
      "&status=all&limit=100",
  );
  if (result.has_more)
    fail(503, "This billing account needs administrator review.");
  const rank = { active: 5, trialing: 4, past_due: 3, unpaid: 2, paused: 1 };
  const subscriptions = result.data.filter(
    (s) =>
      s.customer === billing.stripe_customer_id &&
      s.livemode === (env.STRIPE_LIVEMODE === "true") &&
      s.metadata?.asip_account === billing.account_id &&
      s.items?.data?.some((i) =>
        [
          env.STRIPE_PRICE_ID,
          ...(env.STRIPE_LEGACY_PRICE_IDS || "").split(",").filter(Boolean),
        ].includes(i.price?.id),
      ),
  );
  subscriptions.sort(
    (a, b) =>
      (rank[b.status] || 0) - (rank[a.status] || 0) || b.created - a.created,
  );
  const s = subscriptions[0];
  if (!s) return billing;
  const period = Math.max(
    s.current_period_end || 0,
    s.trial_end || 0,
    ...s.items.data.map((i) => i.current_period_end || 0),
  );
  const ends = period ? new Date(period * 1000).toISOString() : now();
  await env.DB.prepare(
    "UPDATE billing_accounts SET status=?,stripe_subscription_id=?,period_ends_at=?,cancel_at_period_end=?,checkout_id=NULL,checkout_url=NULL,checkout_expires=NULL,updated_at=? WHERE account_id=?",
  )
    .bind(
      s.status,
      s.id,
      ends,
      s.cancel_at_period_end ? 1 : 0,
      now(),
      billing.account_id,
    )
    .run();
  return ensureTrial(env, billing.account_id);
}
async function verifyPlan(env) {
  const price = await stripe(
    env,
    "prices/" + encodeURIComponent(env.STRIPE_PRICE_ID),
  );
  if (
    !price.active ||
    price.livemode !== (env.STRIPE_LIVEMODE === "true") ||
    price.currency !== "cad" ||
    price.unit_amount !== 1200 ||
    price.recurring?.interval !== "month" ||
    price.recurring?.interval_count !== 1
  )
    fail(
      503,
      "The subscription plan needs administrator attention. Please try again shortly.",
    );
}
export async function billingRoute(request, env, url, auth) {
  let billing = await ensureTrial(env, auth.accountId);
  if (request.method === "GET" && url.pathname === "/api/v1/billing") {
    const verify =
      url.searchParams.get("refresh") === "1" && billingConfigured(env);
    if (verify) {
      await verifyPlan(env);
      billing = await updateSubscription(env, billing);
    }
    return json({
      ...entitlement(billing),
      configured: billingConfigured(env),
      providerVerified: verify,
      plan: {
        name: "ASIP Cloud",
        amount: 1200,
        currency: "cad",
        interval: "month",
      },
      hasCustomer: Boolean(billing.stripe_customer_id),
    });
  }
  if (request.method !== "POST") fail(405, "Use POST to manage billing.");
  if (!billingConfigured(env))
    fail(
      503,
      "Subscriptions are being connected. Your trial remains available.",
    );
  if (billing.status === "founder")
    fail(409, "Your founder account already includes ASIP Cloud.");
  if (url.pathname === "/api/v1/billing/portal") {
    if (!billing.stripe_customer_id) fail(409, "Choose a subscription first.");
    const portal = await stripe(env, "billing_portal/sessions", {
      customer: billing.stripe_customer_id,
      return_url: env.ORIGIN + "/app#billing",
      ...(env.STRIPE_PORTAL_CONFIGURATION
        ? { configuration: env.STRIPE_PORTAL_CONFIGURATION }
        : {}),
    });
    return json({ url: portal.url });
  }
  if (url.pathname !== "/api/v1/billing/checkout")
    fail(404, "Billing action not found.");
  await verifyPlan(env);
  if (!billing.stripe_customer_id) {
    const customer = await stripe(
      env,
      "customers",
      { name: auth.name, "metadata[asip_account]": auth.accountId },
      "asip-customer-" + auth.accountId,
    );
    await env.DB.prepare(
      "UPDATE billing_accounts SET stripe_customer_id=?,updated_at=? WHERE account_id=? AND stripe_customer_id IS NULL",
    )
      .bind(customer.id, now(), auth.accountId)
      .run();
    billing = await ensureTrial(env, auth.accountId);
  }
  billing = await updateSubscription(env, billing);
  if (
    billing.stripe_subscription_id &&
    !["canceled", "incomplete_expired"].includes(billing.status)
  )
    fail(409, "You already have a subscription. Use Manage subscription.");
  if (billing.checkout_url && billing.checkout_expires > Date.now() / 1000)
    return json({ url: billing.checkout_url });
  const trialEnds = Math.floor(Date.parse(billing.trial_ends_at) / 1000);
  const hasTrial =
    !billing.stripe_subscription_id && trialEnds > Date.now() / 1000;
  const session = await stripe(
    env,
    "checkout/sessions",
    {
      mode: "subscription",
      customer: billing.stripe_customer_id,
      "line_items[0][price]": env.STRIPE_PRICE_ID,
      "line_items[0][quantity]": "1",
      client_reference_id: auth.accountId,
      "subscription_data[metadata][asip_account]": auth.accountId,
      success_url: env.ORIGIN + "/app?billing=success#billing",
      cancel_url: env.ORIGIN + "/app#billing",
      ...(hasTrial
        ? {
            "subscription_data[trial_end]": String(
              Math.max(
                trialEnds,
                Math.ceil(Date.now() / 1800000) * 1800 + 172860,
              ),
            ),
          }
        : {}),
    },
    "asip-checkout-" + auth.accountId + "-" + Math.floor(Date.now() / 1800000),
  );
  await env.DB.prepare(
    "UPDATE billing_accounts SET checkout_id=?,checkout_url=?,checkout_expires=?,updated_at=? WHERE account_id=?",
  )
    .bind(session.id, session.url, session.expires_at, now(), auth.accountId)
    .run();
  return json({ url: session.url });
}
export async function webhook(request, env) {
  if (request.method !== "POST") fail(405, "Use POST.");
  if (!env.STRIPE_WEBHOOK_SECRET || !env.STRIPE_SECRET_KEY)
    fail(503, "Billing webhook is not configured.");
  if (Number(request.headers.get("Content-Length")) > 1048576)
    fail(413, "Event is too large.");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > 1048576)
    fail(413, "Event is too large.");
  await verifyWebhook(
    raw,
    request.headers.get("Stripe-Signature") || "",
    env.STRIPE_WEBHOOK_SECRET,
  );
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    fail(400, "Invalid billing event.");
  }
  if (
    typeof event.id !== "string" ||
    event.livemode !== (env.STRIPE_LIVEMODE === "true")
  )
    fail(400, "Invalid billing event mode.");
  if (
    ![
      "checkout.session.completed",
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
    ].includes(event.type)
  )
    return json({ received: true });
  if (
    await env.DB.prepare("SELECT id FROM billing_events WHERE id=?")
      .bind(event.id)
      .first()
  )
    return json({ received: true });
  const customer = event.data?.object?.customer;
  if (typeof customer !== "string") fail(400, "Billing customer is required.");
  const billing = await env.DB.prepare(
    "SELECT * FROM billing_accounts WHERE stripe_customer_id=?",
  )
    .bind(customer)
    .first();
  if (billing) await updateSubscription(env, billing);
  await env.DB.prepare("INSERT OR IGNORE INTO billing_events VALUES(?,?)")
    .bind(event.id, now())
    .run();
  return json({ received: true });
}
export async function verifyWebhook(
  raw,
  signature,
  secret,
  clock = Date.now(),
) {
  const parts = signature.split(","),
    timestamp = parts.find((p) => p.startsWith("t="))?.slice(2);
  if (
    !/^\d+$/.test(timestamp || "") ||
    Math.abs(clock / 1000 - Number(timestamp)) > 300
  )
    fail(400, "Billing signature expired.");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  for (const p of parts.filter((p) => /^v1=[a-f0-9]{64}$/.test(p))) {
    const bytes = Uint8Array.from(p.slice(3).match(/../g), (v) =>
      parseInt(v, 16),
    );
    if (
      await crypto.subtle.verify(
        "HMAC",
        key,
        bytes,
        new TextEncoder().encode(timestamp + "." + raw),
      )
    )
      return;
  }
  fail(400, "Invalid billing signature.");
}

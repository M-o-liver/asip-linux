import { createRemoteJWKSet, jwtVerify } from "jose";
import { sha256 } from "../../beacon/cloud-protocol.mjs";
import {
  fail,
  random,
  expires,
  now,
  browserMutation,
  throttle,
} from "./http.mjs";

const keySets = new Map();
export async function accessClaims(request, env, keys) {
  if (env.PRIVATE_PREVIEW !== "true") return null;
  if (
    !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM_DOMAIN || "") ||
    !env.ACCESS_AUD
  )
    fail(503, "Private preview admission is not configured.");
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) fail(401, "Sign in through the ASIP preview gate.");
  const issuer = "https://" + env.ACCESS_TEAM_DOMAIN;
  if (!keys) {
    if (!keySets.has(issuer))
      keySets.set(
        issuer,
        createRemoteJWKSet(new URL(issuer + "/cdn-cgi/access/certs")),
      );
    keys = keySets.get(issuer);
  }
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      audience: env.ACCESS_AUD,
      algorithms: ["RS256"],
    });
    if (
      !payload.sub ||
      typeof payload.email !== "string" ||
      payload.type !== "app"
    )
      fail(401, "A preview user session is required.");
    return payload;
  } catch {
    fail(401, "The preview session expired. Sign in again.");
  }
}
export function cookie(request, name) {
  return (
    (request.headers.get("cookie") || "")
      .split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(name + "="))
      ?.slice(name.length + 1) || ""
  );
}
export async function accountForIdentity(env, provider, subject, profile) {
  const existing = await env.DB.prepare(
    "SELECT a.* FROM identities i JOIN accounts a ON a.id=i.account_id WHERE i.provider=? AND i.subject=?",
  )
    .bind(provider, subject)
    .first();
  if (existing) return existing;
  const id = await sha256(provider + ":" + subject);
  const stem =
    String(profile.handle || profile.email?.split("@")[0] || "member")
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "")
      .slice(0, 26) || "member";
  const taken = await env.DB.prepare("SELECT id FROM accounts WHERE handle=?")
    .bind(stem)
    .first();
  const handle = taken ? stem + "-" + id.slice(0, 6) : stem;
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO accounts VALUES(?,?,?,?)").bind(
      id,
      handle,
      String(profile.name || stem).slice(0, 200),
      now(),
    ),
    env.DB.prepare("INSERT OR IGNORE INTO identities VALUES(?,?,?,?)").bind(
      provider,
      subject,
      id,
      profile.email || null,
    ),
  ]);
  return env.DB.prepare("SELECT * FROM accounts WHERE id=?").bind(id).first();
}
export async function browserAccount(request, env) {
  const session = cookie(request, "__Host-asip");
  if (!/^[a-f0-9]{64}$/.test(session)) return null;
  return env.DB.prepare(
    "SELECT a.* FROM browser_sessions s JOIN accounts a ON a.id=s.account_id WHERE s.hash=? AND s.expires_at>?",
  )
    .bind(await sha256(session), now())
    .first();
}
export async function sessionFor(env, account) {
  const token = random();
  await env.DB.prepare("INSERT INTO browser_sessions VALUES(?,?,?)")
    .bind(await sha256(token), account.id, expires(30 * 86400))
    .run();
  return (
    "__Host-asip=" +
    token +
    "; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000"
  );
}
export async function authenticate(request, env, required = "memory:read") {
  const token = /^Bearer (asip_[a-f0-9]{64})$/.exec(
    request.headers.get("authorization") || "",
  )?.[1];
  if (request.headers.has("authorization") && !token)
    fail(401, "Use a valid ASIP bearer token.");
  if (token) {
    const credential = await env.DB.prepare(
      "SELECT c.*,a.handle,a.name FROM credentials c JOIN accounts a ON a.id=c.account_id WHERE c.hash=? AND c.revoked_at IS NULL AND c.expires_at>?",
    )
      .bind(await sha256(token), now())
      .first();
    if (!credential) fail(401, "This ASIP connection expired or was revoked.");
    const scopes = JSON.parse(credential.scopes);
    if (!scopes.includes(required))
      fail(403, "This connection does not grant " + required + ".");
    await throttle(env, credential.id, required === "sync:write" ? 240 : 120);
    return {
      accountId: credential.account_id,
      handle: credential.handle,
      name: credential.name,
      credential,
      scopes,
      projects: JSON.parse(credential.projects),
      agent: credential.agent,
    };
  }
  const account = await browserAccount(request, env);
  if (!account) fail(401, "Sign in to ASIP.");
  if (!["GET", "HEAD"].includes(request.method)) browserMutation(request, env);
  await throttle(env, "browser:" + account.id, 120);
  return {
    accountId: account.id,
    handle: account.handle,
    name: account.name,
    browser: true,
    scopes: ["memory:read", "memory:write", "sync:write"],
    projects: [],
  };
}
export function owner(auth) {
  if (!auth.browser) fail(403, "Manage account connections in your browser.");
}
export function projectAllowed(auth, project) {
  if (auth.projects.length && (!project || !auth.projects.includes(project)))
    fail(403, "This connection is restricted to its assigned projects.");
}
export async function issueCredential(env, accountId, input) {
  const token = "asip_" + random(),
    id = crypto.randomUUID(),
    created = now();
  await env.DB.prepare(
    "INSERT INTO credentials(hash,id,account_id,kind,label,agent,scopes,projects,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      await sha256(token),
      id,
      accountId,
      input.kind,
      String(input.label).slice(0, 120),
      input.agent,
      JSON.stringify(input.scopes),
      JSON.stringify(input.projects || []),
      created,
      expires(90 * 86400),
    )
    .run();
  return { id, token, expiresAt: expires(90 * 86400) };
}

import { createRemoteJWKSet, jwtVerify } from "jose";
import { sha256 } from "../../beacon/cloud-protocol.mjs";
import { fail, random, expires, throttle } from "./http.mjs";
import {
  accountForIdentity,
  browserAccount,
  cookie,
  sessionFor,
} from "./auth.mjs";

const googleKeys = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);
async function providerJSON(url, options) {
  const response = await fetch(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    fail(502, "The identity provider could not complete sign-in.");
  return response.json();
}
export async function oauth(request, env, url) {
  if (request.method !== "GET") fail(405, "Use GET to sign in.");
  await throttle(
    env,
    "oauth:" + (request.headers.get("CF-Connecting-IP") || "unknown"),
    30,
  );
  const provider = url.pathname.split("/")[2];
  if (!["google", "github"].includes(provider))
    fail(404, "Unknown identity provider.");
  const clientId =
    env[provider === "google" ? "GOOGLE_WEB_CLIENT_ID" : "GITHUB_CLIENT_ID"];
  const secret =
    env[
      provider === "google"
        ? "GOOGLE_WEB_CLIENT_SECRET"
        : "GITHUB_CLIENT_SECRET"
    ];
  if (!clientId || !secret)
    fail(
      503,
      "This sign-in provider is being connected. Please try again shortly.",
    );
  const callback = env.ORIGIN + "/auth/" + provider + "/callback";
  if (!url.pathname.endsWith("/callback")) {
    const state = random(),
      verifier = random(),
      nonce = random();
    const account =
      url.searchParams.get("link") === "1"
        ? await browserAccount(request, env)
        : null;
    if (url.searchParams.get("link") === "1" && !account)
      fail(401, "Sign in before linking an identity.");
    const next = url.searchParams.get("return");
    await env.DB.prepare(
      "INSERT INTO oauth_states(hash,provider,verifier,nonce,account_id,expires_at,return_path) VALUES(?,?,?,?,?,?,?)",
    )
      .bind(
        await sha256(state),
        provider,
        verifier,
        nonce,
        account?.id || null,
        expires(300),
        next?.startsWith("/connect?") && next.length < 8192 ? next : "/app",
      )
      .run();
    const target = new URL(
      provider === "google"
        ? "https://accounts.google.com/o/oauth2/v2/auth"
        : "https://github.com/login/oauth/authorize",
    );
    target.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callback,
      state,
      code_challenge: btoa(
        String.fromCharCode(
          ...new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(verifier),
            ),
          ),
        ),
      )
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_"),
      code_challenge_method: "S256",
      scope:
        provider === "google" ? "openid email profile" : "read:user user:email",
      ...(provider === "google"
        ? {
            response_type: "code",
            nonce,
            code_challenge: btoa(
              String.fromCharCode(
                ...new Uint8Array(
                  await crypto.subtle.digest(
                    "SHA-256",
                    new TextEncoder().encode(verifier),
                  ),
                ),
              ),
            )
              .replace(/=/g, "")
              .replace(/\+/g, "-")
              .replace(/\//g, "_"),
            code_challenge_method: "S256",
          }
        : {}),
    }).toString();
    return new Response(null, {
      status: 303,
      headers: {
        Location: target.href,
        "Set-Cookie":
          "__Host-asip_oauth=" +
          state +
          "; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=300",
      },
    });
  }
  const state = url.searchParams.get("state");
  if (!state || cookie(request, "__Host-asip_oauth") !== state)
    fail(400, "Sign-in expired. Start again.");
  const saved = await env.DB.prepare(
    "DELETE FROM oauth_states WHERE hash=? AND provider=? AND expires_at>? RETURNING *",
  )
    .bind(await sha256(state), provider, new Date().toISOString())
    .first();
  if (!saved || !url.searchParams.get("code"))
    fail(400, "Sign-in expired or was cancelled.");
  const tokens = await providerJSON(
    provider === "google"
      ? "https://oauth2.googleapis.com/token"
      : "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: secret,
        code: url.searchParams.get("code"),
        code_verifier: saved.verifier,
        redirect_uri: callback,
        ...(provider === "google"
          ? { grant_type: "authorization_code", code_verifier: saved.verifier }
          : {}),
      }),
    },
  );
  let subject, profile;
  if (provider === "google") {
    const { payload } = await jwtVerify(tokens.id_token, googleKeys, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: clientId,
      algorithms: ["RS256"],
    });
    if (
      payload.nonce !== saved.nonce ||
      !payload.sub ||
      payload.email_verified !== true
    )
      fail(401, "Google identity could not be verified.");
    subject = payload.sub;
    profile = { name: payload.name, email: payload.email };
  } else {
    if (!tokens.access_token) fail(401, "GitHub sign-in was cancelled.");
    const headers = {
      Authorization: "Bearer " + tokens.access_token,
      Accept: "application/vnd.github+json",
      "User-Agent": "ASIP",
    };
    const p = await providerJSON("https://api.github.com/user", { headers });
    if (!Number.isSafeInteger(p.id) || !p.login)
      fail(401, "GitHub did not return an identity.");
    const emails = await providerJSON("https://api.github.com/user/emails", {
      headers,
    });
    subject = String(p.id);
    profile = {
      name: p.name || p.login,
      handle: p.login,
      email: emails.find((e) => e.primary && e.verified)?.email,
    };
  }
  let account;
  if (saved.account_id) {
    const current = await browserAccount(request, env);
    if (current?.id !== saved.account_id)
      fail(401, "The account changed during identity linking.");
    const existing = await env.DB.prepare(
      "SELECT account_id FROM identities WHERE provider=? AND subject=?",
    )
      .bind(provider, subject)
      .first();
    if (existing && existing.account_id !== current.id)
      fail(409, "This identity belongs to another ASIP account.");
    await env.DB.prepare("INSERT OR IGNORE INTO identities VALUES(?,?,?,?)")
      .bind(provider, subject, current.id, profile.email || null)
      .run();
    account = current;
  } else account = await accountForIdentity(env, provider, subject, profile);
  return new Response(null, {
    status: 303,
    headers: {
      Location: saved.return_path?.startsWith("/connect?")
        ? saved.return_path
        : "/users/" + account.handle,
      "Set-Cookie": await sessionFor(env, account),
    },
  });
}

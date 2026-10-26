import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, SignJWT } from "jose";
import { Identity, accountId } from "../beacon/identity.mjs";

const keys = await generateKeyPair("RS256");
async function signed(overrides = {}, key = keys.privateKey) {
  return new SignJWT({
    sub: "123",
    nonce: "correct-nonce",
    email: "person@example.com",
    email_verified: true,
    name: "Person",
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer("https://accounts.google.com")
    .setAudience("asip-client")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);
}

test("Google account requires a signed token, matching client, nonce, issuer, and verified email", async () => {
  const identity = new Identity(
    { googleClientId: "asip-client" },
    { jwks: keys.publicKey },
  );
  const result = await identity.verifyGoogle(await signed(), "correct-nonce");
  assert.equal(result.accountId, accountId("google", "123"));
  for (const fields of [
    { nonce: "wrong" },
    { aud: "other-client" },
    { iss: "https://other.example" },
    { email_verified: false },
  ]) {
    let token = await signed(fields);
    // SignJWT setters supply aud/iss for the ordinary fixture; build malformed
    // issuer and audience explicitly to test those verification paths.
    if (fields.aud || fields.iss)
      token = await new SignJWT({
        sub: "123",
        nonce: "correct-nonce",
        email: "person@example.com",
        email_verified: true,
      })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(fields.iss || "https://accounts.google.com")
        .setAudience(fields.aud || "asip-client")
        .setExpirationTime("5m")
        .sign(keys.privateKey);
    await assert.rejects(identity.verifyGoogle(token, "correct-nonce"));
  }
  const impostor = await generateKeyPair("RS256");
  await assert.rejects(
    identity.verifyGoogle(
      await signed({}, impostor.privateKey),
      "correct-nonce",
    ),
  );
});

test("Google browser flow sends PKCE and exchanges the returned code with its verifier", async () => {
  let auth, exchange;
  const identity = new Identity(
    {
      googleClientId: "asip-client",
      googleClientSecret: "fixture-desktop-client",
    },
    {
      jwks: keys.publicKey,
      openBrowser: async (value) => {
        auth = new URL(value);
        assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
        const callback = new URL(auth.searchParams.get("redirect_uri"));
        callback.search = new URLSearchParams({
          state: auth.searchParams.get("state"),
          code: "test-code",
        }).toString();
        const response = await fetch(callback, { redirect: "manual" });
        assert.equal(response.status, 303);
        assert.equal(
          response.headers.get("location"),
          "https://asip.ca/beacon-connected.html",
        );
      },
      fetcher: async (url, options) => {
        assert.equal(url, "https://oauth2.googleapis.com/token");
        exchange = options.body;
        assert.equal(exchange.get("code"), "test-code");
        assert.equal(exchange.get("client_secret"), "fixture-desktop-client");
        assert.ok(exchange.get("code_verifier").length >= 43);
        const jwt = await signed({ nonce: auth.searchParams.get("nonce") });
        return Response.json({ id_token: jwt });
      },
    },
  );
  const result = await identity.google(new AbortController().signal);
  assert.equal(result.handle, "person@example.com");
  assert.equal(
    exchange.get("redirect_uri"),
    auth.searchParams.get("redirect_uri"),
  );
});

test("unconfigured provider fails before opening a browser", async () => {
  const identity = new Identity(
    {},
    { openBrowser: () => assert.fail("browser should not open") },
  );
  await assert.rejects(identity.github(), /not configured/);
  await assert.rejects(identity.google(), /not configured/);
});

test("GitHub account uses the verified numeric provider identity, not its display name", async () => {
  const calls = [];
  const identity = new Identity(
    { githubClientId: "registered-client" },
    {
      openBrowser: async (url) =>
        assert.equal(url, "https://github.com/login/device"),
      fetcher: async (url, options) => {
        calls.push(url);
        if (url.endsWith("/device/code"))
          return Response.json({
            device_code: "fixture-device",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            interval: 5,
          });
        if (url.endsWith("/access_token"))
          return Response.json({ access_token: "fixture-token" });
        assert.equal(options.headers.Authorization, "Bearer fixture-token");
        return Response.json({ id: 42, login: "changed-name", name: "Test" });
      },
    },
  );
  const result = await identity.github();
  assert.equal(result.accountId, accountId("github", "42"));
  assert.equal(result.access_token, undefined);
  assert.equal(calls.length, 3);
});

test("GitHub API authorization requests repository scope and keeps its credential separate from account sign-in", async () => {
  const identity = new Identity(
    { githubClientId: "registered-client" },
    {
      openBrowser: async () => {},
      fetcher: async (url, options) => {
        if (url.endsWith("/device/code")) {
          assert.equal(options.body.get("scope"), "public_repo");
          return Response.json({
            device_code: "fixture-device",
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            interval: 5,
          });
        }
        if (url.endsWith("/access_token"))
          return Response.json({ access_token: "fixture-api-credential" });
        assert.equal(
          options.headers.Authorization,
          "Bearer fixture-api-credential",
        );
        return Response.json({ id: 42, login: "fixture" });
      },
    },
  );
  const result = await identity.github(undefined, {
    scope: "public_repo",
    includeCredential: true,
  });
  assert.equal(result.account.accountId, accountId("github", "42"));
  assert.equal(result.credential, "fixture-api-credential");
});

test("Google completion rejects invalid identity before redirecting and does not expose callback values", async () => {
  let callbackResponse;
  const identity = new Identity(
    { googleClientId: "asip-client", googleClientSecret: "fixture" },
    {
      jwks: keys.publicKey,
      openBrowser: async (value) => {
        const auth = new URL(value),
          callback = new URL(auth.searchParams.get("redirect_uri"));
        callback.search = new URLSearchParams({
          state: auth.searchParams.get("state"),
          code: "private-callback-code",
        });
        callbackResponse = await fetch(callback, { redirect: "manual" });
      },
      fetcher: async () => Response.json({ id_token: "invalid-token" }),
    },
  );
  await assert.rejects(identity.google());
  assert.equal(callbackResponse.status, 400);
  assert.equal(callbackResponse.headers.get("location"), null);
  const html = await callbackResponse.text();
  assert.match(html, /ASIP/);
  assert.match(html, /could not be completed/);
  assert.doesNotMatch(html, /private-callback-code|invalid-token/);
  assert.equal(callbackResponse.headers.get("referrer-policy"), "no-referrer");
});

test("Google callback rejects browser POSTs without consuming the valid pending flow", async () => {
  let auth;
  const identity = new Identity(
    { googleClientId: "asip-client", googleClientSecret: "fixture" },
    {
      jwks: keys.publicKey,
      openBrowser: async (value) => {
        auth = new URL(value);
        const callback = new URL(auth.searchParams.get("redirect_uri"));
        callback.search = new URLSearchParams({
          state: auth.searchParams.get("state"),
          code: "fixture",
        });
        assert.equal((await fetch(callback, { method: "POST" })).status, 400);
        assert.equal(
          (await fetch(callback, { redirect: "manual" })).status,
          303,
        );
      },
      fetcher: async () =>
        Response.json({
          id_token: await signed({ nonce: auth.searchParams.get("nonce") }),
        }),
    },
  );
  assert.equal((await identity.google()).subject, "123");
});

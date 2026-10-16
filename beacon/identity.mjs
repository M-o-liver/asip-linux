import crypto from "node:crypto";
import http from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";

export class Identity {
  constructor(
    config = {},
    { fetcher = fetch, openBrowser, onCode, jwks } = {},
  ) {
    this.config = config;
    this.fetch = fetcher;
    this.open = openBrowser;
    this.onCode = onCode;
    this.googleKeys =
      jwks ||
      createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
  }

  async json(url, options = {}) {
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000);
    const response = await this.fetch(url, {
      ...options,
      redirect: "error",
      signal,
    });
    const data = await response.json();
    if (!response.ok) throw new Error("Sign-in request failed. Try again.");
    return data;
  }

  async github(signal, { scope = "", includeCredential = false } = {}) {
    const clientId = this.config.githubClientId;
    if (!clientId)
      throw new Error("GitHub sign-in is not configured for this build.");
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    };
    const device = await this.json("https://github.com/login/device/code", {
      method: "POST",
      headers,
      signal,
      body: new URLSearchParams({
        client_id: clientId,
        ...(scope ? { scope } : {}),
      }),
    });
    if (
      !device.device_code ||
      !device.user_code ||
      device.verification_uri !== "https://github.com/login/device"
    )
      throw new Error("GitHub could not start sign-in.");
    this.onCode?.({ code: device.user_code, url: device.verification_uri });
    await this.open(device.verification_uri);
    let interval = Math.max(5, device.interval || 5);
    const until = Date.now() + Math.min(device.expires_in || 900, 900) * 1000;
    while (Date.now() < until) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(done, interval * 1000);
        function done() {
          signal?.removeEventListener("abort", cancel);
          resolve();
        }
        function cancel() {
          clearTimeout(timer);
          reject(new Error("Sign-in cancelled."));
        }
        if (signal?.aborted) cancel();
        else signal?.addEventListener("abort", cancel, { once: true });
      });
      const token = await this.json(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers,
          signal,
          body: new URLSearchParams({
            client_id: clientId,
            device_code: device.device_code,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }),
        },
      );
      if (token.access_token) {
        const profile = await this.json("https://api.github.com/user", {
          signal,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: "Bearer " + token.access_token,
          },
        });
        if (!Number.isSafeInteger(profile.id) || !profile.login)
          throw new Error("GitHub did not return an account.");
        const identity = {
          provider: "github",
          subject: String(profile.id),
          name: profile.name || profile.login,
          handle: profile.login,
          accountId: accountId("github", String(profile.id)),
        };
        return includeCredential
          ? { account: identity, credential: token.access_token }
          : identity;
      }
      if (token.error === "slow_down") interval += 5;
      else if (token.error !== "authorization_pending")
        throw new Error("GitHub sign-in was cancelled or expired.");
    }
    throw new Error("GitHub sign-in expired.");
  }

  async google(signal) {
    const clientId = this.config.googleClientId;
    if (!clientId || !this.config.googleClientSecret)
      throw new Error("Google sign-in is not configured for this build.");
    const state = crypto.randomBytes(32).toString("base64url"),
      nonce = crypto.randomBytes(32).toString("base64url");
    const verifier = crypto.randomBytes(48).toString("base64url");
    let finish, fail;
    const received = new Promise((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    received.catch(() => {});
    const server = http.createServer((request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      if (
        url.pathname !== "/callback" ||
        url.searchParams.get("state") !== state
      ) {
        response.writeHead(400);
        response.end("Invalid sign-in response.");
        return;
      }
      response.writeHead(200, {
        "Content-Type": "text/plain",
        "Cache-Control": "no-store",
      });
      response.end("Sign-in received. Return to ASIP Beacon.");
      if (url.searchParams.has("error"))
        fail(new Error("Google sign-in was cancelled."));
      else if (url.searchParams.get("code"))
        finish(url.searchParams.get("code"));
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const redirect = "http://127.0.0.1:" + server.address().port + "/callback";
    const timer = setTimeout(
      () => fail(new Error("Google sign-in expired.")),
      300000,
    );
    const cancel = () => fail(new Error("Sign-in cancelled."));
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
    try {
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirect,
        response_type: "code",
        scope: "openid email profile",
        state,
        nonce,
        code_challenge: crypto
          .createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
        prompt: "select_account",
      }).toString();
      await this.open(url.toString());
      const code = await received;
      const tokens = await this.json("https://oauth2.googleapis.com/token", {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: this.config.googleClientSecret,
          code,
          code_verifier: verifier,
          redirect_uri: redirect,
          grant_type: "authorization_code",
        }),
      });
      return this.verifyGoogle(tokens.id_token, nonce);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      server.close();
    }
  }

  async verifyGoogle(token, nonce) {
    const { payload } = await jwtVerify(token, this.googleKeys, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: this.config.googleClientId,
    });
    if (
      payload.nonce !== nonce ||
      !payload.sub ||
      payload.email_verified !== true ||
      typeof payload.email !== "string"
    )
      throw new Error("Google sign-in could not be verified.");
    return {
      provider: "google",
      subject: payload.sub,
      name: payload.name || payload.email,
      handle: payload.email,
      accountId: accountId("google", payload.sub),
    };
  }

  signIn(provider, signal) {
    if (provider === "google") return this.google(signal);
    if (provider === "github") return this.github(signal);
    throw new Error("Choose Google or GitHub.");
  }
}

export function accountId(provider, subject) {
  return crypto
    .createHash("sha256")
    .update(provider + ":" + subject)
    .digest("hex");
}

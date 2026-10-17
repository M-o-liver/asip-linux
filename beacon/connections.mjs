import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const providers = {
  openai: {
    check: "/v1/models",
    origin: "https://api.openai.com",
    header: "Authorization",
    prefix: "Bearer ",
  },
  anthropic: {
    check: "/v1/models",
    origin: "https://api.anthropic.com",
    header: "x-api-key",
    prefix: "",
    headers: { "anthropic-version": "2023-06-01" },
  },
  gemini: {
    check: "/v1beta/models",
    origin: "https://generativelanguage.googleapis.com",
    header: "x-goog-api-key",
    prefix: "",
  },
  github: {
    check: "/user",
    origin: "https://api.github.com",
    header: "Authorization",
    prefix: "Bearer ",
    headers: { Accept: "application/vnd.github+json" },
  },
  cloudflare: {
    check: "/client/v4/user/tokens/verify",
    origin: "https://api.cloudflare.com",
    header: "Authorization",
    prefix: "Bearer ",
  },
  brave: {
    origin: "https://api.search.brave.com",
    header: "X-Subscription-Token",
    prefix: "",
  },
  exa: { origin: "https://api.exa.ai", header: "x-api-key", prefix: "" },
  fal: { origin: "https://fal.run", header: "Authorization", prefix: "Key " },
  marginalia: {
    origin: "https://api2.marginalia-search.com",
    header: "API-Key",
    prefix: "",
  },
  stripe: {
    check: "/v1/account",
    origin: "https://api.stripe.com",
    header: "Authorization",
    prefix: "Basic ",
    basic: true,
  },
  x: {
    origin: "https://api.x.com",
    header: "Authorization",
    prefix: "Bearer ",
  },
  "google-maps": {
    origin: "https://maps.googleapis.com",
    header: "",
    prefix: "",
    queryKey: "key",
  },
};

function redact(value, credential, depth = 0) {
  if (typeof value === "string")
    return value.replaceAll(credential, "[credential]");
  if (depth > 30) return "[nested response]";
  if (Array.isArray(value))
    return value.map((item) => redact(item, credential, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.replaceAll(credential, "[credential]"),
        redact(item, credential, depth + 1),
      ]),
    );
  return value;
}

export class Connections {
  constructor(home, { account, seal, unseal, fetcher = fetch }) {
    Object.assign(this, { home, account, seal, unseal, fetch: fetcher });
    this.loadedAccount = null;
    this.entries = new Map();
  }
  clear() {
    this.loadedAccount = null;
    this.entries.clear();
  }
  load() {
    const account = this.account();
    if (!account) throw new Error("Sign in to ASIP Beacon first.");
    if (this.loadedAccount === account.accountId) return;
    this.clear();
    this.file = path.join(
      this.home,
      "accounts",
      account.accountId,
      "connections.bin",
    );
    const entries = fs.existsSync(this.file)
      ? JSON.parse(this.unseal(fs.readFileSync(this.file)))
      : [];
    this.entries = new Map(entries.map((entry) => [entry.name, entry]));
    this.loadedAccount = account.accountId;
  }
  persist(encrypted = this.seal(JSON.stringify([...this.entries.values()]))) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = this.file + "." + crypto.randomUUID();
    try {
      fs.writeFileSync(temporary, encrypted, { mode: 0o600, flag: "wx" });
      if (!fs.readFileSync(temporary).equals(encrypted))
        throw new Error("The connection file could not be verified.");
      fs.renameSync(temporary, this.file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  list(project) {
    this.load();
    return [...this.entries.values()]
      .filter(
        (entry) =>
          !project ||
          !entry.projects.length ||
          entry.projects.includes(project),
      )
      .map(({ credential, prefix, ...entry }) => ({
        ...entry,
        canCheck: Boolean(providers[entry.provider]?.check),
      }));
  }
  validate(input) {
    this.load();
    const { name, provider } = input;
    if (!/^[a-z][a-z0-9._-]{1,79}$/.test(name || ""))
      throw new Error("Use a connection name such as openai.work.");
    const preset = providers[provider];
    if (!preset && !["custom", "secret"].includes(provider))
      throw new Error("Choose an API provider.");
    let origin, header, prefix;
    if (preset) ({ origin, header, prefix } = preset);
    else if (provider === "custom") {
      let url;
      try {
        url = new URL(input.origin);
      } catch {
        throw new Error(
          "Enter the API origin, such as https://api.example.com.",
        );
      }
      const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(
        url.hostname,
      );
      if (
        !(
          url.protocol === "https:" ||
          (url.protocol === "http:" && loopback)
        ) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/"
      )
        throw new Error(
          "Enter an HTTPS API origin, or a local loopback API address.",
        );
      origin = url.origin;
      header = input.header || "Authorization";
      prefix = header.toLowerCase() === "authorization" ? "Bearer " : "";
      if (
        !/^[A-Za-z0-9-]{1,80}$/.test(header) ||
        /^(host|content-length|connection|cookie)$/i.test(header)
      )
        throw new Error("Enter the API's authentication header.");
    }
    const existing = this.entries.get(name);
    const credential =
      input.credential ||
      (existing?.provider === "secret" ||
      (existing?.origin === origin &&
        existing?.provider === provider &&
        existing?.header === header)
        ? existing.credential
        : "");
    if (
      typeof credential !== "string" ||
      !credential ||
      credential.length > 16000 ||
      /[\r\n]/.test(credential)
    )
      throw new Error("Enter an API key or token.");
    if (input.projects !== undefined && !Array.isArray(input.projects))
      throw new Error("Projects must be a list of repository identities.");
    const projects = [...new Set(input.projects || [])];
    if (
      !projects.every(
        (project) =>
          typeof project === "string" &&
          project.length > 0 &&
          project.length <= 2000,
      )
    )
      throw new Error("Enter repository identities for the selected projects.");
    return {
      name,
      provider,
      origin,
      header,
      prefix,
      credential,
      projects,
      updatedAt: new Date().toISOString(),
      account:
        typeof input.account === "string" ? input.account.slice(0, 200) : "",
      label:
        typeof input.label === "string"
          ? input.label.slice(0, 500)
          : existing?.label || "",
      envVar: /^[A-Z_][A-Z0-9_]{0,99}$/.test(input.envVar || "")
        ? input.envVar
        : existing?.envVar || "",
      ...(existing?.credential === credential &&
      existing.provider === provider &&
      existing.origin === origin
        ? { lastRequest: existing.lastRequest }
        : {}),
    };
  }
  save(input) {
    const entry = this.validate(input),
      { name } = entry;
    const existing = this.entries.get(name);
    this.entries.set(name, entry);
    try {
      this.persist();
    } catch (error) {
      existing ? this.entries.set(name, existing) : this.entries.delete(name);
      throw error;
    }
    return this.list();
  }
  import(input) {
    this.load();
    if (!Array.isArray(input) || !input.length || input.length > 200)
      throw new Error("Import a JSON list of 1–200 connections.");
    const names = new Set();
    const entries = input.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item))
        throw new Error("Each connection must be an object.");
      if (names.has(item.name) || this.entries.has(item.name))
        throw new Error(
          "An imported connection name already exists. Rename it before importing.",
        );
      names.add(item.name);
      return this.validate(item);
    });
    const previous = new Map(this.entries);
    try {
      for (const entry of entries) this.entries.set(entry.name, entry);
      // Verify every imported credential can be decrypted before replacing the vault.
      const encrypted = this.seal(JSON.stringify([...this.entries.values()]));
      const restored = new Map(
        JSON.parse(this.unseal(encrypted)).map((entry) => [entry.name, entry]),
      );
      if (
        entries.some(
          (entry) => restored.get(entry.name)?.credential !== entry.credential,
        )
      )
        throw new Error("The imported credentials could not be verified.");
      this.persist(encrypted);
    } catch (error) {
      this.entries = previous;
      throw error;
    }
    return { imported: entries.map(({ name }) => name), verified: true };
  }
  remove(name) {
    this.load();
    const existing = this.entries.get(name);
    this.entries.delete(name);
    try {
      this.persist();
    } catch (error) {
      if (existing) this.entries.set(name, existing);
      throw error;
    }
  }
  prepare({ name, method = "GET", path: route, body, project }) {
    this.load();
    const entry = this.entries.get(name);
    if (!entry) throw new Error("Add this API connection in Beacon first.");
    if (entry.provider === "secret")
      throw new Error(
        "This is a stored signing secret. Edit it in Beacon to configure API access.",
      );
    if (entry.projects.length && !entry.projects.includes(project))
      throw new Error("This connection is not assigned to that project.");
    if (
      typeof route !== "string" ||
      !route.startsWith("/") ||
      route.startsWith("//") ||
      /[\\\r\n]/.test(route)
    )
      throw new Error("Enter an API path beginning with /.");
    const url = new URL(route, entry.origin);
    if (url.origin !== entry.origin || url.username || url.password || url.hash)
      throw new Error("Use a path on the configured API.");
    if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method))
      throw new Error("Choose an HTTP method.");
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded !== undefined && ["GET", "HEAD"].includes(method))
      throw new Error("Use a request body with POST, PUT, PATCH, or DELETE.");
    if (encoded && Buffer.byteLength(encoded) > 65536)
      throw new Error("The request body is too large.");
    return { entry, method, url, encoded, accountId: this.loadedAccount };
  }
  async request(input) {
    return this.dispatch(this.prepare(input), input.signal);
  }
  async check(name) {
    this.load();
    const entry = this.entries.get(name);
    const route = providers[entry?.provider]?.check;
    if (!route)
      throw new Error(
        "Use this connection through an agent to check its API result.",
      );
    const result = await this.request({
      name,
      path: route,
      project: entry.projects[0],
    });
    return { name, status: result.status };
  }
  outcome(entry, accountId, result) {
    if (
      this.account()?.accountId !== accountId ||
      this.loadedAccount !== accountId ||
      this.entries.get(entry.name) !== entry
    )
      return;
    const previous = entry.lastRequest;
    entry.lastRequest = { at: new Date().toISOString(), ...result };
    try {
      this.persist();
    } catch (error) {
      entry.lastRequest = previous;
      throw error;
    }
  }
  async dispatch(prepared, signal) {
    const { entry, method, encoded, accountId } = prepared;
    let { url } = prepared;
    const provider = providers[entry.provider];
    const credential = provider?.basic
      ? Buffer.from(entry.credential + ":").toString("base64")
      : entry.credential;
    url = new URL(url);
    if (provider?.queryKey) url.searchParams.set(provider.queryKey, credential);
    let response;
    try {
      response = await this.fetch(url, {
        method,
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
          : AbortSignal.timeout(60000),
        headers: {
          "Content-Type": "application/json",
          ...providers[entry.provider]?.headers,
          ...(entry.header
            ? { [entry.header]: entry.prefix + credential }
            : {}),
        },
        body: encoded,
      });
    } catch {
      this.outcome(entry, accountId, { error: "No response" });
      // Provider/network errors can include the request URL or headers.
      // Return an actionable message without echoing injected credentials.
      throw new Error(
        "The API did not return a response. Check the connection and try again.",
      );
    }
    let raw = Buffer.alloc(0),
      truncated = false;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const available = 65536 - raw.length;
          raw = Buffer.concat([raw, Buffer.from(value).subarray(0, available)]);
          if (value.length > available) {
            truncated = true;
            await reader.cancel();
            break;
          }
        }
      } finally {
        reader.releaseLock();
      }
    }
    let body = null;
    if (!truncated) {
      const text = raw.toString("utf8");
      try {
        body = redact(redact(JSON.parse(text), entry.credential), credential);
      } catch {
        body = text
          .replaceAll(entry.credential, "[credential]")
          .replaceAll(credential, "[credential]");
      }
    }
    this.outcome(entry, accountId, { status: response.status });
    return {
      status: response.status,
      body,
      truncated,
      requestId: (
        response.headers.get("x-request-id") ||
        response.headers.get("x-github-request-id") ||
        ""
      )
        .replaceAll(entry.credential, "[credential]")
        .replaceAll(credential, "[credential]")
        .slice(0, 256),
      bodySha256: crypto.createHash("sha256").update(raw).digest("hex"),
    };
  }
}

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const providers = {
  openai: {
    origin: "https://api.openai.com",
    header: "Authorization",
    prefix: "Bearer ",
  },
  anthropic: {
    origin: "https://api.anthropic.com",
    header: "x-api-key",
    prefix: "",
    headers: { "anthropic-version": "2023-06-01" },
  },
  gemini: {
    origin: "https://generativelanguage.googleapis.com",
    header: "x-goog-api-key",
    prefix: "",
  },
  github: {
    origin: "https://api.github.com",
    header: "Authorization",
    prefix: "Bearer ",
    headers: { Accept: "application/vnd.github+json" },
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
  persist() {
    const encrypted = this.seal(JSON.stringify([...this.entries.values()]));
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = this.file + "." + crypto.randomUUID();
    try {
      fs.writeFileSync(temporary, encrypted, { mode: 0o600, flag: "wx" });
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
      .map(({ credential, prefix, ...entry }) => entry);
  }
  save(input) {
    this.load();
    const { name, provider } = input;
    if (!/^[a-z][a-z0-9._-]{1,79}$/.test(name || ""))
      throw new Error("Use a connection name such as openai.work.");
    const preset = providers[provider];
    if (!preset && provider !== "custom")
      throw new Error("Choose an API provider.");
    let origin, header, prefix;
    if (preset) ({ origin, header, prefix } = preset);
    else {
      const url = new URL(input.origin);
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
      (existing?.origin === origin &&
      existing?.provider === provider &&
      existing?.header === header
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
    const entry = {
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
    };
    this.entries.set(name, entry);
    try {
      this.persist();
    } catch (error) {
      existing ? this.entries.set(name, existing) : this.entries.delete(name);
      throw error;
    }
    return this.list();
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
    return { entry, method, url, encoded };
  }
  async request(input) {
    return this.dispatch(this.prepare(input), input.signal);
  }
  async dispatch({ entry, method, url, encoded }, signal) {
    const response = await this.fetch(url, {
      method,
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
        : AbortSignal.timeout(60000),
      headers: {
        "Content-Type": "application/json",
        ...providers[entry.provider]?.headers,
        [entry.header]: entry.prefix + entry.credential,
      },
      body: encoded,
    });
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
        body = redact(JSON.parse(text), entry.credential);
      } catch {
        body = text.replaceAll(entry.credential, "[credential]");
      }
    }
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
        .slice(0, 256),
      bodySha256: crypto.createHash("sha256").update(raw).digest("hex"),
    };
  }
}

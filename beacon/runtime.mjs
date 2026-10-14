import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const agents = new Set(["codex", "claude-code", "antigravity"]);

export class Runtime {
  constructor(
    home,
    { onPluginSignIn = () => {}, onConnectionChange = () => {}, port = 0 } = {},
  ) {
    this.home = home;
    this.port = port;
    this.onPluginSignIn = onPluginSignIn;
    this.onConnectionChange = onConnectionChange;
    this.account = null;
    this.clients = new Map();
    this.requests = new Map();
    this.db = null;
    this.recordCount = 0;
    this.server = null;
    this.connectionStore = null;
    this.apiRequests = new Map();
  }

  status() {
    let records = 0;
    if (
      this.account &&
      this.clients.size &&
      fs.existsSync(this.databasePath())
    ) {
      this.storage();
      records = this.recordCount;
    }
    return {
      account: this.account
        ? {
            name: this.account.name,
            handle: this.account.handle,
            provider: this.account.provider,
          }
        : null,
      recording: Boolean(this.account && this.clients.size),
      clients: [...this.clients.values()].map((c) => ({
        agent: c.agent,
        connectedAt: c.connectedAt,
        lastActivity: c.lastActivity,
      })),
      records,
    };
  }

  signIn(account) {
    if (!/^[a-f0-9]{64}$/.test(account?.accountId || ""))
      throw new Error("An authenticated ASIP account is required.");
    if (this.account?.accountId !== account.accountId) this.signOut();
    this.account = account;
  }
  signOut() {
    this.abortRequests();
    this.connectionStore?.clear();
    this.account = null;
    this.clients.clear();
    this.requests.clear();
    this.db?.close();
    this.db = null;
    this.recordCount = 0;
  }
  cancelSignIn(id) {
    this.requests.delete(id);
  }
  disconnect(agent) {
    this.abortRequests(agent);
    for (const [token, client] of this.clients)
      if (client.agent === agent) this.clients.delete(token);
  }
  expireRequests() {
    for (const [id, request] of this.requests)
      if (request.expires < Date.now()) this.requests.delete(id);
  }

  requestSignIn({ agent, challenge }) {
    if (!agents.has(agent) || !/^[a-f0-9]{64}$/.test(challenge || ""))
      throw new Error("Invalid plugin connection.");
    if (!this.account) throw new Error("Sign in to ASIP Beacon first.");
    this.expireRequests();
    if (this.requests.size)
      throw new Error("Finish the pending sign-in first.");
    const id = crypto.randomUUID();
    this.requests.set(id, {
      agent,
      challenge,
      expires: Date.now() + 300000,
      accountId: this.account.accountId,
    });
    this.onPluginSignIn({
      id,
      agent,
      account: this.account.handle,
      provider: this.account.provider,
    });
    return { requestId: id };
  }

  completeSignIn(id, identity) {
    const request = this.requests.get(id);
    if (!request || request.expires < Date.now())
      throw new Error("Plugin sign-in expired. Try again.");
    if (
      !this.account ||
      identity.accountId !== this.account.accountId ||
      request.accountId !== identity.accountId
    )
      throw new Error("Sign in with the account shown in ASIP Beacon.");
    if (request.token) throw new Error("Plugin sign-in is already complete.");
    const token = crypto.randomBytes(32).toString("base64url");
    const client = {
      agent: request.agent,
      accountId: identity.accountId,
      connectedAt: new Date().toISOString(),
      lastActivity: null,
    };
    request.client = client;
    request.token = token;
    return this.status();
  }

  pollSignIn(id, verifier) {
    const request = this.requests.get(id);
    if (
      !request ||
      request.expires < Date.now() ||
      hash(verifier || "") !== request.challenge
    )
      throw new Error("Plugin sign-in expired. Try again.");
    if (!request.token) return { state: "pending" };
    this.disconnect(request.agent);
    this.clients.set(hash(request.token), request.client);
    this.onConnectionChange();
    this.requests.delete(id);
    return { state: "connected", token: request.token, agent: request.agent };
  }

  client(token) {
    const client = this.clients.get(hash(token || ""));
    if (!this.account || !client || client.accountId !== this.account.accountId)
      throw new Error("Sign in to the ASIP plugin.");
    return client;
  }

  databasePath() {
    return path.join(
      this.home,
      "accounts",
      this.account.accountId,
      "activity.sqlite",
    );
  }

  storage() {
    if (!this.account) throw new Error("Sign in to ASIP Beacon first.");
    if (!this.db) {
      const directory = path.join(
        this.home,
        "accounts",
        this.account.accountId,
      );
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      this.db = new DatabaseSync(this.databasePath());
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, at TEXT NOT NULL, agent TEXT NOT NULL, session TEXT NOT NULL, kind TEXT NOT NULL, project TEXT, summary TEXT NOT NULL, data TEXT NOT NULL);",
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS events_project_time ON events(project,at); CREATE INDEX IF NOT EXISTS events_session ON events(agent,session,at);",
      );
      this.recordCount = this.db
        .prepare("SELECT count(*) AS n FROM events")
        .get().n;
    }
    return this.db;
  }

  record(token, event) {
    const client = this.client(token);
    if (!event || typeof event !== "object")
      throw new Error("An event is required.");
    const session = event.session,
      project = Object.hasOwn(event, "project")
        ? event.project || null
        : this.projectForSession(client.agent, session);
    if (
      typeof session !== "string" ||
      !session ||
      session.length > 200 ||
      typeof event.kind !== "string" ||
      !event.kind ||
      event.kind.length > 100
    )
      throw new Error("A session and event type are required.");
    if (
      project !== null &&
      (typeof project !== "string" || project.length > 2000)
    )
      throw new Error("Invalid project.");
    const id = crypto.randomUUID(),
      at = new Date().toISOString();
    const data = JSON.stringify(event.data || {});
    if (data.length > 65536) throw new Error("Event is too large.");
    this.storage()
      .prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?)")
      .run(
        id,
        at,
        client.agent,
        session,
        event.kind,
        project,
        String(event.summary || event.kind).slice(0, 2000),
        data,
      );
    client.lastActivity = at;
    this.recordCount++;
    client.lastSession = session;
    client.lastProject = project;
    return { id, at };
  }

  projectForSession(agent, session) {
    if (
      typeof session !== "string" ||
      !session ||
      (!this.db && !fs.existsSync(this.databasePath()))
    )
      return null;
    return (
      this.storage()
        .prepare(
          "SELECT project FROM events WHERE agent=? AND session=? ORDER BY at DESC,rowid DESC LIMIT 1",
        )
        .get(agent, session)?.project || null
    );
  }

  projects() {
    if (!this.account) throw new Error("Sign in to ASIP Beacon first.");
    if (!this.db && !fs.existsSync(this.databasePath())) return [];
    return this.storage()
      .prepare(
        "SELECT project AS id,COUNT(*) AS events,COUNT(DISTINCT session) AS sessions,group_concat(DISTINCT agent) AS agents,MAX(at) AS lastActivity FROM events WHERE project IS NOT NULL GROUP BY project ORDER BY MAX(at) DESC",
      )
      .all()
      .map((row) => ({
        ...row,
        name: row.id.split("/").filter(Boolean).at(-1),
        agents: row.agents.split(","),
      }));
  }

  abortRequests(agent, connection) {
    for (const [id, pending] of this.apiRequests) {
      if (agent && pending.agent !== agent) continue;
      if (connection && pending.name !== connection) continue;
      try {
        this.record(pending.token, {
          ...pending.event,
          kind: "api_unresolved",
          summary: "API request interrupted: " + pending.name,
          data: {
            connection: pending.name,
            request: id,
            reason: "Plugin disconnected before a response was recorded.",
          },
        });
      } catch {
        this.recordingError = "ASIP could not save activity.";
      }
      pending.finalized = true;
      pending.controller.abort();
      this.apiRequests.delete(id);
    }
  }

  async apiRequest(token, input) {
    const client = this.client(token);
    if (!this.connectionStore)
      throw new Error("API connections are unavailable.");
    const project =
      input.project || this.projectForSession(client.agent, input.session);
    const prepared = this.connectionStore.prepare({ ...input, project });
    const event = {
      session: input.session,
      project,
      kind: "api_request",
      summary: prepared.method + " " + input.name + prepared.url.pathname,
      data: {
        connection: input.name,
        method: prepared.method,
        url: prepared.url.origin + prepared.url.pathname,
        native_session: input.data?.native_session,
      },
    };
    const recorded = this.record(token, event);
    const pending = {
      agent: client.agent,
      token,
      event,
      name: input.name,
      controller: new AbortController(),
      finalized: false,
    };
    this.apiRequests.set(recorded.id, pending);
    try {
      const result = await this.connectionStore.dispatch(
        prepared,
        pending.controller.signal,
      );
      if (pending.finalized)
        throw new Error("The plugin disconnected during this request.");
      this.record(token, {
        ...event,
        kind: result.status < 400 ? "api_result" : "api_failed",
        summary: input.name + " returned HTTP " + result.status,
        data: {
          ...event.data,
          request: recorded.id,
          status: result.status,
          providerRequestId: result.requestId,
          bodySha256: result.bodySha256,
          truncated: result.truncated,
        },
      });
      return { ...result, auditId: recorded.id };
    } catch (error) {
      if (!pending.finalized)
        this.record(token, {
          ...event,
          kind: "api_unresolved",
          summary: "No API response recorded: " + input.name,
          data: {
            ...event.data,
            request: recorded.id,
            reason: "The request did not return a complete response.",
          },
        });
      throw error;
    } finally {
      this.apiRequests.delete(recorded.id);
    }
  }

  recall(token, { project, query = "", limit = 20 } = {}) {
    this.client(token);
    if (!this.db && !fs.existsSync(this.databasePath())) return { events: [] };
    if (typeof query !== "string") throw new Error("Enter a search term.");
    this.storage();
    const rows = this.db
      .prepare(
        "SELECT * FROM events WHERE (? IS NULL OR project=?) AND (instr(lower(summary),lower(?)) > 0 OR instr(lower(data),lower(?)) > 0) ORDER BY at DESC,rowid DESC LIMIT ?",
      )
      .all(
        project || null,
        project || null,
        query,
        query,
        Math.max(1, Math.min(100, Number(limit) || 20)),
      );
    return {
      events: rows.map((row) => ({ ...row, data: JSON.parse(row.data) })),
    };
  }

  async listen() {
    this.server = http.createServer(async (req, res) => {
      const send = (code, data) => {
        res.writeHead(code, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(data));
      };
      if (req.headers.host !== this.host || req.headers.origin) {
        send(403, { error: "Use the installed ASIP plugin." });
        return;
      }
      if (req.method === "GET" && req.url === "/status") {
        send(200, { running: true, signedIn: Boolean(this.account) });
        return;
      }
      if (req.method !== "POST") {
        send(404, { error: "Not found." });
        return;
      }
      try {
        let raw = "";
        for await (const block of req) {
          raw += block;
          if (raw.length > 131072) throw new Error("Request is too large.");
        }
        const body = JSON.parse(raw),
          token = (req.headers.authorization || "").replace(/^Bearer /, "");
        let data;
        if (req.url === "/plugin/signin") data = this.requestSignIn(body);
        else if (req.url === "/plugin/poll")
          data = this.pollSignIn(body.requestId, body.verifier);
        else if (req.url === "/plugin/status") {
          const c = this.client(token);
          data = {
            connected: true,
            agent: c.agent,
            account: this.account.handle,
            session:
              typeof body.session === "string" && body.session
                ? body.session
                : null,
            project: this.projectForSession(c.agent, body.session),
            lastSession: c.lastSession || null,
            lastProject: c.lastProject || null,
          };
        } else if (req.url === "/projects") {
          this.client(token);
          data = { projects: this.projects() };
        } else if (req.url === "/connections") {
          this.client(token);
          if (!this.connectionStore)
            throw new Error("API connections are unavailable.");
          data = { connections: this.connectionStore.list(body.project) };
        } else if (req.url === "/api/request")
          data = await this.apiRequest(token, body);
        else if (req.url === "/events") data = this.record(token, body);
        else if (req.url === "/recall") data = this.recall(token, body);
        else {
          send(404, { error: "Not found." });
          return;
        }
        send(200, data);
      } catch (error) {
        send(401, { error: error.message });
      }
    });
    this.server.requestTimeout = 15000;
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, "127.0.0.1", resolve);
    });
    this.host = "127.0.0.1:" + this.server.address().port;
    return "http://" + this.host;
  }
  async close() {
    this.signOut();
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
  }
}

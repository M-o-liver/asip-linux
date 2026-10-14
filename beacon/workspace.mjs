import fs from "node:fs";
import crypto from "node:crypto";
import { ownTools } from "./runtime.mjs";

export class Workspace {
  constructor(runtime, { openBeacon = () => {} } = {}) {
    this.runtime = runtime;
    this.openBeacon = openBeacon;
    this.tickets = new Map();
    this.sessions = new Map();
    this.assets = new Map(
      ["index.html", "workspace.js", "workspace.css"].map((name) => [
        name,
        fs.readFileSync(new URL("workspace/" + name, import.meta.url)),
      ]),
    );
    runtime.workspace = this;
  }
  clear() {
    this.tickets.clear();
    this.sessions.clear();
  }
  openURL() {
    if (!this.runtime.account) throw new Error("Sign in to ASIP Beacon first.");
    for (const map of [this.tickets, this.sessions])
      for (const [id, entry] of map)
        if (entry.expires < Date.now()) map.delete(id);
    const ticket = crypto.randomBytes(32).toString("hex");
    this.tickets.set(ticket, {
      account: this.runtime.account.accountId,
      expires: Date.now() + 30000,
    });
    return "http://" + this.runtime.host + "/workspace/open?ticket=" + ticket;
  }
  authorized(entry) {
    return (
      entry &&
      entry.expires > Date.now() &&
      entry.account === this.runtime.account?.accountId
    );
  }
  async handle(req, res) {
    const url = new URL(req.url, "http://" + this.runtime.host);
    const send = (status, value, type = "application/json", headers = {}) => {
      res.writeHead(status, {
        "Content-Type": type,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        ...headers,
      });
      res.end(type === "application/json" ? JSON.stringify(value) : value);
    };
    if (
      req.headers.origin &&
      req.headers.origin !== "http://" + this.runtime.host
    ) {
      send(403, { error: "Open ASIP from Beacon." });
      return;
    }
    if (url.pathname === "/workspace/open" && req.method === "GET") {
      const id = url.searchParams.get("ticket"),
        ticket = this.tickets.get(id);
      this.tickets.delete(id);
      if (!this.authorized(ticket)) {
        send(401, "Open ASIP from Beacon.", "text/plain");
        return;
      }
      const session = crypto.randomBytes(32).toString("hex");
      this.sessions.set(session, {
        account: ticket.account,
        expires: Date.now() + 8 * 3600000,
      });
      send(303, "", "text/plain", {
        Location: "/workspace/",
        "Set-Cookie":
          "asip_workspace=" +
          session +
          "; Path=/workspace; HttpOnly; SameSite=Strict; Max-Age=28800",
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/workspace/beacon") {
      if (req.headers.origin !== "http://" + this.runtime.host) {
        send(403, { error: "Open ASIP from Beacon." });
        return;
      }
      this.openBeacon();
      send(200, { opened: true });
      return;
    }
    const name =
      url.pathname === "/workspace/"
        ? "index.html"
        : url.pathname.slice("/workspace/".length);
    if (req.method === "GET" && this.assets.has(name)) {
      send(
        200,
        this.assets.get(name),
        name.endsWith(".html")
          ? "text/html; charset=utf-8"
          : name.endsWith(".js")
            ? "text/javascript"
            : "text/css",
      );
      return;
    }
    const session = /(?:^|;\s*)asip_workspace=([a-f0-9]{64})(?:;|$)/.exec(
      req.headers.cookie || "",
    )?.[1];
    if (!this.authorized(this.sessions.get(session))) {
      send(401, { error: "Sign in through Beacon, then reopen ASIP." });
      return;
    }
    if (req.method !== "GET") {
      send(405, { error: "Method not supported." });
      return;
    }
    try {
      if (url.pathname === "/workspace/data") {
        send(200, this.data(url.searchParams));
        return;
      }
      send(404, { error: "Not found." });
    } catch {
      send(500, { error: "ASIP could not read project history." });
    }
  }
  data(params) {
    const runtime = this.runtime;
    const project = params.get("project"),
      query = params.get("query") || "",
      session = params.get("session"),
      agent = params.get("agent"),
      kind = params.get("kind");
    if (
      query.length > 2000 ||
      (project?.length || 0) > 2000 ||
      (session?.length || 0) > 200
    )
      throw new Error("Invalid filter.");
    const base = {
      account: runtime.status().account,
      projects: runtime.projects(),
      events: [],
      sessions: [],
      relationships: [],
      directories: [],
      connections: [],
    };
    try {
      base.connections =
        runtime.connectionStore?.list(
          project === "unassigned" ? undefined : project,
        ) || [];
    } catch {
      base.connectionError = "API connections could not be opened.";
    }
    if (!runtime.db && !fs.existsSync(runtime.databasePath())) return base;
    const db = runtime.storage();
    if (project === "unassigned")
      base.connections = base.connections.filter(
        (connection) => !connection.projects.length,
      );
    const scope = project === "unassigned" ? null : project;
    const filter = "(?=0 OR project IS ?)";
    const restrict = project ? 1 : 0;
    base.sessions = db
      .prepare(
        "SELECT agent,session,COUNT(*) AS events,MIN(at) AS startedAt,MAX(at) AS lastActivity FROM events WHERE " +
          filter +
          " GROUP BY agent,session ORDER BY MAX(at) DESC LIMIT 100",
      )
      .all(restrict, scope);
    base.directories = db
      .prepare(
        "SELECT DISTINCT COALESCE(json_extract(data,'$.project_evidence.repositoryRoot'),json_extract(data,'$.cwd')) AS directory FROM events WHERE " +
          filter +
          " AND directory IS NOT NULL AND directory<>'' LIMIT 30",
      )
      .all(restrict, scope)
      .map((row) => row.directory);
    base.relationships = db
      .prepare(
        "WITH memberships AS (SELECT DISTINCT agent,session,project FROM events WHERE project IS NOT NULL) SELECT a.project AS source,b.project AS target,COUNT(*) AS sessions FROM memberships a JOIN memberships b ON a.agent=b.agent AND a.session=b.session AND a.project<b.project GROUP BY a.project,b.project LIMIT 100",
      )
      .all();
    const category =
      kind === "work"
        ? " AND kind IN ('intent','result','evidence','Stop','tool_succeeded','api_result','api_failed','failed','unresolved','api_unresolved','PostToolUseFailure','StopFailure')"
        : kind === "intent"
          ? " AND kind='intent'"
          : kind === "results"
            ? " AND kind IN ('result','evidence','Stop','tool_succeeded','api_result','api_failed','failed')"
            : kind === "unresolved"
              ? " AND kind IN ('unresolved','api_unresolved')"
              : "";
    const offset = Math.max(
      0,
      Math.min(100000, Number(params.get("offset")) || 0),
    );
    const rows = db
      .prepare(
        "SELECT * FROM events WHERE " +
          filter +
          " AND (? IS NULL OR session=?) AND (? IS NULL OR agent=?) AND (?=1 OR NOT EXISTS (SELECT 1 FROM json_each(?) WHERE substr(COALESCE(json_extract(events.data,'$.tool'),''),-length(value))=value)) AND (instr(lower(summary),lower(?))>0 OR instr(lower(data),lower(?))>0)" +
          category +
          " ORDER BY at DESC,rowid DESC LIMIT 51 OFFSET ?",
      )
      .all(
        restrict,
        scope,
        session,
        session,
        agent,
        agent,
        params.get("audit") === "true" ? 1 : 0,
        ownTools,
        query,
        query,
        offset,
      );
    base.more = rows.length > 50;
    base.events = rows
      .slice(0, 50)
      .map((row) => ({ ...row, data: JSON.parse(row.data) }));
    base.unassigned = db
      .prepare("SELECT count(*) AS n FROM events WHERE project IS NULL")
      .get().n;
    return base;
  }
}

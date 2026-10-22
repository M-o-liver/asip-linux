import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import { canonical, cloudEvent, sha256 } from "./cloud-protocol.mjs";
import { deviceKey, openDeviceReply } from "./device-link.mjs";

export class CloudSync {
  constructor(
    runtime,
    {
      seal,
      unseal,
      openBrowser,
      fetcher = fetch,
      origin = "https://asip.ca",
      onChange = () => {},
      interval = 30000,
    } = {},
  ) {
    Object.assign(this, {
      runtime,
      seal,
      unseal,
      openBrowser,
      fetch: fetcher,
      origin,
      onChange,
      interval,
    });
    const url = new URL(origin);
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && url.hostname === "127.0.0.1")
    )
      throw new Error("Use the ASIP HTTPS cloud service.");
    if (
      url.pathname !== "/" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Use a cloud origin.");
    runtime.cloud = this;
    this.loadedAccount = null;
    this.connection = null;
    this.error = "";
    this.lastSync = null;
    this.sent = 0;
    this.received = 0;
    this.retryAt = 0;
    this.failures = 0;
  }
  load() {
    const id = this.runtime.account?.accountId;
    if (id === this.loadedAccount) return;
    this.stop();
    this.loadedAccount = id;
    this.connection = null;
    this.lastSync = null;
    this.error = "";
    this.retryAt = 0;
    this.failures = 0;
    if (!id) return;
    this.file = path.join(this.runtime.home, "accounts", id, "cloud.bin");
    if (fs.existsSync(this.file)) {
      this.connection = JSON.parse(this.unseal(fs.readFileSync(this.file)));
      if (this.connection.origin !== this.origin)
        throw new Error("The saved cloud service differs from this build.");
      this.retryAt = Number(this.connection.retryAt) || 0;
      this.error = this.connection.syncError || "";
    }
  }
  persist() {
    const encrypted = this.seal(JSON.stringify(this.connection)),
      temporary = this.file + "." + crypto.randomUUID();
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(temporary, encrypted, { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  status() {
    try {
      this.load();
    } catch {
      this.error =
        "The cloud connection could not be opened with the system keychain.";
    }
    let pending = 0;
    if (this.connection && this.runtime.db)
      try {
        pending = this.runtime.db
          .prepare(
            "SELECT COUNT(*) AS n FROM events e LEFT JOIN cloud_acked a ON a.id=e.id WHERE a.id IS NULL",
          )
          .get().n;
      } catch {}
    return {
      connected: Boolean(this.connection),
      account: this.connection?.account?.handle || null,
      workspace: this.connection
        ? this.origin + "/users/" + this.connection.account.handle
        : null,
      syncing: Boolean(this.inflight),
      lastSync: this.lastSync,
      error: this.error,
      sent: this.sent,
      received: this.received,
      pending,
      connecting: Boolean(this.pairing),
      retryAt: this.retryAt ? new Date(this.retryAt).toISOString() : null,
      reconnectRequired: Boolean(this.connection?.reconnectRequired),
    };
  }
  start() {
    this.load();
    if (!this.connection || this.timer) return;
    this.timer = setInterval(() => this.sync().catch(() => {}), this.interval);
    this.timer.unref?.();
    this.sync().catch(() => {});
  }
  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.cancelPair?.();
  }
  async request(
    route,
    { method = "GET", body, connection = this.connection, signal } = {},
  ) {
    const response = await this.fetch(this.origin + route, {
      method,
      redirect: "manual",
      headers: {
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(connection?.token
          ? { Authorization: "Bearer " + connection.token }
          : {}),
        ...(connection?.access
          ? { Cookie: "CF_Authorization=" + connection.access }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const error = new Error(
        "The private preview session expired. Reconnect cloud to sign in again.",
      );
      error.code = "PREVIEW_SESSION";
      throw error;
    }
    let raw = "";
    if (response.body) {
      const reader = response.body.getReader();
      let size = 0;
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 4 * 1024 * 1024) {
            await reader.cancel();
            throw new Error("The cloud response is too large.");
          }
          raw += decoder.decode(value, { stream: true });
        }
        raw += decoder.decode();
      } finally {
        reader.releaseLock();
      }
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(
        "ASIP cloud did not return a complete response. Reconnect cloud if preview sign-in expired.",
      );
    }
    if (!response.ok) {
      const error = new Error(
        data.error || "ASIP cloud returned HTTP " + response.status + ".",
      );
      const delay = Number(
        data.retryAfter || response.headers.get("Retry-After"),
      );
      if (Number.isFinite(delay) && delay > 0)
        error.retryAt = Date.now() + Math.min(delay, 86400) * 1000;
      error.status = response.status;
      error.code = data.code;
      throw error;
    }
    return data;
  }
  async connect() {
    this.load();
    if (!this.runtime.account) throw new Error("Sign in to Beacon first.");
    if (this.pairing)
      throw new Error("Finish the cloud connection in your browser.");
    this.pairing = true;
    this.error = "";
    this.onChange();
    const localAccount = this.runtime.account.accountId,
      verifier = crypto.randomBytes(32).toString("hex"),
      state = crypto.randomBytes(32).toString("hex");
    let server, timer, challenge, link;
    try {
      challenge = await sha256(verifier);
      link = await deviceKey();
      const received = new Promise((resolve, reject) => {
        server = http.createServer(async (req, res) => {
          const finish = (status, message) => {
            res.writeHead(status, {
              "Content-Type": "text/plain; charset=utf-8",
              "Cache-Control": "no-store",
              "Referrer-Policy": "no-referrer",
              "Content-Security-Policy":
                "default-src 'none'; frame-ancestors 'none'",
            });
            res.end(message);
          };
          let callback;
          try {
            callback = new URL(req.url, "http://127.0.0.1");
          } catch {
            finish(400, "Invalid ASIP connection.");
            return;
          }
          if (
            req.method !== "GET" ||
            callback.pathname !== "/callback" ||
            req.url.length > 24000 ||
            req.headers.host !== "127.0.0.1:" + server.address().port
          ) {
            finish(400, "Invalid ASIP connection.");
            return;
          }
          let reply;
          try {
            reply = await openDeviceReply(
              callback.searchParams.get("response"),
              link.privateKey,
              challenge,
              state,
            );
          } catch {
            finish(400, "Invalid ASIP connection.");
            return;
          }
          if (
            reply.state !== state ||
            !/^[a-f0-9]{64}$/.test(reply.code || "") ||
            typeof reply.access !== "string" ||
            /[\r\n;]/.test(reply.access)
          ) {
            finish(400, "Invalid ASIP connection.");
            return;
          }
          res.writeHead(303, {
            Location: this.origin + "/auth/access",
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
          });
          res.end();
          resolve({
            code: reply.code,
            access: reply.access,
          });
        });
        this.cancelPair = () =>
          reject(new Error("Cloud connection cancelled."));
        timer = setTimeout(
          () => reject(new Error("Cloud connection expired. Try again.")),
          300000,
        );
      });
      received.catch(() => {});
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const url = new URL(this.origin + "/connect");
      url.search = new URLSearchParams({
        challenge,
        state,
        publicKey: link.publicKey,
        redirect: "http://127.0.0.1:" + server.address().port + "/callback",
        label: os.hostname(),
        platform: process.platform,
        account: this.runtime.account.handle || "",
      }).toString();
      await this.openBrowser(url.href);
      const { code, access } = await received;
      if (this.runtime.account?.accountId !== localAccount)
        throw new Error("The Beacon account changed.");
      const result = await this.request("/api/v1/devices/redeem", {
        method: "POST",
        body: { code, verifier },
        connection: { access },
      });
      if (this.runtime.account?.accountId !== localAccount)
        throw new Error("The Beacon account changed.");
      if (
        !/^[a-f0-9]{64}$/.test(result.account?.id || "") ||
        !/^asip_[a-f0-9]{64}$/.test(result.token || "")
      )
        throw new Error("Invalid cloud account response.");
      const db = this.schema(),
        binding = db
          .prepare("SELECT account_id FROM cloud_binding WHERE id=1")
          .get();
      if (binding && binding.account_id !== result.account.id) {
        await this.request("/api/v1/devices/self/revoke", {
          method: "POST",
          connection: { ...result, access },
        }).catch(() => {});
        throw new Error(
          "This local history belongs to another cloud account. Use a separate Beacon account.",
        );
      }
      db.prepare("INSERT OR IGNORE INTO cloud_binding VALUES(1,?)").run(
        result.account.id,
      );
      const previous = this.connection;
      this.connection = { ...result, access, origin: this.origin };
      // Fresh admission clears an authentication/network backoff. A quota pause
      // belongs to the service allowance and must survive reauthorization too.
      this.retryAt =
        previous?.quotaRetryAt > Date.now() ? previous.quotaRetryAt : 0;
      this.failures = 0;
      this.error = this.retryAt ? previous.syncError : "";
      if (this.retryAt)
        Object.assign(this.connection, {
          retryAt: this.retryAt,
          quotaRetryAt: this.retryAt,
          syncError: this.error,
        });
      try {
        this.persist();
      } catch (error) {
        this.connection = previous;
        throw error;
      }
      if (previous?.id && previous.account.id === result.account.id)
        await this.request("/api/v1/devices/self/revoke", {
          method: "POST",
          connection: { ...previous, access },
        }).catch(() => {});
      this.start();
      return this.status();
    } catch (error) {
      this.error = error.message;
      throw error;
    } finally {
      clearTimeout(timer);
      this.cancelPair = null;
      server?.close();
      server?.closeAllConnections();
      this.pairing = false;
      this.onChange();
    }
  }
  schema() {
    const db = this.runtime.storage();
    db.exec(
      "CREATE TABLE IF NOT EXISTS cloud_binding(id INTEGER PRIMARY KEY CHECK(id=1),account_id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS cloud_acked(id TEXT PRIMARY KEY,sha256 TEXT NOT NULL); CREATE TABLE IF NOT EXISTS cloud_cursor(id INTEGER PRIMARY KEY CHECK(id=1),cursor INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS cloud_catalogue_acked(device TEXT NOT NULL,kind TEXT NOT NULL,key TEXT NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(device,kind,key)); CREATE TABLE IF NOT EXISTS cloud_catalogue_state(device TEXT PRIMARY KEY,initialized INTEGER NOT NULL,pulled_at INTEGER NOT NULL);",
    );
    return db;
  }
  async sync() {
    this.load();
    if (!this.connection) return;
    if (this.inflight) return this.inflight;
    if (this.retryAt > Date.now())
      throw new Error(
        this.error || "Cloud synchronization is waiting before retrying.",
      );
    const local = this.runtime.account.accountId,
      connection = this.connection;
    const controller = (this.controller = new AbortController());
    const active = () => {
      controller.signal.throwIfAborted();
      if (
        this.runtime.account?.accountId !== local ||
        this.connection !== connection
      )
        throw new Error("The cloud account changed.");
    };
    this.inflight = (async () => {
      try {
        const db = this.schema();
        const binding = db
          .prepare("SELECT account_id FROM cloud_binding WHERE id=1")
          .get();
        if (binding?.account_id !== connection.account.id)
          throw new Error("Cloud account binding does not match this history.");
        // Fixed-size passes keep backlog work bounded and let new local recording
        // continue while the network is unavailable. Acknowledgments are durable.
        for (let batch = 0; batch < 20; batch++) {
          active();
          const pending = db
            .prepare(
              "SELECT e.* FROM events e LEFT JOIN cloud_acked a ON a.id=e.id WHERE a.id IS NULL ORDER BY e.rowid DESC LIMIT 40",
            )
            .all();
          if (!pending.length) break;
          const events = [];
          let bytes = 0;
          for (const row of pending) {
            const event = cloudEvent({ ...row, data: JSON.parse(row.data) }),
              size = Buffer.byteLength(JSON.stringify(event));
            if (events.length && bytes + size > 450000) break;
            events.push(event);
            bytes += size;
          }
          const result = await this.request("/api/v1/sync/push", {
            method: "POST",
            body: { events },
            signal: controller.signal,
          });
          active();
          if (
            !Array.isArray(result.accepted) ||
            result.accepted.length !== events.length
          )
            throw new Error(
              "The cloud did not acknowledge this complete batch.",
            );
          const hashes = await Promise.all(
            events.map(async (e) => [e.id, await sha256(canonical(e))]),
          );
          active();
          if (
            hashes.some(
              ([id, digest]) =>
                !result.accepted.some(
                  (a) => a.id === id && a.sha256 === digest,
                ),
            )
          )
            throw new Error(
              "A cloud acknowledgment did not pass its integrity check.",
            );
          db.exec("BEGIN IMMEDIATE");
          try {
            for (const [id, digest] of hashes)
              db.prepare("INSERT OR REPLACE INTO cloud_acked VALUES(?,?)").run(
                id,
                digest,
              );
            db.exec("COMMIT");
          } catch (e) {
            db.exec("ROLLBACK");
            throw e;
          }
          this.sent += events.length;
        }
        for (let batch = 0; batch < 20; batch++) {
          active();
          const cursor =
            db.prepare("SELECT cursor FROM cloud_cursor WHERE id=1").get()
              ?.cursor || 0;
          const response = await this.request(
            "/api/v1/sync/pull?cursor=" + cursor,
            { signal: controller.signal },
          );
          active();
          if (
            !Array.isArray(response.events) ||
            !Number.isSafeInteger(response.cursor) ||
            response.cursor < cursor
          )
            throw new Error("Invalid cloud synchronization response.");
          const checked = [];
          let previous = cursor;
          for (const source of response.events) {
            const event = cloudEvent(source),
              digest = await sha256(canonical(event));
            if (
              source.sha256 !== digest ||
              !Number.isSafeInteger(source.seq) ||
              source.seq <= previous
            )
              throw new Error(
                "A downloaded record did not pass its integrity check.",
              );
            previous = source.seq;
            checked.push({ event, digest });
          }
          if (response.cursor !== previous)
            throw new Error("Invalid cloud synchronization cursor.");
          const additions = [];
          for (const { event: e, digest } of checked) {
            const existing = db
              .prepare("SELECT * FROM events WHERE id=?")
              .get(e.id);
            if (
              existing &&
              (await sha256(
                canonical(
                  cloudEvent({ ...existing, data: JSON.parse(existing.data) }),
                ),
              )) !== digest
            )
              throw new Error(
                "A downloaded record conflicts with local evidence.",
              );
            if (!existing) additions.push(e);
          }
          active();
          db.exec("BEGIN IMMEDIATE");
          try {
            for (const e of additions)
              db.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?)").run(
                e.id,
                e.at,
                e.agent,
                e.session,
                e.kind,
                e.project,
                e.summary,
                JSON.stringify(e.data),
              );
            for (const { event: e, digest } of checked)
              db.prepare("INSERT OR REPLACE INTO cloud_acked VALUES(?,?)").run(
                e.id,
                digest,
              );
            db.prepare("INSERT OR REPLACE INTO cloud_cursor VALUES(1,?)").run(
              response.cursor,
            );
            db.exec("COMMIT");
            this.received += additions.length;
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
          if (!response.more) break;
        }
        active();
        const outgoingCatalogue = {
          projects: db
            .prepare("SELECT * FROM projects")
            .all()
            .map((p) => ({ ...p, roots: JSON.parse(p.roots) })),
          links: db.prepare("SELECT * FROM project_links").all(),
          sessions: db
            .prepare("SELECT * FROM session_details")
            .all()
            .map((s) => ({ ...s, details: JSON.parse(s.details) })),
          connections: (this.runtime.connectionStore?.list() || []).map(
            ({ name, provider, label, origin, projects }) => ({
              name,
              provider,
              label: label || "",
              origin: origin || "",
              projects,
            }),
          ),
        };
        const metadataState = db
          .prepare("SELECT * FROM cloud_catalogue_state WHERE device=?")
          .get(connection.id);
        const acknowledged = new Map(
          db
            .prepare(
              "SELECT kind,key,sha256 FROM cloud_catalogue_acked WHERE device=?",
            )
            .all(connection.id)
            .map((e) => [e.kind + ":" + e.key, e.sha256]),
        );
        const keyFor = (kind, item) =>
          canonical(
            kind === "sessions"
              ? [item.agent, item.session]
              : kind === "links"
                ? [item.source, item.target, item.relation]
                : [kind === "connections" ? item.name : item.id],
          );
        const entries = [];
        for (const [kind, items] of Object.entries(outgoingCatalogue))
          for (const item of items) {
            const key = keyFor(kind, item),
              digest = await sha256(canonical(item));
            if (acknowledged.get(kind + ":" + key) !== digest)
              entries.push({ kind, item, key, digest });
          }
        active();
        const connectionNames = outgoingCatalogue.connections.map(
          (c) => c.name,
        );
        const removedConnections = [...acknowledged.keys()].some(
          (key) =>
            key.startsWith("connections:") &&
            !connectionNames.some(
              (name) => "connections:" + canonical([name]) === key,
            ),
        );
        const sendMetadata =
          entries.length || removedConnections || !metadataState?.initialized;
        for (
          let i = 0;
          sendMetadata && i < Math.max(1, entries.length);
          i += 30
        ) {
          const chunk = {
            projects: [],
            links: [],
            sessions: [],
            connections: [],
          };
          for (const { kind, item } of entries.slice(i, i + 30))
            chunk[kind].push(item);
          if (i + 30 >= entries.length)
            chunk.pruneConnections = connectionNames;
          await this.request("/api/v1/sync/catalogue", {
            method: "POST",
            body: chunk,
            signal: controller.signal,
          });
          active();
          db.exec("BEGIN IMMEDIATE");
          try {
            for (const entry of entries.slice(i, i + 30))
              db.prepare(
                "INSERT OR REPLACE INTO cloud_catalogue_acked VALUES(?,?,?,?)",
              ).run(connection.id, entry.kind, entry.key, entry.digest);
            if (i + 30 >= entries.length) {
              db.prepare(
                "DELETE FROM cloud_catalogue_acked WHERE device=? AND kind='connections' AND key NOT IN (SELECT value FROM json_each(?))",
              ).run(
                connection.id,
                JSON.stringify(
                  connectionNames.map((name) => canonical([name])),
                ),
              );
              db.prepare(
                "INSERT INTO cloud_catalogue_state VALUES(?,1,0) ON CONFLICT(device) DO UPDATE SET initialized=1",
              ).run(connection.id);
            }
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        }
        active();
        // Events continue every 30 seconds. Slow-changing catalogue/account
        // metadata refreshes at most every five minutes, including after restart.
        if (
          !metadataState?.pulled_at ||
          Date.now() - metadataState.pulled_at >= 300000
        ) {
          const catalogue = await this.request("/api/v1/sync/catalogue", {
            signal: controller.signal,
          });
          active();
          db.exec("BEGIN IMMEDIATE");
          try {
            for (const p of catalogue.projects || []) {
              const existing = db
                .prepare("SELECT * FROM projects WHERE id=?")
                .get(p.id);
              if (existing)
                db.prepare("UPDATE projects SET roots=? WHERE id=?").run(
                  JSON.stringify([
                    ...new Set([
                      ...JSON.parse(existing.roots),
                      ...(p.roots || []),
                    ]),
                  ]),
                  p.id,
                );
              else
                db.prepare("INSERT INTO projects VALUES(?,?,?,?,?,?)").run(
                  p.id,
                  p.name || p.id.split("/").at(-1),
                  p.description || "",
                  p.repository || "",
                  new Date().toISOString(),
                  JSON.stringify(p.roots || []),
                );
            }
            for (const l of catalogue.links || [])
              db.prepare(
                "INSERT OR IGNORE INTO project_links VALUES(?,?,?)",
              ).run(l.source, l.target, l.relation);
            for (const s of catalogue.sessions || [])
              db.prepare(
                "INSERT OR IGNORE INTO session_details VALUES(?,?,?)",
              ).run(s.agent, s.session, JSON.stringify(s.details));
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
          const me = await this.request("/api/v1/me", {
            signal: controller.signal,
          });
          active();
          if (me.account.id !== connection.account.id)
            throw new Error("The cloud account changed.");
          if (
            me.account.handle !== connection.account.handle ||
            me.account.name !== connection.account.name
          ) {
            connection.account = me.account;
            this.persist();
          }
          db.prepare(
            "INSERT INTO cloud_catalogue_state VALUES(?,1,?) ON CONFLICT(device) DO UPDATE SET pulled_at=excluded.pulled_at",
          ).run(connection.id, Date.now());
        }
        this.lastSync = new Date().toISOString();
        this.error = "";
        this.retryAt = 0;
        this.failures = 0;
        if (connection.retryAt || connection.syncError) {
          delete connection.retryAt;
          delete connection.syncError;
          delete connection.quotaRetryAt;
          delete connection.reconnectRequired;
          this.persist();
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          this.error = error.message;
          this.retryAt =
            error.retryAt ||
            Date.now() +
              Math.min(900000, 30000 * 2 ** Math.min(this.failures++, 5));
          connection.retryAt = this.retryAt;
          connection.syncError = this.error;
          connection.reconnectRequired =
            error.code === "PREVIEW_SESSION" || error.status === 401;
          if (["CLOUD_DAILY_QUOTA", "CLOUD_STORAGE_FULL"].includes(error.code))
            connection.quotaRetryAt = this.retryAt;
          try {
            this.persist();
          } catch {
            /* Keep the original actionable network error. */
          }
        }
        throw error;
      } finally {
        this.inflight = null;
        this.onChange();
      }
    })();
    this.onChange();
    return this.inflight;
  }
  async disconnect() {
    this.load();
    this.stop();
    const previous = this.connection,
      local = this.loadedAccount;
    this.connection = null;
    if (this.file) fs.rmSync(this.file, { force: true });
    this.error = "";
    this.onChange();
    if (previous)
      try {
        await this.request("/api/v1/devices/self/revoke", {
          method: "POST",
          connection: previous,
        });
      } catch {
        if (this.loadedAccount === local)
          this.error =
            "Disconnected here. Cloud revocation could not be confirmed; revoke this computer in your cloud workspace.";
      }
    this.onChange();
    return this.status();
  }
}

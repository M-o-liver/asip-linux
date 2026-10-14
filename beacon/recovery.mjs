import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const digest = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
export class Recovery {
  constructor(runtime) {
    this.runtime = runtime;
  }
  directory() {
    if (!this.runtime.account) throw new Error("Sign in to ASIP Beacon first.");
    return path.join(path.dirname(this.runtime.databasePath()), "recovery");
  }
  list() {
    const directory = this.directory();
    if (!fs.existsSync(directory)) return [];
    const records = [];
    for (const id of fs.readdirSync(directory)) {
      if (!/^[a-f0-9-]{36}$/.test(id)) continue;
      try {
        const record = JSON.parse(
          fs.readFileSync(path.join(directory, id, "record.json"), "utf8"),
        );
        if (
          record.id === id &&
          record.version === 1 &&
          typeof record.at === "string" &&
          Number.isSafeInteger(record.sequence) &&
          record.sequence > 0 &&
          Number.isSafeInteger(record.events) &&
          record.events >= 0 &&
          /^[a-f0-9]{64}$/.test(record.sha256)
        )
          records.push(record);
      } catch {
        /* An incomplete checkpoint is not a recovery record. */
      }
    }
    return records.sort((a, b) => b.sequence - a.sequence);
  }
  save(label = "Activity history") {
    const runtime = this.runtime;
    const recoveryDirectory = this.directory();
    if (!runtime.db && !fs.existsSync(runtime.databasePath()))
      throw new Error("No activity history to save yet.");
    const sequence = (this.list()[0]?.sequence || 0) + 1;
    const id = crypto.randomUUID(),
      directory = path.join(recoveryDirectory, id);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      const file = path.join(directory, "activity.sqlite");
      runtime.storage().prepare("VACUUM INTO ?").run(file);
      fs.chmodSync(file, 0o600);
      const snapshot = new DatabaseSync(file, { readOnly: true });
      let events;
      try {
        events = snapshot.prepare("SELECT count(*) AS n FROM events").get().n;
      } finally {
        snapshot.close();
      }
      const record = {
        version: 1,
        id,
        sequence,
        at: new Date().toISOString(),
        label,
        events,
        sha256: digest(fs.readFileSync(file)),
      };
      fs.writeFileSync(
        path.join(directory, "record.json"),
        JSON.stringify(record),
        { mode: 0o600 },
      );
      for (const old of this.list().slice(10))
        fs.rmSync(path.join(this.directory(), old.id), { recursive: true });
      return this.list();
    } catch (error) {
      fs.rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }
  restore(id) {
    const record = this.list().find((entry) => entry.id === id);
    if (!record) throw new Error("Choose an existing recovery record.");
    const bytes = fs.readFileSync(
      path.join(this.directory(), id, "activity.sqlite"),
    );
    if (digest(bytes) !== record.sha256)
      throw new Error("This recovery record could not be verified.");
    const runtime = this.runtime,
      file = runtime.databasePath();
    const incoming = file + ".restore-" + crypto.randomUUID();
    try {
      fs.writeFileSync(incoming, bytes, { mode: 0o600, flag: "wx" });
      const snapshot = new DatabaseSync(incoming, { readOnly: true });
      try {
        const check = snapshot.prepare("PRAGMA integrity_check").get();
        if (Object.values(check)[0] !== "ok")
          throw new Error("The saved history is damaged.");
        snapshot
          .prepare(
            "SELECT id,at,agent,session,kind,project,summary,data FROM events LIMIT 1",
          )
          .all();
      } finally {
        snapshot.close();
      }
      // Stage the chosen snapshot before making the current checkpoint: the
      // ten-record retention rule may prune the chosen oldest record.
      if (runtime.db || fs.existsSync(file)) this.save("Before restore");
      runtime.db?.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      runtime.db?.close();
      runtime.db = null;
      runtime.recordCount = 0;
      for (const suffix of ["-wal", "-shm"])
        fs.rmSync(file + suffix, { force: true });
      fs.renameSync(incoming, file);
      runtime.storage();
      return this.list();
    } finally {
      fs.rmSync(incoming, { force: true });
    }
  }
}

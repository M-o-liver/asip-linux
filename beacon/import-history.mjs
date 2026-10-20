import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { redactTrace } from "./trace.mjs";
import { projectKey } from "./project.mjs";

export function previousHistoryPath() {
  const home =
    process.env.ASIP_HOME ||
    (process.platform === "win32"
      ? path.join(
          process.env.LOCALAPPDATA ||
            path.join(os.homedir(), "AppData", "Local"),
          "ASIP",
        )
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support", "ASIP")
        : path.join(
            process.env.XDG_STATE_HOME ||
              path.join(os.homedir(), ".local", "state"),
            "asip",
            "memory",
          ));
  return path.join(home, "memory.sqlite3");
}

// An explicit import belongs to the currently signed-in account. The source
// is read-only and stays intact; all writes are one destination transaction.
export function importHistory(runtime, file, { checkpoint = () => {} } = {}) {
  if (!runtime.account) throw new Error("Sign in before importing history.");
  if (path.resolve(file) === path.resolve(runtime.databasePath()))
    throw new Error("Choose the previous ASIP workspace database.");
  const source = new DatabaseSync(file, { readOnly: true });
  let incoming;
  try {
    source.exec("BEGIN");
    if (
      Object.values(source.prepare("PRAGMA integrity_check").get())[0] !== "ok"
    )
      throw new Error("The previous ASIP database is damaged.");
    incoming = Object.fromEntries(
      ["projects", "roots", "sessions", "intents", "events", "links"].map(
        (table) => [table, source.prepare("SELECT * FROM " + table).all()],
      ),
    );
    // Verify the expected format even when the tables happen to be empty.
    source
      .prepare(
        "SELECT project_id,session_id,intent_id,previous_hash,hash FROM events LIMIT 0",
      )
      .all();
    source
      .prepare(
        "SELECT id,name,description,repository,created_at FROM projects LIMIT 0",
      )
      .all();
    source.exec("COMMIT");
  } catch (error) {
    throw new Error("Could not import this ASIP workspace: " + error.message);
  } finally {
    source.close();
  }
  const roots = new Map();
  for (const row of incoming.roots) {
    const paths = roots.get(row.project_id) || [];
    paths.push(row.path);
    roots.set(row.project_id, paths);
  }
  const projects = new Map(
    incoming.projects.map((row) => [
      row.id,
      projectKey(row.repository || roots.get(row.id)?.[0] || "asip3:" + row.id),
    ]),
  );
  const sessions = new Map(incoming.sessions.map((row) => [row.id, row]));
  const intents = new Map(incoming.intents.map((row) => [row.id, row]));
  const db = runtime.storage();
  const pending = incoming.events.filter(
    (row) =>
      !db.prepare("SELECT 1 FROM events WHERE id=?").get("asip3:" + row.id),
  );
  const missingProjects = incoming.projects.filter(
    (row) =>
      !db
        .prepare("SELECT 1 FROM projects WHERE id=?")
        .get(projects.get(row.id)),
  );
  if (!pending.length && !missingProjects.length)
    return { projects: 0, events: 0, alreadyImported: true };
  checkpoint();
  db.exec("BEGIN IMMEDIATE");
  try {
    const project = db.prepare(
      "INSERT OR IGNORE INTO projects VALUES(?,?,?,?,?,?)",
    );
    for (const row of incoming.projects)
      project.run(
        projects.get(row.id),
        row.name,
        row.description || "",
        row.repository || "",
        row.created_at,
        JSON.stringify(roots.get(row.id) || []),
      );
    const session = db.prepare(
      "INSERT OR IGNORE INTO session_details VALUES(?,?,?)",
    );
    for (const row of incoming.sessions)
      session.run(
        row.agent,
        "asip3:" + row.id,
        JSON.stringify(redactTrace(row)),
      );
    const event = db.prepare(
      "INSERT OR IGNORE INTO events VALUES(?,?,?,?,?,?,?,?)",
    );
    for (const row of pending) {
      const originalSession = sessions.get(row.session_id);
      event.run(
        "asip3:" + row.id,
        row.at,
        originalSession?.agent || "asip",
        "asip3:" + (row.session_id || "system"),
        row.kind,
        projects.get(row.project_id) || null,
        redactTrace(row.summary),
        JSON.stringify(
          redactTrace({
            ...JSON.parse(row.data),
            importedFrom: {
              format: "ASIP 3",
              path: path.resolve(file),
              id: row.id,
              previousHash: row.previous_hash,
              hash: row.hash,
              session: originalSession || null,
              intent: intents.get(row.intent_id) || null,
            },
          }),
        ),
      );
    }
    const link = db.prepare(
      "INSERT OR IGNORE INTO project_links VALUES(?,?,?)",
    );
    for (const row of incoming.links) {
      const a = projects.get(row.source),
        b = projects.get(row.target);
      if (a && b) link.run(a, b, row.relation);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  runtime.recordCount = db.prepare("SELECT count(*) AS n FROM events").get().n;
  return {
    projects: missingProjects.length,
    events: pending.length,
    alreadyImported: false,
  };
}

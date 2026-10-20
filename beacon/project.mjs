import path from "node:path";

// Windows applications report the same directory with different separators and
// casing. Repository identities and case-sensitive Unix paths stay unchanged.
export function projectKey(value) {
  if (
    typeof value !== "string" ||
    !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(value)
  )
    return value;
  const normalized = path.win32
    .normalize(value)
    .replaceAll("\\", "/")
    .toLowerCase();
  return normalized.length === 3 ? normalized : normalized.replace(/\/$/, "");
}

// Called inside the account's migration transaction. Event IDs and evidence are
// retained; only the project associations and catalogue keys are reconciled.
export function reconcileWindowsProjects(db) {
  for (const { project } of db
    .prepare("SELECT DISTINCT project FROM events WHERE project IS NOT NULL")
    .all()) {
    const key = projectKey(project);
    if (key !== project)
      db.prepare("UPDATE events SET project=? WHERE project=?").run(
        key,
        project,
      );
  }
  for (const row of db
    .prepare("SELECT * FROM projects ORDER BY created_at,id")
    .all()) {
    const key = projectKey(row.id);
    if (key === row.id) continue;
    const existing = db.prepare("SELECT * FROM projects WHERE id=?").get(key);
    if (existing) {
      const roots = [
        ...new Set([...JSON.parse(existing.roots), ...JSON.parse(row.roots)]),
      ];
      db.prepare(
        "UPDATE projects SET description=?,repository=?,roots=?,created_at=? WHERE id=?",
      ).run(
        [
          ...new Set([existing.description, row.description].filter(Boolean)),
        ].join("\n\n"),
        existing.repository || row.repository,
        JSON.stringify(roots),
        [existing.created_at, row.created_at].sort()[0],
        key,
      );
      db.prepare("DELETE FROM projects WHERE id=?").run(row.id);
    } else db.prepare("UPDATE projects SET id=? WHERE id=?").run(key, row.id);
  }
  const links = db.prepare("SELECT * FROM project_links").all();
  for (const row of links) {
    const source = projectKey(row.source),
      target = projectKey(row.target);
    if (source === row.source && target === row.target) continue;
    db.prepare(
      "DELETE FROM project_links WHERE source=? AND target=? AND relation=?",
    ).run(row.source, row.target, row.relation);
    if (source !== target)
      db.prepare("INSERT OR IGNORE INTO project_links VALUES(?,?,?)").run(
        source,
        target,
        row.relation,
      );
  }
}

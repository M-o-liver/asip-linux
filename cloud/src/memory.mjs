import { canonical, cloudEvent, sha256 } from "../../beacon/cloud-protocol.mjs";
import { fail, now } from "./http.mjs";
import { projectAllowed } from "./auth.mjs";

export async function ingest(env, auth, inputs) {
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > 40)
    fail(400, "Send 1–40 records.");
  const ids = inputs.map((e) => e?.id);
  const existingRows = (
    await env.DB.prepare(
      "SELECT id,sha256 FROM events WHERE account_id=? AND id IN (" +
        ids.map(() => "?").join(",") +
        ")",
    )
      .bind(
        auth.accountId,
        ...ids.map((id) => (typeof id === "string" ? id : "")),
      )
      .all()
  ).results;
  const existingHashes = new Map(existingRows.map((e) => [e.id, e.sha256]));
  const prepared = [];
  for (const input of inputs) {
    let event;
    try {
      event = cloudEvent(input);
    } catch (error) {
      fail(400, error.message);
    }
    projectAllowed(auth, event.project);
    if (auth.credential?.kind === "api" && event.agent !== auth.agent)
      fail(403, "Use the agent assigned to this connection.");
    const source = canonical(event),
      digest = await sha256(source);
    const existing = existingHashes.get(event.id);
    if (existing && existing !== digest)
      fail(
        409,
        "A record with this ID has different content. No records were changed.",
      );
    prepared.push({
      event,
      source,
      digest,
      key:
        auth.accountId +
        "/events/" +
        encodeURIComponent(event.id) +
        "/" +
        digest +
        ".json",
    });
  }
  // Private, content-addressed objects precede the atomic D1 commit. A failed
  // commit can leave an unreferenced object; it cannot expose a partial batch.
  await Promise.all(
    prepared.map((p) =>
      env.RECORDS.put(p.key, p.source, {
        httpMetadata: { contentType: "application/json" },
        customMetadata: { sha256: p.digest },
        onlyIf: { etagDoesNotMatch: "*" },
      }),
    ),
  );
  try {
    await env.DB.batch(
      prepared.map(({ event: e, digest, key }) =>
        env.DB.prepare(
          "INSERT OR IGNORE INTO events(account_id,id,at,agent,session,kind,project,summary,data,sha256,object_key,device_id,received_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).bind(
          auth.accountId,
          e.id,
          e.at,
          e.agent,
          e.session,
          e.kind,
          e.project,
          e.summary,
          JSON.stringify(e.data),
          digest,
          key,
          auth.credential?.id || "browser",
          now(),
        ),
      ),
    );
  } catch (error) {
    if (/event_conflict/.test(String(error)))
      fail(
        409,
        "A record with this ID has different content. No records were changed.",
      );
    throw error;
  }
  if (auth.credential)
    await env.DB.prepare(
      "UPDATE credentials SET last_seen=? WHERE id=? AND account_id=?",
    )
      .bind(now(), auth.credential.id, auth.accountId)
      .run();
  return {
    accepted: prepared.map((p) => ({ id: p.event.id, sha256: p.digest })),
  };
}
export function scope(auth, params) {
  const conditions = ["account_id=?"],
    values = [auth.accountId];
  const project = params.get("project");
  if (project) {
    projectAllowed(auth, project);
    conditions.push("project IS ?");
    values.push(project === "unassigned" ? null : project);
  } else if (auth.projects.length) {
    conditions.push(
      "project IN (" + auth.projects.map(() => "?").join(",") + ")",
    );
    values.push(...auth.projects);
  }
  return { where: conditions.join(" AND "), values };
}
export function decoded(row) {
  const { account_id, object_key, ...rest } = row;
  return { ...rest, data: JSON.parse(row.data) };
}
export async function listEvents(env, auth, params) {
  const { where, values } = scope(auth, params),
    conditions = [where];
  for (const k of ["session", "agent", "kind"])
    if (params.get(k)) {
      conditions.push(k + "=?");
      values.push(params.get(k).slice(0, 200));
    }
  const query = (params.get("query") || "").slice(0, 2000);
  const category = params.get("category");
  if (category === "intent")
    conditions.push("(kind='intent' OR kind LIKE 'intent.started%')");
  if (category === "results")
    conditions.push(
      "(kind IN ('result','evidence','Stop','api_result','tool_succeeded','intent.finished','verification.passed') AND trim(summary) NOT IN ('','Stop'))",
    );
  if (category === "failures")
    conditions.push(
      "(lower(kind) LIKE '%fail%' OR kind LIKE '%unresolved%' OR kind LIKE '%held%')",
    );
  if (category === "work")
    conditions.push(
      "(kind IN ('intent','result','evidence','failed','unresolved','api_failed','api_unresolved','StopFailure') OR kind LIKE 'intent.%' OR kind LIKE 'verification.%' OR (kind='Stop' AND trim(summary) NOT IN ('','Stop')))",
    );
  if (query) {
    conditions.push(
      "(instr(lower(summary),lower(?))>0 OR instr(lower(data),lower(?))>0)",
    );
    values.push(query, query);
  }
  const before = Number(params.get("before"));
  if (before) {
    conditions.push("seq<?");
    values.push(before);
  }
  const limit = Math.max(1, Math.min(100, Number(params.get("limit")) || 50));
  const { results } = await env.DB.prepare(
    "SELECT * FROM events WHERE " +
      conditions.join(" AND ") +
      " ORDER BY seq DESC LIMIT ?",
  )
    .bind(...values, limit + 1)
    .all();
  return {
    events: results.slice(0, limit).map(decoded),
    next: results.length > limit ? results[limit - 1].seq : null,
  };
}
export async function projects(env, auth) {
  const { where, values } = scope(auth, new URLSearchParams());
  const { results } = await env.DB.prepare(
    "SELECT project AS id,count(*) AS events,count(DISTINCT agent||char(0)||session) AS sessions,group_concat(DISTINCT agent) AS agents,MAX(at) AS lastActivity FROM events WHERE " +
      where +
      " AND project IS NOT NULL GROUP BY project ORDER BY MAX(at) DESC LIMIT 1000",
  )
    .bind(...values)
    .all();
  const catalogue = (
    await env.DB.prepare(
      "SELECT id,name,description,repository,roots FROM project_catalogue WHERE account_id=? ORDER BY device_id",
    )
      .bind(auth.accountId)
      .all()
  ).results;
  const map = new Map();
  for (const item of catalogue) {
    if (auth.projects.length && !auth.projects.includes(item.id)) continue;
    const prev = map.get(item.id);
    map.set(item.id, {
      ...item,
      roots: [...new Set([...(prev?.roots || []), ...JSON.parse(item.roots)])],
    });
  }
  for (const row of results)
    map.set(row.id, {
      ...map.get(row.id),
      ...row,
      name:
        map.get(row.id)?.name || row.id.split(/[\\/]/).filter(Boolean).at(-1),
      agents: row.agents?.split(",") || [],
    });
  return [...map.values()];
}
export async function pull(env, auth, params) {
  const cursor = Number(params.get("cursor") || 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0)
    fail(400, "Invalid synchronization cursor.");
  const { results } = await env.DB.prepare(
    "SELECT * FROM events WHERE account_id=? AND seq>? ORDER BY seq LIMIT 51",
  )
    .bind(auth.accountId, cursor)
    .all();
  const events = results.slice(0, 50).map(decoded);
  return {
    events,
    cursor: events.at(-1)?.seq || cursor,
    more: results.length > 50,
  };
}
export async function catalogue(env, auth, input) {
  if (auth.credential?.kind !== "device")
    fail(403, "A connected device is required.");
  const device = auth.credential.id,
    statements = [];
  for (const name of ["projects", "links", "connections", "sessions"])
    if (
      input[name] !== undefined &&
      (!Array.isArray(input[name]) || input[name].length > 1000)
    )
      fail(400, "Invalid catalogue.");
  const string = (v, max = 2000) => {
    if (typeof v !== "string" || v.length > max)
      fail(400, "Invalid catalogue field.");
    return v;
  };
  const total = ["projects", "links", "connections", "sessions"].reduce(
    (n, k) => n + (input[k]?.length || 0),
    0,
  );
  if (total > 30) fail(400, "Send at most 30 catalogue entries per request.");
  if (input.reset)
    statements.push(
      env.DB.prepare(
        "DELETE FROM project_catalogue WHERE account_id=? AND device_id=?",
      ).bind(auth.accountId, device),
    );
  for (const p of input.projects || []) {
    if (!Array.isArray(p.roots) || p.roots.length > 100)
      fail(400, "Invalid project roots.");
    statements.push(
      env.DB.prepare(
        "INSERT OR REPLACE INTO project_catalogue VALUES(?,?,?,?,?,?,?)",
      ).bind(
        auth.accountId,
        device,
        string(p.id),
        string(p.name || "", 200),
        string(p.description || "", 10000),
        string(p.repository || ""),
        JSON.stringify(p.roots.map((r) => string(r))),
      ),
    );
  }
  for (const l of input.links || [])
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO project_links VALUES(?,?,?,?)",
      ).bind(
        auth.accountId,
        string(l.source),
        string(l.target),
        string(l.relation, 100),
      ),
    );
  if (input.reset)
    statements.push(
      env.DB.prepare(
        "DELETE FROM connection_catalogue WHERE account_id=? AND device_id=?",
      ).bind(auth.accountId, device),
    );
  for (const c of input.connections || []) {
    if (!Array.isArray(c.projects) || c.projects.length > 100)
      fail(400, "Invalid connection projects.");
    // An allowlist of metadata fields: no credential, prefix, or request bodies.
    statements.push(
      env.DB.prepare(
        "INSERT OR REPLACE INTO connection_catalogue VALUES(?,?,?,?,?,?,?)",
      ).bind(
        auth.accountId,
        device,
        string(c.name, 80),
        string(c.provider, 80),
        string(c.label || "", 500),
        string(c.origin || "", 2000),
        JSON.stringify(c.projects.map((p) => string(p))),
      ),
    );
  }
  for (const s of input.sessions || []) {
    if (
      !s.details ||
      typeof s.details !== "object" ||
      JSON.stringify(s.details).length > 65536
    )
      fail(400, "Invalid session details.");
    statements.push(
      env.DB.prepare(
        "INSERT OR REPLACE INTO session_catalogue VALUES(?,?,?,?,?)",
      ).bind(
        auth.accountId,
        device,
        string(s.agent, 80),
        string(s.session, 200),
        JSON.stringify(s.details),
      ),
    );
  }
  // D1 permits at most 100 bound parameters in each statement. These inserts
  // stay below that bound; batch sizes are bounded independently.
  for (let i = 0; i < statements.length; i += 80)
    await env.DB.batch(statements.slice(i, i + 80));
  return { saved: true };
}
export async function readCatalogue(env, auth) {
  if (auth.credential?.kind !== "device")
    fail(403, "A connected device is required.");
  const links = (
    await env.DB.prepare(
      "SELECT source,target,relation FROM project_links WHERE account_id=? LIMIT 1000",
    )
      .bind(auth.accountId)
      .all()
  ).results;
  const sessions = (
    await env.DB.prepare(
      "SELECT agent,session,details FROM session_catalogue WHERE account_id=? ORDER BY device_id LIMIT 1000",
    )
      .bind(auth.accountId)
      .all()
  ).results.map((s) => ({ ...s, details: JSON.parse(s.details) }));
  return { projects: await projects(env, auth), links, sessions };
}

import { fail } from "./http.mjs";
import { projectAllowed } from "./auth.mjs";

const VERSION = 1;
const MAX_GROUPS = 50000;
const MAX_BYTES = 8 * 1024 * 1024;
const pending = new WeakMap();
const groupKey = (row) => JSON.stringify([row.project, row.agent, row.session]);

function unavailable() {
  fail(
    503,
    "Workspace counts are temporarily unavailable. Recorded history and device synchronization remain available.",
  );
}

async function readIndex(bucket, key, accountId) {
  const object = await bucket.get(key);
  if (!object) return { object: null, index: null };
  if (object.size > MAX_BYTES) unavailable();
  let index;
  try {
    index = await object.json();
  } catch {
    unavailable();
  }
  if (
    index?.version !== VERSION ||
    index.accountId !== accountId ||
    !Number.isSafeInteger(index.cursor) ||
    index.cursor < 0 ||
    !Number.isSafeInteger(index.updatedAt) ||
    !Array.isArray(index.rows) ||
    index.rows.length > MAX_GROUPS ||
    index.rows.some(
      (r) =>
        !(r.project === null || typeof r.project === "string") ||
        typeof r.agent !== "string" ||
        typeof r.session !== "string" ||
        !Number.isSafeInteger(r.events) ||
        r.events < 1 ||
        typeof r.startedAt !== "string" ||
        typeof r.lastActivity !== "string",
    )
  )
    unavailable();
  return { object, index };
}

async function updateIndex(env, accountId, clock) {
  const key = accountId + "/indexes/activity-v" + VERSION + ".json";
  let state = await readIndex(env.RECORDS, key, accountId);
  for (let attempt = 0; attempt < 3; attempt++) {
    const time = clock();
    const cursor = state.index?.cursor || 0;
    const head = await env.DB.prepare(
      "SELECT MAX(seq) AS cursor FROM events WHERE account_id=?",
    )
      .bind(accountId)
      .first();
    const high = head?.cursor || 0;
    if (high < cursor) unavailable();
    // This indexed MAX is a single-row check, even for an idle, long-lived
    // account. Fresh counts do not require a history scan or an idle R2 PUT.
    if (state.index && high === cursor) return state.index;
    const rows = new Map(
      (state.index?.rows || []).map((r) => [groupKey(r), { ...r }]),
    );
    if (high > cursor) {
      // The cursor index confines every subsequent scan to new immutable rows.
      // No event payload, transcript or evidence object is copied into this index.
      const delta = await env.DB.prepare(
        "SELECT project,agent,session,COUNT(*) AS events,MIN(at) AS startedAt,MAX(at) AS lastActivity FROM events INDEXED BY events_cursor WHERE account_id=? AND seq>? AND seq<=? GROUP BY project,agent,session",
      )
        .bind(accountId, cursor, high)
        .all();
      for (const row of delta.results) {
        const id = groupKey(row),
          old = rows.get(id);
        rows.set(
          id,
          old
            ? {
                ...row,
                events: old.events + row.events,
                startedAt:
                  old.startedAt < row.startedAt ? old.startedAt : row.startedAt,
                lastActivity:
                  old.lastActivity > row.lastActivity
                    ? old.lastActivity
                    : row.lastActivity,
              }
            : row,
        );
      }
    }
    if (rows.size > MAX_GROUPS) unavailable();
    const index = {
      version: VERSION,
      accountId,
      cursor: high,
      updatedAt: time,
      rows: [...rows.values()],
    };
    const encoded = JSON.stringify(index);
    if (new TextEncoder().encode(encoded).length > MAX_BYTES) unavailable();
    const saved = await env.RECORDS.put(key, encoded, {
      onlyIf: state.object
        ? { etagMatches: state.object.etag }
        : { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json" },
    });
    if (saved) return index;
    // Another isolate won. Reload its checkpoint rather than overwriting it or
    // counting our delta twice. A crash before this PUT simply replays the tail.
    state = await readIndex(env.RECORDS, key, accountId);
  }
  unavailable();
}

export async function activityIndex(env, accountId, { clock = Date.now } = {}) {
  // Coalesce project/session/relationship loads in the same Worker. R2 provides
  // the durable checkpoint across cold starts and compare-and-swap across edges.
  let accounts = pending.get(env.RECORDS);
  if (!accounts) pending.set(env.RECORDS, (accounts = new Map()));
  if (accounts.has(accountId)) return accounts.get(accountId);
  const promise = updateIndex(env, accountId, clock);
  accounts.set(accountId, promise);
  try {
    return await promise;
  } finally {
    accounts.delete(accountId);
  }
}

export function scopedActivity(index, auth, params = new URLSearchParams()) {
  const selected = params.get("project");
  if (selected) projectAllowed(auth, selected);
  const project = selected === "unassigned" ? null : selected;
  return index.rows.filter(
    (r) =>
      (!selected || r.project === project) &&
      (!auth.projects.length || auth.projects.includes(r.project)),
  );
}

export function activityProjects(rows) {
  const projects = new Map();
  for (const row of rows) {
    if (row.project === null) continue;
    const item = projects.get(row.project) || {
      id: row.project,
      events: 0,
      sessions: 0,
      agents: new Set(),
      lastActivity: "",
    };
    item.events += row.events;
    item.sessions++;
    item.agents.add(row.agent);
    if (row.lastActivity > item.lastActivity)
      item.lastActivity = row.lastActivity;
    projects.set(row.project, item);
  }
  return [...projects.values()]
    .map((p) => ({ ...p, agents: [...p.agents] }))
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
    .slice(0, 1000);
}

export function activitySessions(rows) {
  const sessions = new Map();
  for (const row of rows) {
    const id = JSON.stringify([row.agent, row.session]),
      old = sessions.get(id);
    sessions.set(
      id,
      old
        ? {
            ...old,
            events: old.events + row.events,
            startedAt:
              old.startedAt < row.startedAt ? old.startedAt : row.startedAt,
            lastActivity:
              old.lastActivity > row.lastActivity
                ? old.lastActivity
                : row.lastActivity,
          }
        : {
            agent: row.agent,
            session: row.session,
            events: row.events,
            startedAt: row.startedAt,
            lastActivity: row.lastActivity,
          },
    );
  }
  return [...sessions.values()]
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))
    .slice(0, 100);
}

export function activityRelationships(rows) {
  const memberships = new Map(),
    pairs = new Map();
  for (const row of rows) {
    if (row.project === null) continue;
    const id = JSON.stringify([row.agent, row.session]);
    if (!memberships.has(id)) memberships.set(id, new Set());
    memberships.get(id).add(row.project);
  }
  const compare = (a, b) =>
    a.source < b.source
      ? -1
      : a.source > b.source
        ? 1
        : a.target < b.target
          ? -1
          : a.target > b.target
            ? 1
            : 0;
  let largest;
  for (const membership of memberships.values()) {
    const projects = [...membership].sort();
    let candidates = 0;
    for (let a = 0; a < projects.length && candidates < 100; a++)
      for (
        let b = a + 1;
        b < projects.length && candidates < 100;
        b++, candidates++
      ) {
        const id = JSON.stringify([projects[a], projects[b]]);
        const present = pairs.has(id);
        const pair = pairs.get(id) || {
          source: projects[a],
          target: projects[b],
          sessions: 0,
        };
        if (!present && pairs.size === 100 && compare(pair, largest) > 0)
          continue;
        pair.sessions++;
        pairs.set(id, pair);
        if (pairs.size > 100) {
          pairs.delete(JSON.stringify([largest.source, largest.target]));
          largest = [...pairs.values()].sort(compare).at(-1);
        } else if (!largest || compare(pair, largest) > 0) {
          largest = pair;
        }
      }
  }
  // Only the first 100 ordered pairs of a session can enter the global first
  // 100. Keep counts for those pairs without an unbounded quadratic expansion.
  return [...pairs.values()].sort(compare);
}

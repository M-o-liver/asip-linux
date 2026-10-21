// Shared by Beacon and the Worker. Hashes cover exactly these versioned fields.
export function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export async function sha256(value) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
}
export function cloudEvent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid event.");
  const e = Object.fromEntries(
    ["id", "at", "agent", "session", "kind", "project", "summary", "data"].map(
      (k) => [k, input[k]],
    ),
  );
  for (const [key, max] of Object.entries({
    id: 200,
    at: 40,
    agent: 80,
    session: 200,
    kind: 100,
    summary: 2000,
  }))
    if (
      typeof e[key] !== "string" ||
      (!e[key] && key !== "summary") ||
      e[key].length > max ||
      e[key].includes("\0")
    )
      throw new Error("Invalid event " + key + ".");
  if (!/^\d{4}-\d\d-\d\dT/.test(e.at) || !Number.isFinite(Date.parse(e.at)))
    throw new Error("Invalid event time.");
  e.project ??= null;
  if (
    e.project !== null &&
    (typeof e.project !== "string" || !e.project || e.project.length > 2000)
  )
    throw new Error("Invalid project.");
  if (!e.data || typeof e.data !== "object" || Array.isArray(e.data))
    throw new Error("Invalid event evidence.");
  if (new TextEncoder().encode(JSON.stringify(e.data)).length > 65536)
    throw new Error("Event evidence is too large.");
  return e;
}

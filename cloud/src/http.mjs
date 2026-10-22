export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export function fail(status, message) {
  throw new HttpError(status, message);
}
export const now = () => new Date().toISOString();
export const expires = (seconds) =>
  new Date(Date.now() + seconds * 1000).toISOString();
export function random(bytes = 32) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}
export async function body(request, max = 524288) {
  if (
    !/^application\/json(?:;|$)/i.test(
      request.headers.get("content-type") || "",
    )
  )
    fail(415, "Send JSON.");
  let raw = "",
    length = 0;
  if (!request.body) fail(400, "Send a request body.");
  const reader = request.body.getReader(),
    decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > max) {
        await reader.cancel();
        fail(413, "Request is too large.");
      }
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
    try {
      return JSON.parse(raw);
    } catch {
      fail(400, "Invalid JSON.");
    }
  } finally {
    reader.releaseLock();
  }
}
export function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}
export function secure(response) {
  const h = new Headers(response.headers);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  h.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  if (
    !/\/(?:assets)\//.test(new URL(response.url || "https://asip.ca/").pathname)
  )
    h.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, headers: h });
}
export function browserMutation(request, env) {
  if (
    request.headers.get("origin") !== env.ORIGIN ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    fail(403, "Use your ASIP workspace.");
}
export async function throttle(env, key, limit = 120) {
  // Admission must not consume D1 writes: doing so makes even reads fail when
  // the account reaches its daily write allowance. Workers supplies a bounded,
  // per-location limiter independently of the database.
  const binding =
    limit <= 30
      ? env.PAIR_LIMIT
      : limit <= 120
        ? env.API_LIMIT
        : env.SYNC_LIMIT;
  if (!binding) throw new Error("ASIP rate limiter is not configured.");
  if (!(await binding.limit({ key })).success)
    fail(429, "Too many requests. Try again in a minute.");
}

export function serviceError(error) {
  if (error instanceof HttpError)
    return json({ error: error.message }, error.status);
  const message = String(error);
  if (
    /exceeded.*(?:daily|free tier).*?(?:row|read|write)|daily.*(?:read|write).*limit/i.test(
      message,
    )
  ) {
    const reset = new Date();
    reset.setUTCHours(24, 1, 0, 0);
    const retryAfter = Math.max(
      60,
      Math.ceil((reset.getTime() - Date.now()) / 1000),
    );
    return json(
      {
        error:
          "Cloudflare's daily database allowance is exhausted. Beacon keeps recording locally and will retry after the UTC daily reset.",
        code: "CLOUD_DAILY_QUOTA",
        retryAfter,
      },
      503,
      { "Retry-After": String(retryAfter) },
    );
  }
  if (/database.*(?:full|storage limit)|SQLITE_FULL/i.test(message))
    return json(
      {
        error:
          "ASIP cloud storage needs administrator attention. Local recording continues.",
        code: "CLOUD_STORAGE_FULL",
        retryAfter: 3600,
      },
      507,
      { "Retry-After": "3600" },
    );
  return json({ error: "ASIP could not complete this request." }, 500);
}

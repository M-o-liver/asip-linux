import { sha256 } from "../../beacon/cloud-protocol.mjs";
import { sealDeviceReply } from "../../beacon/device-link.mjs";
import {
  HttpError,
  fail,
  body,
  json,
  secure,
  browserMutation,
  random,
  expires,
  now,
  throttle,
  serviceError,
} from "./http.mjs";
import {
  signinClaims,
  accountForIdentity,
  browserAccount,
  sessionFor,
  cookie,
  authenticate,
  owner,
  projectAllowed,
  issueCredential,
} from "./auth.mjs";
import {
  ingest,
  listEvents,
  projects,
  pull,
  catalogue,
  readCatalogue,
} from "./memory.mjs";
import { oauth } from "./oauth.mjs";
import {
  activityIndex,
  scopedActivity,
  activitySessions,
  activityRelationships,
} from "./activity.mjs";

async function deviceRoutes(request, env, url, auth) {
  if (
    url.pathname === "/api/v1/devices/self/revoke" &&
    request.method === "POST"
  ) {
    if (auth.credential?.kind !== "device")
      fail(403, "A connected device is required.");
    await env.DB.prepare(
      "UPDATE credentials SET revoked_at=? WHERE account_id=? AND id=?",
    )
      .bind(now(), auth.accountId, auth.credential.id)
      .run();
    return json({ revoked: true });
  }
  if (
    url.pathname === "/api/v1/devices/authorize" &&
    request.method === "POST"
  ) {
    owner(auth);
    const input = await body(request, 8192);
    if (
      !/^[a-f0-9]{64}$/.test(input.challenge || "") ||
      !/^[a-f0-9]{64}$/.test(input.state || "") ||
      !/^04[a-f0-9]{128}$/.test(input.publicKey || "")
    )
      fail(400, "Invalid device connection.");
    let redirect;
    try {
      redirect = new URL(input.redirect);
    } catch {
      fail(400, "Invalid device callback.");
    }
    if (
      redirect.protocol !== "http:" ||
      redirect.hostname !== "127.0.0.1" ||
      !redirect.port ||
      redirect.pathname !== "/callback" ||
      redirect.search ||
      redirect.hash ||
      redirect.username ||
      redirect.password
    )
      fail(400, "Use a Beacon loopback callback.");
    const label = String(input.label || "Computer").slice(0, 120),
      platform = String(input.platform || "unknown").slice(0, 50);
    const code = random();
    let reply;
    try {
      reply = await sealDeviceReply(
        {
          code,
          state: input.state,
          access: request.headers.get("Cf-Access-Jwt-Assertion") || "",
        },
        input.publicKey,
        input.challenge,
        input.state,
      );
    } catch {
      fail(400, "Invalid device public key.");
    }
    await env.DB.prepare("INSERT INTO device_codes VALUES(?,?,?,?,?,?)")
      .bind(
        await sha256(code),
        auth.accountId,
        input.challenge,
        label,
        platform,
        expires(120),
      )
      .run();
    redirect.searchParams.set("response", reply);
    return json({ redirect: redirect.href });
  }
  if (url.pathname === "/api/v1/devices" && request.method === "GET") {
    owner(auth);
    return json({
      devices: (
        await env.DB.prepare(
          "SELECT id,label,agent,created_at,expires_at,revoked_at,last_seen FROM credentials WHERE account_id=? AND kind='device' ORDER BY created_at DESC",
        )
          .bind(auth.accountId)
          .all()
      ).results,
    });
  }
  return null;
}
async function api(request, env, url) {
  if (url.pathname === "/api/v1/devices/redeem" && request.method === "POST") {
    const input = await body(request, 8192);
    if (
      !/^[a-f0-9]{64}$/.test(input.code || "") ||
      !/^[a-f0-9]{64}$/.test(input.verifier || "")
    )
      fail(400, "Invalid device proof.");
    await throttle(
      env,
      "pair:" +
        (await sha256(request.headers.get("CF-Connecting-IP") || "unknown")),
      30,
    );
    // Atomic consumption prevents two helpers from redeeming the same code.
    const pending = await env.DB.prepare(
      "DELETE FROM device_codes WHERE hash=? AND challenge=? AND expires_at>? RETURNING *",
    )
      .bind(await sha256(input.code), await sha256(input.verifier), now())
      .first();
    if (!pending)
      fail(401, "Device connection expired. Start again in Beacon.");
    const credential = await issueCredential(env, pending.account_id, {
      kind: "device",
      label: pending.label + " · " + pending.platform,
      agent: "beacon",
      scopes: ["memory:read", "memory:write", "sync:write"],
    });
    const account = await env.DB.prepare("SELECT * FROM accounts WHERE id=?")
      .bind(pending.account_id)
      .first();
    return json({ ...credential, account });
  }
  const permission = url.pathname.startsWith("/api/v1/sync")
    ? "sync:write"
    : request.method === "POST" && url.pathname === "/api/v1/events"
      ? "memory:write"
      : "memory:read";
  const auth = await authenticate(request, env, permission);
  if (url.pathname.startsWith("/api/v1/devices")) {
    const response = await deviceRoutes(request, env, url, auth);
    if (response) return response;
  }
  if (url.pathname === "/api/v1/me" && request.method === "GET") {
    return json({
      account: { id: auth.accountId, handle: auth.handle, name: auth.name },
      workspace: "/users/" + auth.handle,
      providers: {
        google: Boolean(
          env.GOOGLE_WEB_CLIENT_ID && env.GOOGLE_WEB_CLIENT_SECRET,
        ),
        github: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
      },
    });
  }
  if (
    url.pathname === "/api/v1/preview-authorization" &&
    request.method === "POST"
  ) {
    owner(auth);
    return json({
      cookie: request.headers.get("Cf-Access-Jwt-Assertion")
        ? "CF_Authorization=" + request.headers.get("Cf-Access-Jwt-Assertion")
        : null,
    });
  }
  if (url.pathname === "/api/v1/account" && request.method === "PATCH") {
    owner(auth);
    const input = await body(request, 2048);
    if (!/^[a-z0-9][a-z0-9_-]{2,39}$/.test(input.handle || ""))
      fail(
        400,
        "Choose 3–40 lowercase letters, numbers, underscores or dashes.",
      );
    if (
      [
        "admin",
        "api",
        "auth",
        "users",
        "connect",
        "download",
        "asip",
        "support",
      ].includes(input.handle)
    )
      fail(400, "Choose another handle.");
    try {
      await env.DB.prepare("UPDATE accounts SET handle=?,name=? WHERE id=?")
        .bind(
          input.handle,
          String(input.name || auth.name).slice(0, 200),
          auth.accountId,
        )
        .run();
    } catch {
      fail(409, "That handle is already in use.");
    }
    return json({ handle: input.handle, workspace: "/users/" + input.handle });
  }
  if (url.pathname === "/api/v1/projects" && request.method === "GET")
    return json({ projects: await projects(env, auth) });
  if (url.pathname === "/api/v1/events" && request.method === "GET")
    return json(await listEvents(env, auth, url.searchParams));
  if (url.pathname === "/api/v1/events" && request.method === "POST") {
    const input = await body(request);
    return json(await ingest(env, auth, input.events));
  }
  if (url.pathname === "/api/v1/sync/push" && request.method === "POST") {
    if (auth.credential?.kind !== "device")
      fail(403, "Connect this computer in Beacon.");
    return json(await ingest(env, auth, (await body(request)).events));
  }
  if (url.pathname === "/api/v1/sync/pull" && request.method === "GET") {
    if (auth.credential?.kind !== "device")
      fail(403, "Connect this computer in Beacon.");
    return json(await pull(env, auth, url.searchParams));
  }
  if (url.pathname === "/api/v1/sync/catalogue" && request.method === "POST")
    return json(await catalogue(env, auth, await body(request)));
  if (url.pathname === "/api/v1/sync/catalogue" && request.method === "GET")
    return json(await readCatalogue(env, auth));
  if (url.pathname === "/api/v1/sessions" && request.method === "GET") {
    const index = await activityIndex(env, auth.accountId);
    return json({
      sessions: activitySessions(scopedActivity(index, auth, url.searchParams)),
      indexedAt: new Date(index.updatedAt).toISOString(),
    });
  }
  if (url.pathname === "/api/v1/relationships" && request.method === "GET") {
    const index = await activityIndex(env, auth.accountId);
    const relationships = activityRelationships(scopedActivity(index, auth));
    const links = (
      await env.DB.prepare(
        "SELECT source,target,relation FROM project_links WHERE account_id=?",
      )
        .bind(auth.accountId)
        .all()
    ).results.filter(
      (l) =>
        !auth.projects.length ||
        (auth.projects.includes(l.source) && auth.projects.includes(l.target)),
    );
    return json({
      relationships: [...relationships, ...links],
      indexedAt: new Date(index.updatedAt).toISOString(),
    });
  }
  if (url.pathname === "/api/v1/connections" && request.method === "GET") {
    const connections = (
      await env.DB.prepare(
        "SELECT c.name,c.provider,c.label,c.origin,c.projects,c.device_id,d.label AS device FROM connection_catalogue c JOIN credentials d ON d.id=c.device_id AND d.account_id=c.account_id WHERE c.account_id=? AND d.revoked_at IS NULL",
      )
        .bind(auth.accountId)
        .all()
    ).results
      .map((c) => ({ ...c, projects: JSON.parse(c.projects) }))
      .filter(
        (c) =>
          !auth.projects.length ||
          !c.projects.length ||
          c.projects.some((p) => auth.projects.includes(p)),
      );
    return json({
      connections,
      credentials:
        "API credentials stay in the owning device’s OS keychain. Use that Beacon for provider requests.",
    });
  }
  if (url.pathname === "/api/v1/tokens") {
    owner(auth);
    if (request.method === "GET")
      return json({
        tokens: (
          await env.DB.prepare(
            "SELECT id,label,agent,scopes,projects,created_at,expires_at,revoked_at FROM credentials WHERE account_id=? AND kind='api' ORDER BY created_at DESC",
          )
            .bind(auth.accountId)
            .all()
        ).results,
      });
    if (request.method === "POST") {
      const input = await body(request, 8192);
      if (
        !["codex", "claude-code", "antigravity", "http"].includes(
          input.agent,
        ) ||
        typeof input.label !== "string" ||
        !input.label.trim()
      )
        fail(400, "Name the connection and choose its agent.");
      if (
        !Array.isArray(input.projects) ||
        input.projects.length > 50 ||
        input.projects.some(
          (p) => typeof p !== "string" || !p || p.length > 2000,
        )
      )
        fail(400, "Choose valid projects.");
      return json(
        await issueCredential(env, auth.accountId, {
          kind: "api",
          label: input.label,
          agent: input.agent,
          projects: input.projects,
          scopes: input.write
            ? ["memory:read", "memory:write"]
            : ["memory:read"],
        }),
        201,
      );
    }
  }
  const revoke = /^\/api\/v1\/(devices|tokens)\/([a-f0-9-]{36})$/.exec(
    url.pathname,
  );
  if (revoke && request.method === "DELETE") {
    owner(auth);
    await env.DB.prepare(
      "UPDATE credentials SET revoked_at=? WHERE account_id=? AND id=? AND kind=?",
    )
      .bind(
        now(),
        auth.accountId,
        revoke[2],
        revoke[1] === "devices" ? "device" : "api",
      )
      .run();
    return json({ revoked: true });
  }
  const evidence = /^\/api\/v1\/events\/([^/]+)\/source$/.exec(url.pathname);
  if (evidence && request.method === "GET") {
    const row = await env.DB.prepare(
      "SELECT * FROM events WHERE account_id=? AND id=?",
    )
      .bind(auth.accountId, decodeURIComponent(evidence[1]))
      .first();
    if (!row) fail(404, "Record not found.");
    projectAllowed(auth, row.project);
    const object = await env.RECORDS.get(row.object_key);
    if (!object) fail(503, "The source record is temporarily unavailable.");
    const source = await object.text();
    if ((await sha256(source)) !== row.sha256)
      fail(503, "The source record did not pass its integrity check.");
    return new Response(source, {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": 'attachment; filename="asip-record.json"',
        "X-ASIP-SHA256": row.sha256,
      },
    });
  }
  fail(404, "Endpoint not found.");
}
const toolSchemas = {
  asip_status: {
    description: "Show the authenticated cloud account.",
    properties: {},
  },
  asip_projects: { description: "List your cloud projects.", properties: {} },
  asip_connections: {
    description:
      "List named API metadata. Credentials remain on connected computers.",
    properties: {},
  },
  asip_recall: {
    description:
      "Retrieve project work, intent, results and evidence across devices.",
    properties: { project: { type: "string" }, query: { type: "string" } },
  },
  asip_record: {
    description: "Append a record with its native session and project.",
    properties: {
      project: { type: "string" },
      session: { type: "string" },
      kind: { type: "string" },
      summary: { type: "string" },
      data: { type: "object" },
    },
    required: ["session", "kind", "summary"],
  },
};
async function mcp(request, env) {
  const auth = await authenticate(request, env),
    input = await body(request, 131072);
  if (input.jsonrpc !== "2.0" || Array.isArray(input))
    fail(400, "Send one JSON-RPC 2.0 message.");
  if (input.id === undefined) return new Response(null, { status: 202 });
  const reply = (result) => json({ jsonrpc: "2.0", id: input.id, result });
  if (input.method === "initialize")
    return reply({
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "asip-cloud", version: "0.5.0" },
    });
  if (input.method === "ping") return reply({});
  if (input.method === "tools/list")
    return reply({
      tools: Object.entries(toolSchemas)
        .filter(
          ([name]) =>
            name !== "asip_record" || auth.scopes.includes("memory:write"),
        )
        .map(([name, v]) => ({
          name,
          description: v.description,
          inputSchema: {
            type: "object",
            properties: v.properties,
            required: v.required || [],
            additionalProperties: false,
          },
        })),
    });
  if (input.method !== "tools/call")
    return json({
      jsonrpc: "2.0",
      id: input.id,
      error: { code: -32601, message: "Method not found" },
    });
  try {
    const args = input.params?.arguments || {};
    let value;
    switch (input.params?.name) {
      case "asip_status":
        value = {
          connected: true,
          cloud: true,
          account: auth.handle,
          agent: auth.agent || "browser",
        };
        break;
      case "asip_projects":
        value = { projects: await projects(env, auth) };
        break;
      case "asip_recall":
        value = await listEvents(
          env,
          auth,
          new URLSearchParams(
            Object.entries(args).filter(([k]) =>
              ["project", "query"].includes(k),
            ),
          ),
        );
        break;
      case "asip_connections":
        return api(
          new Request(env.ORIGIN + "/api/v1/connections", {
            headers: request.headers,
          }),
          env,
          new URL(env.ORIGIN + "/api/v1/connections"),
        ).then(async (r) =>
          reply({ content: [{ type: "text", text: await r.text() }] }),
        );
      case "asip_record":
        if (!auth.scopes.includes("memory:write"))
          fail(403, "This connection is read only.");
        value = await ingest(env, auth, [
          {
            id: crypto.randomUUID(),
            at: now(),
            agent: auth.agent || "http",
            session: args.session,
            project: args.project || null,
            kind: args.kind,
            summary: args.summary,
            data: args.data || {},
          },
        ]);
        break;
      default:
        fail(404, "Tool not found.");
    }
    return reply({ content: [{ type: "text", text: JSON.stringify(value) }] });
  } catch (error) {
    return reply({
      isError: true,
      content: [
        {
          type: "text",
          text:
            error instanceof HttpError
              ? error.message
              : "ASIP could not complete this request.",
        },
      ],
    });
  }
}
async function handle(request, env) {
  const url = new URL(request.url);
  if (url.origin !== env.ORIGIN) fail(404, "Use asip.ca.");
  if (url.pathname === "/health")
    return json({ service: "asip-cloud", schema: 1 });
  if (url.pathname === "/auth/access") {
    const claims = await signinClaims(request, env);
    const account = await accountForIdentity(
      env,
      "cloudflare-access",
      claims.iss + ":" + claims.sub,
      { email: claims.email, name: claims.email.split("@")[0] },
    );
    const next = url.searchParams.get("return");
    return new Response(null, {
      status: 303,
      headers: {
        Location:
          next?.startsWith("/connect?") && next.length < 8192
            ? next
            : "/users/" + account.handle,
        "Set-Cookie": await sessionFor(env, account),
      },
    });
  }
  if (/^\/auth\/(google|github)(?:\/callback)?$/.test(url.pathname))
    return oauth(request, env, url);
  if (url.pathname === "/auth/logout" && request.method === "POST") {
    browserMutation(request, env);
    await env.DB.prepare("DELETE FROM browser_sessions WHERE hash=?")
      .bind(await sha256(cookie(request, "__Host-asip")))
      .run();
    return json({ signedOut: true }, 200, {
      "Set-Cookie":
        "__Host-asip=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
    });
  }
  if (url.pathname.startsWith("/api/v1/")) return api(request, env, url);
  if (url.pathname === "/mcp" && request.method === "POST")
    return mcp(request, env);
  if (url.pathname === "/mcp")
    return json(
      { error: "Use POST for the stateless ASIP MCP endpoint." },
      405,
      { Allow: "POST" },
    );
  if (!["GET", "HEAD"].includes(request.method))
    fail(405, "Method not allowed.");
  const asset = new URL(request.url);
  if (/^\/users\/[^/]+$/.test(url.pathname)) {
    const account = await browserAccount(request, env);
    if (!account)
      return new Response(null, {
        status: 303,
        headers: { Location: "/auth/access" },
      });
    if (url.pathname !== "/users/" + account.handle)
      fail(404, "Workspace not found.");
    asset.pathname = "/workspace.html";
  } else if (url.pathname === "/connect") asset.pathname = "/connect.html";
  else if (url.pathname === "/download") asset.pathname = "/download.html";
  else if (url.pathname === "/api") asset.pathname = "/api.html";
  return env.ASSETS.fetch(
    new Request(asset, { method: request.method, headers: request.headers }),
  );
}
export default {
  async fetch(request, env) {
    try {
      return secure(await handle(request, env));
    } catch (error) {
      return secure(serviceError(error));
    }
  },
};

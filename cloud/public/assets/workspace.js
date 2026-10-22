import { checkConnection } from "./api-check.js";
import { queryCache } from "./query-cache.js";

const aggregates = queryCache();

const $ = (id) => document.getElementById(id),
  names = {
    codex: "Codex",
    "claude-code": "Claude Code",
    antigravity: "Antigravity",
    beacon: "Beacon",
  };
let account,
  project = "",
  session = "",
  agentSession = "",
  cursor = null,
  pages = [null],
  page = 0,
  lastEvents = [],
  projectList = [],
  generation = 0,
  issuedProjects = [];
const node = (tag, text, className) => {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
};
const date = (v) =>
  v
    ? new Date(v).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "Never";
async function api(path, options) {
  const r = await fetch("/api/v1/" + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  const d = await r.json();
  if (r.status === 401) {
    location.href = "/auth/access";
    throw Error("Sign in to ASIP.");
  }
  if (!r.ok) throw Error(d.error || "ASIP could not complete this request.");
  return d;
}
function report(e) {
  $("error").textContent = e.message;
}
function view(name) {
  document.querySelectorAll("[data-panel]").forEach((p) => {
    p.hidden = p.dataset.panel !== name;
  });
  document
    .querySelectorAll("[data-view]")
    .forEach((b) => b.classList.toggle("selected", b.dataset.view === name));
  $("breadcrumb").textContent =
    "Your workspace / " +
    {
      history: "Project memory",
      devices: "Computers & agents",
      connections: "API connections",
      settings: "Account & API access",
    }[name];
  document.body.classList.remove("menu-open");
  if (name === "devices") loadDevices().catch(report);
  if (name === "connections") loadConnections().catch(report);
  if (name === "settings") loadTokens().catch(report);
}
document
  .querySelectorAll("[data-view]")
  .forEach((b) => (b.onclick = () => view(b.dataset.view)));
$("menu").onclick = () => document.body.classList.toggle("menu-open");
function selectProject(id) {
  project = id;
  session = "";
  agentSession = "";
  pages = [null];
  page = 0;
  view("history");
  $("title").textContent = id
    ? projectList.find((p) => p.id === id)?.name || id.split("/").at(-1)
    : "All project memory";
  $("project-description").textContent = id
    ? projectList.find((p) => p.id === id)?.description || id
    : "The intent, the work, and the evidence. Together.";
  $("all-projects").classList.toggle("selected", !id);
  document
    .querySelectorAll("[data-project]")
    .forEach((b) => b.classList.toggle("selected", b.dataset.project === id));
  loadHistory().catch(report);
}
$("all-projects").onclick = () => selectProject("");
async function loadProjects() {
  const result = await api("projects");
  projectList = result.projects;
  $("projects").replaceChildren();
  $("token-projects").replaceChildren();
  $("project-count").textContent = projectList.length;
  for (const p of projectList) {
    const b = node("button", undefined, "project-button");
    b.dataset.project = p.id;
    b.title = p.id;
    b.append(node("span", p.name || p.id), node("span", p.events || 0));
    b.onclick = () => selectProject(p.id);
    $("projects").append(b);
    const option = node("option", p.name || p.id);
    option.value = p.id;
    $("token-projects").append(option);
  }
}
function inspect(e) {
  document
    .querySelectorAll("[data-event]")
    .forEach((b) => b.classList.toggle("selected", b.dataset.event === e.id));
  $("evidence-empty").hidden = true;
  $("evidence").hidden = false;
  $("evidence-title").textContent = e.summary;
  $("facts").replaceChildren();
  const facts = {
    Agent: names[e.agent] || e.agent,
    Session: e.session,
    Project: e.project || "Unassigned",
    Recorded: date(e.at),
    Computer: e.device_id,
    Record: e.id,
    "SHA-256": e.sha256,
  };
  for (const [label, value] of Object.entries(facts)) {
    $("facts").append(node("dt", label), node("dd", value));
  }
  $("record-data").textContent = JSON.stringify(e.data, null, 2);
  $("source-download").href =
    "/api/v1/events/" + encodeURIComponent(e.id) + "/source";
}
async function loadHistory() {
  const current = ++generation;
  $("error").textContent = "";
  const params = new URLSearchParams({
    limit: "30",
    category: $("kind").value,
    query: $("query").value,
    agent: $("agent").value,
  });
  if (project) params.set("project", project);
  if (pages[page]) params.set("before", pages[page]);
  if (session) {
    params.set("session", session);
    params.set("agent", agentSession);
  }
  const scope = new URLSearchParams();
  if (project) scope.set("project", project);
  const [history, sessions, relations] = await Promise.all([
    api("events?" + params),
    aggregates.get("sessions?" + scope, () => api("sessions?" + scope)),
    aggregates.get("relationships", () => api("relationships")),
  ]);
  if (current !== generation) return;
  lastEvents = history.events;
  cursor = history.next;
  $("events").replaceChildren();
  $("evidence").hidden = true;
  $("evidence-empty").hidden = false;
  $("empty").hidden = Boolean(lastEvents.length);
  $("empty-onboarding").hidden = Boolean(
    projectList.length ||
    lastEvents.length ||
    $("query").value ||
    project ||
    session,
  );
  $("record-count").textContent = project
    ? (
        projectList.find((p) => p.id === project)?.events || 0
      ).toLocaleString() + " records"
    : projectList.reduce((n, p) => n + (p.events || 0), 0).toLocaleString() +
      " project records";
  for (const e of lastEvents) {
    const b = node("button", undefined, "event-row");
    b.dataset.event = e.id;
    const failure = /fail|unresolved|held|Failure/i.test(e.kind);
    const marker = node(
      "span",
      failure ? "!" : /intent/.test(e.kind) ? "↗" : "✓",
      "event-marker" + (failure ? " failure" : ""),
    );
    const content = node("div");
    const type = node("div", undefined, "event-type");
    type.append(
      node("span", e.kind.replaceAll("_", " ")),
      node("span", date(e.at)),
    );
    const meta = node("div", undefined, "event-meta");
    meta.append(
      node("span", names[e.agent] || e.agent, "agent-tag"),
      node("span", "/ " + (e.project?.split("/").at(-1) || "Unassigned")),
      node("span", "/ " + e.session.slice(0, 12)),
    );
    content.append(type, node("h3", e.summary), meta);
    b.append(marker, content);
    b.onclick = () => inspect(e);
    $("events").append(b);
  }
  if (lastEvents.length) inspect(lastEvents[0]);
  $("next").disabled = !cursor;
  $("previous").disabled = page === 0;
  $("page").textContent = "Page " + (page + 1);
  $("session-filter").hidden = !session;
  $("session-label").textContent =
    (names[agentSession] || agentSession) + " / " + session;
  $("sessions").replaceChildren();
  $("session-count").textContent = sessions.sessions.length;
  for (const s of sessions.sessions) {
    const b = node("button", undefined, "session-row"),
      info = node("div");
    info.append(
      node("strong", names[s.agent] || s.agent),
      node("small", s.session.slice(0, 26)),
      node("small", date(s.lastActivity)),
    );
    b.append(info, node("span", s.events + " records"));
    b.onclick = () => {
      session = s.session;
      agentSession = s.agent;
      pages = [null];
      page = 0;
      loadHistory().catch(report);
    };
    $("sessions").append(b);
  }
  if (!sessions.sessions.length)
    $("sessions").append(
      node("p", "Your recorded sessions appear here.", "muted"),
    );
  $("relationships").replaceChildren();
  for (const r of relations.relationships.filter(
    (r) => !project || r.source === project || r.target === project,
  )) {
    $("relationships").append(
      node(
        "p",
        r.source.split("/").at(-1) +
          " ↔ " +
          r.target.split("/").at(-1) +
          " · " +
          (r.relation || r.sessions + " shared sessions"),
        "relationship",
      ),
    );
  }
  if (!$("relationships").children.length)
    $("relationships").append(
      node("p", "Relationships emerge when a session spans projects.", "muted"),
    );
}
$("filters").onsubmit = (e) => {
  e.preventDefault();
  page = 0;
  pages = [null];
  loadHistory().catch(report);
};
$("kind").onchange = $("agent").onchange = () => {
  page = 0;
  pages = [null];
  loadHistory().catch(report);
};
$("next").onclick = () => {
  if (cursor) {
    pages[++page] = cursor;
    loadHistory().catch(report);
  }
};
$("previous").onclick = () => {
  if (page) {
    page--;
    loadHistory().catch(report);
  }
};
$("clear-session").onclick = () => {
  session = "";
  agentSession = "";
  page = 0;
  pages = [null];
  loadHistory().catch(report);
};
$("refresh").onclick = async () => {
  aggregates.clear();
  try {
    await loadProjects();
    await loadHistory();
  } catch (error) {
    report(error);
  }
};
function management(container, title, description, id, revoked, kind) {
  const row = node("article", undefined, "management-item"),
    text = node("div");
  text.append(node("h3", title), node("p", description));
  row.append(text);
  if (id) {
    const button = node("button", revoked ? "Revoked" : "Revoke");
    button.disabled = Boolean(revoked);
    button.onclick = async () => {
      button.disabled = true;
      try {
        await api(kind + "/" + id, { method: "DELETE" });
        button.textContent = "Revoked";
      } catch (e) {
        button.disabled = false;
        report(e);
      }
    };
    row.append(button);
  }
  container.append(row);
}
async function loadDevices() {
  $("devices").replaceChildren();
  for (const d of (await api("devices")).devices)
    management(
      $("devices"),
      d.label,
      "Connected " +
        date(d.created_at) +
        " · Upload last reported " +
        date(d.last_seen) +
        " · Expires " +
        date(d.expires_at),
      d.id,
      d.revoked_at,
      "devices",
    );
  if (!$("devices").children.length)
    $("devices").append(
      node("p", "Connect your first computer from Beacon.", "muted"),
    );
}
async function loadConnections() {
  $("connections").replaceChildren();
  for (const c of (await api("connections")).connections)
    management(
      $("connections"),
      c.name,
      (c.label || c.provider) +
        " · " +
        c.origin +
        " · " +
        c.device +
        (c.projects.length ? " · " + c.projects.join(", ") : " · All projects"),
    );
  if (!$("connections").children.length)
    $("connections").append(
      node(
        "p",
        "Named API connections appear after a computer synchronizes.",
        "muted",
      ),
    );
}
async function loadTokens() {
  $("tokens").replaceChildren();
  for (const t of (await api("tokens")).tokens)
    management(
      $("tokens"),
      t.label,
      (names[t.agent] || t.agent) +
        " · " +
        JSON.parse(t.scopes).join(", ") +
        " · Expires " +
        date(t.expires_at),
      t.id,
      t.revoked_at,
      "tokens",
    );
  if (!$("tokens").children.length)
    $("tokens").append(
      node("p", "No external agent connections yet.", "muted"),
    );
}
$("profile-handle").oninput = () => {
  $("profile-preview").textContent = $("profile-handle").value;
};
$("profile").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const result = await api("account", {
      method: "PATCH",
      body: JSON.stringify({
        handle: $("profile-handle").value,
        name: $("profile-name").value,
      }),
    });
    history.replaceState(null, "", result.workspace);
    $("profile-status").textContent = "Account saved.";
    $("account-name").textContent = $("profile-name").value;
    $("account-handle").textContent = "@" + result.handle;
  } catch (e) {
    $("profile-status").textContent = e.message;
  }
};
$("token-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const result = await api("tokens", {
      method: "POST",
      body: JSON.stringify({
        label: $("token-label").value,
        agent: $("token-agent").value,
        projects: [...$("token-projects").selectedOptions].map((o) => o.value),
        write: $("token-write").checked,
      }),
    });
    $("token-value").value = result.token;
    issuedProjects = [...$("token-projects").selectedOptions].map(
      (o) => o.value,
    );
    $("token-check-status").textContent = "";
    $("token-result").hidden = false;
    const preview = await api("preview-authorization", {
      method: "POST",
      body: "{}",
    });
    $("preview-result").hidden = !preview.cookie;
    $("preview-value").value = preview.cookie || "";
    await loadTokens();
  } catch (e) {
    report(e);
  }
};
$("copy-token").onclick = async () => {
  await navigator.clipboard.writeText($("token-value").value);
  $("copy-token").textContent = "Copied";
};
$("copy-preview").onclick = async () => {
  await navigator.clipboard.writeText($("preview-value").value);
  $("copy-preview").textContent = "Copied";
};
$("check-token").onclick = async () => {
  $("check-token").disabled = true;
  $("token-check-status").textContent =
    "Checking HTTP, MCP, and source integrity…";
  try {
    const result = await checkConnection(
      $("token-value").value,
      issuedProjects,
    );
    $("token-check-status").textContent =
      "Connected to @" +
      result.account +
      ". HTTP and MCP recall passed. " +
      result.projects.length +
      " accessible projects. " +
      (result.write ? "Recording allowed. " : "Read-only access. ") +
      (result.sourceVerified
        ? "Source SHA-256 verified for record " + result.record + "."
        : "No source records yet.");
  } catch (e) {
    $("token-check-status").textContent = e.message;
  } finally {
    $("check-token").disabled = false;
  }
};
$("signout").onclick = async () => {
  await fetch("/auth/logout", { method: "POST" });
  location.href = "/";
};
async function init() {
  try {
    const me = await api("me");
    account = me.account;
    $("account-name").textContent = account.name;
    $("account-handle").textContent = "@" + account.handle;
    $("avatar").textContent = account.name[0].toUpperCase();
    $("profile-name").value = account.name;
    $("profile-handle").value = account.handle;
    $("profile-preview").textContent = account.handle;
    for (const provider of ["google", "github"])
      if (me.providers[provider]) {
        const a = node(
          "a",
          "Link " +
            (provider === "google" ? "Google" : "GitHub") +
            " identity ↗",
          "identity-link",
        );
        a.href = "/auth/" + provider + "?link=1";
        $("identity-links").append(a);
      }
    await loadProjects();
    const initial = new URLSearchParams(location.search).get("project");
    if (initial) selectProject(initial);
    else await loadHistory();
  } catch (e) {
    report(e);
  }
}
init();

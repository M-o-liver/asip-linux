import { shell } from "./shell.js";
import { icon } from "./icons.js";
import { queryCache } from "./query-cache.js";
import { checkConnection } from "./api-check.js";

const login = document.body.dataset.surface === "login";
document.body.classList.toggle("login-surface", login);
document.querySelector("#app").innerHTML = shell(login);
const $ = (id) => document.getElementById(id);
const names = {
  codex: "Codex",
  "claude-code": "Claude Code",
  "Claude Code": "Claude Code",
  antigravity: "Antigravity",
  beacon: "Beacon",
  http: "HTTP client",
};
const glyphs = {
  codex: "◎",
  "claude-code": "✳",
  "Claude Code": "✳",
  antigravity: "⩓",
};
const cache = queryCache();
const state = {
  projects: [],
  agents: [],
  devices: [],
  connections: [],
  events: [],
  recordCount: 0,
  sessionCount: 0,
  project: "",
  session: "",
  sessionAgent: "",
  pages: [null],
  page: 0,
  next: null,
  account: null,
  history: [],
  view: "overview",
  loadedAt: 0,
  generation: 0,
  issuedProjects: [],
};
const n = (tag, text, className) => {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
};
const number = (v) => Number(v || 0).toLocaleString();
const date = (value) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "Not yet reported";
const shortName = (p) =>
  state.projects.find((item) => item.id === p)?.name ||
  p?.split(/[\\/]/).filter(Boolean).at(-1) ||
  "Unassigned";
function ago(value) {
  if (!value) return "Not reported";
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(value)) / 60000),
  );
  if (minutes < 1) return "Just now";
  if (minutes < 60) return minutes + "m ago";
  if (minutes < 1440) return Math.floor(minutes / 60) + "h ago";
  return Math.floor(minutes / 1440) + "d ago";
}
function symbol(name, className = "activity-symbol") {
  const el = n("span", undefined, className);
  el.innerHTML = icon(name);
  return el;
}
function action(text, fn, className = "btn compact") {
  const b = n("button", text, className);
  b.type = "button";
  b.onclick = fn;
  return b;
}
function empty(parent, text, link) {
  const el = n("div", undefined, "empty");
  el.append(n("p", text));
  if (link) {
    const a = n("a", "Connect your first computer →", "btn compact primary");
    a.href = "/download";
    el.append(a);
  }
  parent.replaceChildren(el);
}
let toastTimeout;
function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    $("toast").hidden = true;
  }, 6000);
}
function report(error) {
  $("error").textContent = error.message || String(error);
}
async function api(path, options = {}) {
  const response = await fetch("/api/v1/" + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const result = await response.json();
  if (response.status === 401) {
    location.assign("/");
    throw Error("Sign in to ASIP.");
  }
  if (response.status === 402) {
    state.access = { ...state.access, allowed: false };
    showView("billing");
  }
  if (!response.ok)
    throw Error(result.error || "ASIP could not complete this request.");
  return result;
}
const get = (path) => cache.get(path, () => api(path));
function showView(view, replace = false) {
  if (login) {
    $("signin").scrollIntoView({ behavior: "smooth", block: "center" });
    $("signin-status").textContent =
      "Sign in to open your private " +
      (view === "overview" ? "workspace" : view) +
      ".";
    return;
  }
  const valid = [
    "overview",
    "projects",
    "agents",
    "connections",
    "evidence",
    "recovery",
    "billing",
    "settings",
  ];
  if (!valid.includes(view)) view = "overview";
  state.view = view;
  document.querySelectorAll("[data-panel]").forEach((p) => {
    p.hidden = p.dataset.panel !== view;
  });
  document.querySelectorAll(".top-nav [data-view]").forEach((b) => {
    const active = b.dataset.view === view;
    b.classList.toggle("selected", active);
    if (active) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  $("account-menu").hidden = true;
  $("account-toggle").setAttribute("aria-expanded", "false");
  $("mobile-menu").setAttribute("aria-expanded", "false");
  document.body.classList.remove("menu-open");
  if (location.hash !== "#" + view)
    history[replace ? "replaceState" : "pushState"]({}, "", "#" + view);
  document.title = view[0].toUpperCase() + view.slice(1) + " — ASIP";
  if (view === "evidence") loadHistory().catch(report);
  if (view === "agents") loadSessions().catch(report);
  if (view === "settings") loadTokens().catch(report);
  if (view === "billing")
    loadBilling(
      new URLSearchParams(location.search).get("billing") === "success",
    ).catch(report);
}
document.addEventListener("click", (event) => {
  const target = event.target.closest("[data-view]");
  if (target) {
    event.preventDefault();
    showView(target.dataset.view);
  }
});
window.addEventListener("popstate", () =>
  showView(location.hash.slice(1), true),
);
$("mobile-menu").onclick = () => {
  const open = document.body.classList.toggle("menu-open");
  $("mobile-menu").setAttribute("aria-expanded", String(open));
};
$("account-toggle").onclick = () => {
  if (login) {
    $("signin").scrollIntoView({ behavior: "smooth" });
    return;
  }
  $("account-menu").hidden = !$("account-menu").hidden;
  $("account-toggle").setAttribute(
    "aria-expanded",
    String(!$("account-menu").hidden),
  );
};
document.addEventListener("click", (e) => {
  if (!e.target.closest(".account-wrap")) {
    $("account-menu").hidden = true;
    $("account-toggle").setAttribute("aria-expanded", "false");
  }
});
$("how-button").onclick = () => $("how-dialog").showModal();
$("close-how").onclick = () => $("how-dialog").close();
$("close-record").onclick = () => $("record-dialog").close();
for (const id of ["how-dialog", "record-dialog"])
  $(id).addEventListener("click", (e) => {
    if (e.target === $(id)) {
      const rect = $(id).getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
      )
        $(id).close();
    }
  });
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    $("global-query").focus();
  }
});
$("global-search").onsubmit = (e) => {
  e.preventDefault();
  if (login) return showView("evidence");
  const term = $("global-query").value.trim();
  const project = state.projects.find(
    (p) =>
      (p.name || "").toLowerCase() === term.toLowerCase() ||
      p.id.toLowerCase() === term.toLowerCase(),
  );
  if (project) return selectProject(project.id);
  const agent = ["codex", "claude-code", "antigravity"].find(
    (id) =>
      id === term.toLowerCase() ||
      names[id].toLowerCase() === term.toLowerCase(),
  );
  state.project = state.session = state.sessionAgent = "";
  $("agent").value = agent || "";
  $("query").value = agent ? "" : term;
  resetHistory();
  showView("evidence");
};
function resetHistory() {
  state.pages = [null];
  state.page = 0;
}
function selectProject(id, category = "work") {
  state.project = id;
  state.session = "";
  state.sessionAgent = "";
  $("query").value = "";
  $("agent").value = "";
  $("kind").value = category;
  resetHistory();
  showView("evidence");
}
function pinned() {
  try {
    return JSON.parse(
      localStorage.getItem("asip-pinned-" + state.account.id) || "[]",
    );
  } catch {
    return [];
  }
}
function togglePin(id) {
  const values = new Set(pinned());
  values.has(id) ? values.delete(id) : values.add(id);
  try {
    localStorage.setItem(
      "asip-pinned-" + state.account.id,
      JSON.stringify([...values]),
    );
  } catch {
    toast("Your browser could not save this preference.");
  }
  renderProjects();
  renderProjectPreview();
}
function renderProjectPreview(
  tab = document.querySelector("[data-project-tab].selected")?.dataset
    .projectTab || "recent",
) {
  const parent = $("project-previews");
  parent.replaceChildren();
  const list = state.projects
    .filter((p) =>
      tab === "pinned"
        ? pinned().includes(p.id)
        : tab === "active"
          ? Date.now() - Date.parse(p.lastActivity) < 7 * 86400000
          : true,
    )
    .slice(0, 5);
  if (!list.length)
    return empty(
      parent,
      tab === "pinned"
        ? "Pin a project from Projects to keep it close."
        : "Your project memory starts with your first connected computer.",
      tab !== "pinned",
    );
  for (const p of list) {
    const b = action(
      "",
      () => selectProject(p.id),
      "project-row" + (p.id === state.projects[0]?.id ? " selected" : ""),
    );
    b.title = p.name || p.id;
    const info = n("div", undefined, "project-name");
    info.append(
      n("strong", p.name || shortName(p.id)),
      n("small", p.description || p.repository || p.id),
    );
    const stats = n("div", undefined, "project-numbers");
    stats.append(
      n("div", (p.agents?.length || 0) + " agents"),
      n("div", number(p.events) + " records"),
    );
    b.append(
      n("span", (p.name || shortName(p.id))[0].toUpperCase(), "project-avatar"),
      info,
      stats,
      n("span", ago(p.lastActivity), "project-time"),
    );
    parent.append(b);
  }
}
document.querySelectorAll("[data-project-tab]").forEach(
  (b) =>
    (b.onclick = () => {
      document
        .querySelectorAll("[data-project-tab]")
        .forEach((item) => item.classList.toggle("selected", item === b));
      renderProjectPreview(b.dataset.projectTab);
    }),
);
function renderProjects() {
  const list = state.projects.filter((p) =>
    (p.name + " " + p.id + " " + p.description)
      .toLowerCase()
      .includes($("project-query").value.toLowerCase()),
  );
  $("project-directory").replaceChildren();
  $("token-projects").replaceChildren();
  for (const p of state.projects) {
    const o = n("option", p.name || p.id);
    o.value = p.id;
    $("token-projects").append(o);
  }
  if (!list.length)
    empty(
      $("project-directory"),
      "No projects found. Connect Beacon to bring your recorded work into ASIP.",
      !state.projects.length,
    );
  for (const p of list) {
    const card = n("article", undefined, "glass management-card"),
      top = n("div", undefined, "card-top");
    top.append(
      n("span", (p.name || shortName(p.id))[0].toUpperCase(), "project-avatar"),
      action(
        pinned().includes(p.id) ? "Pinned ✓" : "Pin project",
        () => togglePin(p.id),
        "link-button",
      ),
    );
    const open = action(
      "Open project memory →",
      () => selectProject(p.id),
      "btn compact primary",
    );
    card.append(
      top,
      n("h2", p.name || shortName(p.id)),
      n("p", p.description || p.repository || p.id),
      n(
        "p",
        number(p.events) +
          " records · " +
          (p.agents?.length || 0) +
          " agents · " +
          ago(p.lastActivity),
      ),
      open,
    );
    $("project-directory").append(card);
  }
}
$("project-query").oninput = renderProjects;
document.querySelector('[data-action="all-memory"]').onclick = () =>
  selectProject("");
function agentGlyph(agent, className = "agent-glyph") {
  return n(
    "span",
    glyphs[agent] || "◈",
    className + " " + agent.replace(/[^a-z-]/g, ""),
  );
}
function knownAgents() {
  return state.agents.filter((a) =>
    ["codex", "claude-code", "antigravity"].includes(a.id),
  );
}
function renderAgents() {
  const agents = knownAgents();
  $("agent-previews").replaceChildren();
  $("agent-directory").replaceChildren();
  $("active-agents").textContent = agents.length + " CONNECTED";
  if (!agents.length)
    empty(
      $("agent-previews"),
      "Connect your native agent plugins in Beacon.",
      true,
    );
  for (const a of agents.slice(0, 2)) {
    const recent = Date.now() - Date.parse(a.lastActivity) < 15 * 60000;
    const card = n("article", undefined, "agent-card"),
      content = n("div"),
      title = n("h3", names[a.id] || a.id);
    title.append(
      n(
        "span",
        recent ? "Recent" : "Recorded",
        "pill" + (recent ? "" : " offline"),
      ),
    );
    const facts = n("div", undefined, "agent-facts"),
      last = n("div"),
      count = n("div");
    last.append(n("span", "Last activity"), ago(a.lastActivity));
    count.append(n("span", "Processed"), number(a.events) + " events");
    facts.append(last, count);
    content.append(title, n("p", "Native plugin · Cloud memory"), facts);
    const bars = n("div", undefined, "bars");
    bars.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 11; i++) bars.append(n("i"));
    const open = action(
      "",
      () => {
        $("agent").value = a.id;
        state.project = "";
        resetHistory();
        showView("evidence");
      },
      "card-arrow",
    );
    open.setAttribute(
      "aria-label",
      "Open " + (names[a.id] || a.id) + " activity",
    );
    open.innerHTML = icon("chevron", true);
    card.append(agentGlyph(a.id), content, bars, open);
    $("agent-previews").append(card);
  }
  for (const a of state.agents) {
    const card = n("article", undefined, "glass management-card"),
      top = n("div", undefined, "card-top");
    top.append(agentGlyph(a.id), n("span", "Recorded", "pill offline"));
    card.append(
      top,
      n("h2", names[a.id] || a.id),
      n(
        "p",
        number(a.events) +
          " original records · Last active " +
          ago(a.lastActivity),
      ),
      action("Open agent activity →", () => {
        $("agent").value = ["codex", "claude-code", "antigravity"].includes(
          a.id,
        )
          ? a.id
          : "";
        state.project = "";
        resetHistory();
        showView("evidence");
      }),
    );
    $("agent-directory").append(card);
  }
  if (!state.agents.length)
    empty(
      $("agent-directory"),
      "Your native agent activity will appear here.",
      true,
    );
  $("device-directory").replaceChildren();
  for (const d of state.devices) {
    const card = n("article", undefined, "glass management-card"),
      top = n("div", undefined, "card-top");
    const expired = Date.parse(d.expires_at) < Date.now();
    top.append(
      symbol("device", "card-device"),
      n(
        "span",
        d.revoked_at ? "Revoked" : expired ? "Expired" : "Connected",
        "pill" + (d.revoked_at || expired ? " offline" : ""),
      ),
    );
    const revoke = action(
      d.revoked_at ? "Revoked" : "Revoke connection",
      async () => {
        revoke.disabled = true;
        try {
          await api("devices/" + encodeURIComponent(d.id), {
            method: "DELETE",
          });
          d.revoked_at = new Date().toISOString();
          renderAgents();
          toast("Device access revoked.");
        } catch (e) {
          revoke.disabled = false;
          report(e);
        }
      },
    );
    revoke.disabled = Boolean(d.revoked_at);
    card.append(
      top,
      n("h2", d.label),
      n("p", "Last upload reported " + ago(d.last_seen)),
      n(
        "p",
        "Connected " + date(d.created_at) + " · Expires " + date(d.expires_at),
      ),
      revoke,
    );
    $("device-directory").append(card);
  }
  if (!state.devices.length)
    empty(
      $("device-directory"),
      "Connect a computer through Beacon → Connect cloud.",
      true,
    );
}
function renderConnections() {
  const parent = $("connection-directory");
  parent.replaceChildren();
  for (const c of state.connections) {
    const card = n("article", undefined, "glass management-card");
    card.append(
      symbol("key", "card-device"),
      n("h2", c.name),
      n("p", c.label || c.provider),
      n("p", c.origin || "Stored signing secret"),
      n("p", "Device: " + c.device),
      n(
        "p",
        c.projects.length
          ? c.projects.map(shortName).join(", ")
          : "All projects",
      ),
    );
    parent.append(card);
  }
  if (!state.connections.length)
    empty(
      parent,
      "Add API connections in Beacon. Their names and project scope synchronize here.",
      true,
    );
}
function eventType(e) {
  if (/fail|unresolved|held/i.test(e.kind))
    return ["shield", "Needs attention", ""];
  if (/intent/i.test(e.kind)) return ["network", "Intent recorded", "green"];
  if (/evidence/i.test(e.kind)) return ["file", "Evidence captured", ""];
  if (/api/i.test(e.kind)) return ["database", "API request", "blue"];
  if (/sync/i.test(e.kind)) return ["sync", "Sync completed", "green"];
  return ["file", "Project updated", ""];
}
function renderActivity() {
  const parent = $("activity-items");
  parent.replaceChildren();
  for (const e of state.events.slice(0, 6)) {
    const [type, label, color] = eventType(e),
      b = action("", () => inspect(e), "activity-item"),
      content = n("div", undefined, "activity-content");
    content.append(
      n("strong", label),
      n("span", ago(e.at)),
      n("p", names[e.agent] || e.agent),
      n("p", shortName(e.project)),
    );
    b.append(symbol(type, "activity-symbol " + color), content);
    parent.append(b);
  }
  if (!state.events.length)
    empty(
      parent,
      "Your next intention, result, or evidence starts the stream.",
    );
  const evidence = $("evidence-previews");
  evidence.replaceChildren();
  for (const e of state.events.slice(0, 3)) {
    const b = action("", () => inspect(e), "evidence-row"),
      text = n("div");
    text.append(
      n("strong", e.summary),
      n("small", shortName(e.project) + " · " + date(e.at)),
    );
    b.append(
      symbol("file", "source-icon"),
      text,
      n("span", names[e.agent] || e.agent, "source-chip"),
    );
    evidence.append(b);
  }
  if (!state.events.length)
    empty(evidence, "Your recorded evidence appears here.");
}
function renderSpotlight() {
  const p = state.projects[0],
    parent = $("spotlight-body");
  if (!p)
    return empty(
      parent,
      "Your next project starts here. Connect Beacon to keep its context with you.",
      true,
    );
  parent.replaceChildren();
  const head = n("div", undefined, "spotlight-project"),
    title = n("div");
  title.append(
    n("h3", p.name || shortName(p.id)),
    n(
      "p",
      (p.agents?.length || 0) +
        " agents · " +
        number(p.events) +
        " records · Updated " +
        ago(p.lastActivity),
    ),
  );
  head.append(
    n("span", (p.name || "A")[0].toUpperCase(), "project-avatar"),
    title,
  );
  parent.append(
    head,
    n(
      "p",
      p.description ||
        "The original intent, the work, and the evidence — connected across every session in this project.",
      "spotlight-description",
    ),
  );
  const label = n("div", "Recent activity", "recent-label");
  label.append(action("View all →", () => selectProject(p.id), "link-button"));
  parent.append(label);
  const events = state.events.filter((e) => e.project === p.id).slice(0, 4);
  for (const e of events) {
    const row = action("", () => inspect(e), "recent-event");
    row.append(
      agentGlyph(e.agent, "mini-agent"),
      n("strong", names[e.agent] || e.agent),
      n("span", e.summary),
      n("time", ago(e.at)),
    );
    parent.append(row);
  }
  if (!events.length)
    parent.append(
      n(
        "p",
        "Open project memory to review its recorded work.",
        "login-feature",
      ),
    );
  const actions = n("div", undefined, "actions");
  actions.append(
    action("Open project →", () => selectProject(p.id), "btn primary compact"),
    action("View evidence  " + number(p.events), () =>
      selectProject(p.id, "results"),
    ),
  );
  parent.append(actions);
}
function renderSummary() {
  const projects = state.projects,
    devices = state.devices.filter(
      (d) => !d.revoked_at && Date.parse(d.expires_at) > Date.now(),
    ),
    agents = knownAgents();
  $("project-total").textContent = number(projects.length);
  $("project-count").textContent = number(projects.length);
  $("record-total").textContent = number(state.recordCount);
  $("agent-total").textContent = agents.length;
  $("device-total").textContent = devices.length;
  $("connection-total").textContent = new Set(
    state.connections.map((c) => c.name),
  ).size;
  $("system-status").textContent = "ALL SYSTEMS OPERATIONAL";
  $("system-description").textContent =
    "Synced across " +
    agents.length +
    " agents · " +
    devices.length +
    " devices · " +
    new Set(state.connections.map((c) => c.name)).size +
    " APIs";
  $("last-sync").textContent = date(new Date());
  $("sync-note").textContent = "Cloud memory up to date";
  $("orb-count").textContent = number(state.recordCount) + " records";
  $("orb-meta").textContent =
    projects.length +
    " projects · " +
    agents.length +
    " agents · " +
    devices.length +
    " devices";
  $("orb-title").textContent = state.recordCount
    ? "SYNCHRONIZED"
    : "READY TO CONNECT";
  $("map-cloud-records").textContent = number(state.recordCount) + " records";
  $("map-apis").textContent =
    new Set(state.connections.map((c) => c.name)).size + " connected";
  for (const [index, suffix] of [
    [0, "one"],
    [1, "two"],
  ]) {
    const d = devices[index];
    if (d) {
      $("map-device-" + suffix).textContent = d.label.split(" · ")[0];
      $("map-agent-" + suffix).textContent =
        d.label.split(" · ").slice(1).join(" · ") || "Beacon";
      $("map-time-" + suffix).textContent = "Upload " + ago(d.last_seen);
    }
  }
  $("recovery-summary").textContent =
    number(state.recordCount) +
    " records across " +
    projects.length +
    " projects. Original evidence, source hashes, and native sessions are retained in your cloud memory.";
}
async function loadSnapshot() {
  const [p, overview, devices, connections, events] = await Promise.all([
    get("projects"),
    get("overview"),
    get("devices"),
    get("connections"),
    get("events?category=work&limit=6"),
  ]);
  Object.assign(state, overview, {
    projects: p.projects.sort((a, b) =>
      (b.lastActivity || "").localeCompare(a.lastActivity || ""),
    ),
    devices: devices.devices,
    connections: connections.connections,
    events: events.events,
    loadedAt: Date.now(),
  });
  renderSummary();
  renderAgents();
  renderProjectPreview();
  renderProjects();
  renderConnections();
  renderActivity();
  renderSpotlight();
}
async function loadSessions() {
  const result = await get("sessions");
  $("sessions").replaceChildren();
  for (const s of result.sessions) {
    const b = action(
        "",
        () => {
          state.session = s.session;
          state.sessionAgent = s.agent;
          state.project = "";
          resetHistory();
          showView("evidence");
        },
        "session-row",
      ),
      title = n("div");
    title.append(
      n("strong", names[s.agent] || s.agent),
      n("small", s.session),
      n("small", ago(s.lastActivity)),
    );
    b.append(title, n("span", number(s.events) + " records"));
    $("sessions").append(b);
  }
  if (!result.sessions.length)
    empty($("sessions"), "Your native agent sessions will appear here.");
}
async function loadHistory() {
  const generation = ++state.generation;
  const params = new URLSearchParams({
    category: $("kind").value,
    limit: "30",
    query: $("query").value,
    agent: $("agent").value,
  });
  if (state.project) params.set("project", state.project);
  if (state.session) {
    params.set("session", state.session);
    params.set("agent", state.sessionAgent);
  }
  if (state.pages[state.page]) params.set("before", state.pages[state.page]);
  const [result, relationships] = await Promise.all([
    get("events?" + params),
    get("relationships"),
  ]);
  if (generation !== state.generation) return;
  state.history = result.events;
  state.next = result.next;
  $("history-title").textContent = state.project
    ? shortName(state.project)
    : "Evidence & memory";
  $("history-description").textContent = state.project
    ? state.project
    : "Return to the original record, agent session, and supporting evidence.";
  $("events").replaceChildren();
  for (const e of result.events) {
    const b = action("", () => inspect(e), "event-row"),
      info = n("div", undefined, "event-info"),
      type = n("div", undefined, "event-type"),
      meta = n("div", undefined, "event-meta"),
      [glyph] = eventType(e);
    type.append(n("span", e.kind.replaceAll("_", " ")), n("span", date(e.at)));
    meta.append(
      n("span", names[e.agent] || e.agent),
      n("span", shortName(e.project)),
      n("span", e.session.slice(0, 18)),
    );
    info.append(type, n("h3", e.summary), meta);
    b.append(symbol(glyph), info);
    $("events").append(b);
  }
  if (!result.events.length)
    empty(
      $("events"),
      "No matching records. Try another filter or connect a computer to start recording.",
      !state.recordCount,
    );
  $("next").disabled = !state.next;
  $("previous").disabled = state.page === 0;
  $("page").textContent = "Page " + (state.page + 1);
  $("history-scope").hidden = !state.project && !state.session;
  $("scope-label").textContent = state.session
    ? (names[state.sessionAgent] || state.sessionAgent) + " / " + state.session
    : shortName(state.project);
  $("history-count").textContent =
    number(
      state.project
        ? state.projects.find((p) => p.id === state.project)?.events
        : state.recordCount,
    ) + " original records in this context.";
  $("relationships").replaceChildren();
  for (const r of relationships.relationships
    .filter(
      (r) =>
        !state.project ||
        r.source === state.project ||
        r.target === state.project,
    )
    .slice(0, 15)) {
    const el = n(
      "p",
      shortName(r.source) + " ↔ " + shortName(r.target),
      "login-feature",
    );
    el.append(n("small", " · " + (r.sessions || r.relation || "linked")));
    $("relationships").append(el);
  }
  if (!$("relationships").children.length)
    empty(
      $("relationships"),
      "Project relationships appear as your sessions connect work.",
    );
}
$("history-search").onsubmit = (e) => {
  e.preventDefault();
  resetHistory();
  loadHistory().catch(report);
};
$("next").onclick = () => {
  if (!state.next) return;
  state.pages[++state.page] = state.next;
  loadHistory().catch(report);
};
$("previous").onclick = () => {
  if (!state.page) return;
  state.page--;
  loadHistory().catch(report);
};
$("clear-scope").onclick = () => {
  state.project = state.session = state.sessionAgent = "";
  resetHistory();
  loadHistory().catch(report);
};
$("history-refresh").onclick = async () => {
  cache.clear();
  $("history-refresh").disabled = true;
  try {
    await loadHistory();
  } catch (e) {
    report(e);
  } finally {
    $("history-refresh").disabled = false;
  }
};
let selectedRecord;
function inspect(e) {
  selectedRecord = e;
  $("evidence-title").textContent = e.summary;
  $("record-facts").replaceChildren();
  for (const [key, value] of Object.entries({
    Agent: names[e.agent] || e.agent,
    Session: e.session,
    Project: e.project || "Unassigned",
    Recorded: date(e.at),
    Device: e.device_id,
    Record: e.id,
    "SHA-256": e.sha256,
  }))
    $("record-facts").append(n("dt", key), n("dd", value || "Not reported"));
  $("record-data").textContent = JSON.stringify(e.data, null, 2);
  $("source-download").href =
    "/api/v1/events/" + encodeURIComponent(e.id) + "/source";
  $("verification-status").textContent = "";
  $("verify-source").disabled = false;
  $("record-dialog").showModal();
}
$("verify-source").onclick = async () => {
  const e = selectedRecord;
  $("verify-source").disabled = true;
  try {
    const response = await fetch(
      "/api/v1/events/" + encodeURIComponent(e.id) + "/source",
    );
    if (!response.ok) throw Error("Source could not be retrieved.");
    const bytes = await response.arrayBuffer();
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    if (digest !== e.sha256)
      throw Error(
        "Source hash differs from this record. Keep the original evidence for investigation.",
      );
    $("verification-status").textContent =
      "Verified · Source SHA-256 matches the original cloud record.";
  } catch (err) {
    $("verification-status").textContent = err.message;
  } finally {
    $("verify-source").disabled = false;
  }
};
async function loadTokens() {
  const result = await api("tokens");
  $("tokens").replaceChildren();
  for (const t of result.tokens) {
    const el = n("article", undefined, "management-item"),
      text = n("div"),
      revoke = action(t.revoked_at ? "Revoked" : "Revoke", async () => {
        revoke.disabled = true;
        try {
          await api("tokens/" + encodeURIComponent(t.id), { method: "DELETE" });
          await loadTokens();
        } catch (e) {
          revoke.disabled = false;
          report(e);
        }
      });
    revoke.disabled = Boolean(t.revoked_at);
    text.append(
      n("h3", t.label),
      n(
        "p",
        (names[t.agent] || t.agent) +
          " · " +
          JSON.parse(t.scopes).join(", ") +
          " · Expires " +
          date(t.expires_at),
      ),
    );
    el.append(text, revoke);
    $("tokens").append(el);
  }
  if (!result.tokens.length)
    empty($("tokens"), "No external agent connections yet.");
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
    history.replaceState({}, "", result.workspace + "#settings");
    $("account-name").textContent = $("profile-name").value;
    $("account-handle").textContent = "@" + result.handle;
    $("profile-status").textContent = "Account saved.";
  } catch (err) {
    $("profile-status").textContent = err.message;
  }
};
$("token-form").onsubmit = async (e) => {
  e.preventDefault();
  const submit = e.currentTarget.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    state.issuedProjects = [...$("token-projects").selectedOptions].map(
      (o) => o.value,
    );
    const result = await api("tokens", {
      method: "POST",
      body: JSON.stringify({
        label: $("token-label").value,
        agent: $("token-agent").value,
        projects: state.issuedProjects,
        write: $("token-write").checked,
      }),
    });
    $("token-value").value = result.token;
    $("token-result").hidden = false;
    $("token-check-status").textContent = "";
    await loadTokens();
  } catch (err) {
    report(err);
  } finally {
    submit.disabled = false;
  }
};
$("copy-token").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("token-value").value);
    toast("Credential copied.");
  } catch {
    $("token-value").select();
    toast("Select and copy the credential.");
  }
};
$("check-token").onclick = async () => {
  $("check-token").disabled = true;
  $("token-check-status").textContent =
    "Checking HTTP, MCP, and source integrity…";
  try {
    const result = await checkConnection(
      $("token-value").value,
      state.issuedProjects,
    );
    $("token-check-status").textContent =
      "Connected to @" +
      result.account +
      ". HTTP and MCP recall passed. " +
      (result.sourceVerified
        ? "Source SHA-256 verified."
        : "No source records yet.");
  } catch (e) {
    $("token-check-status").textContent = e.message;
  } finally {
    $("check-token").disabled = false;
  }
};
$("signout").onclick = async () => {
  try {
    const r = await fetch("/auth/logout", { method: "POST" });
    if (!r.ok) throw Error("Sign-out could not complete.");
    location.assign("/");
  } catch (e) {
    report(e);
  }
};
async function loadBilling(refresh = false) {
  const billing = await api("billing" + (refresh ? "?refresh=1" : ""));
  state.billing = billing;
  $("billing-badge").textContent =
    billing.status === "founder"
      ? "Founder access"
      : billing.status === "active"
        ? "Subscribed"
        : billing.status === "trialing"
          ? billing.daysRemaining + " days remaining"
          : billing.status === "expired"
            ? "Trial ended"
            : billing.status.replaceAll("_", " ");
  $("billing-state").textContent =
    billing.status === "founder"
      ? "Your existing preview account includes founder access to ASIP Cloud."
      : billing.status === "trialing"
        ? "Your free trial ends " + date(billing.trialEndsAt) + "."
        : billing.status === "active"
          ? (billing.cancelAtPeriodEnd
              ? "Your subscription ends "
              : "Your subscription renews ") +
            date(billing.periodEndsAt) +
            "."
          : "Subscribe to continue. Your original history is safely retained.";
  const subscribed =
    billing.hasCustomer &&
    ["active", "trialing", "past_due", "unpaid", "paused"].includes(
      billing.status,
    ) &&
    Boolean(billing.periodEndsAt);
  $("subscribe").hidden = billing.status === "founder" || subscribed;
  $("subscribe").disabled = !billing.configured;
  $("manage-billing").hidden =
    !billing.hasCustomer || billing.status === "founder";
  if (!billing.configured && billing.status !== "founder")
    $("billing-message").textContent =
      "Subscriptions are being connected. Your free trial remains available.";
  else
    $("billing-message").textContent =
      refresh && !subscribed
        ? "Waiting for Stripe confirmation. Refresh this page shortly if your checkout just completed."
        : "";
  if (refresh && subscribed)
    history.replaceState({}, "", location.pathname + "#billing");
}
for (const [id, path] of [
  ["subscribe", "checkout"],
  ["manage-billing", "portal"],
])
  $(id).onclick = async () => {
    $(id).disabled = true;
    try {
      const result = await api("billing/" + path, {
        method: "POST",
        body: "{}",
      });
      const target = new URL(result.url);
      if (
        target.protocol !== "https:" ||
        !["checkout.stripe.com", "billing.stripe.com"].includes(target.hostname)
      )
        throw Error("Billing returned an unexpected destination.");
      location.assign(target.href);
    } catch (e) {
      $("billing-message").textContent = e.message;
      $(id).disabled = false;
    }
  };
if (!login)
  $("refresh").onclick = async () => {
    if ($("refresh").disabled) return;
    $("refresh").disabled = true;
    document.body.classList.add("busy");
    $("error").textContent = "";
    cache.clear();
    try {
      await loadSnapshot();
      if (state.view === "evidence") await loadHistory();
      toast("Cloud memory refreshed. Beacon handles device synchronization.");
    } catch (e) {
      report(e);
      $("system-status").textContent = "WORKSPACE NEEDS ATTENTION";
    } finally {
      $("refresh").disabled = false;
      document.body.classList.remove("busy");
    }
  };
async function initLogin() {
  const config = await fetch("/api/config").then((r) => r.json());
  const returnPath = new URLSearchParams(location.search).get("return");
  for (const link of document.querySelectorAll("[data-provider]")) {
    if (returnPath?.startsWith("/connect?"))
      link.href += "?return=" + encodeURIComponent(returnPath);
    link.onclick = (e) => {
      if (!config.providers[link.dataset.provider]) {
        e.preventDefault();
        $("signin-status").textContent =
          "This sign-in provider is being connected. Please try again shortly.";
      }
    };
  }
  $("start-trial").onclick = () => {
    const provider = config.providers.github
      ? "github"
      : config.providers.google
        ? "google"
        : null;
    if (provider)
      document.querySelector('[data-provider="' + provider + '"]').click();
    else
      $("signin-status").textContent =
        "Sign-in is being connected. Please return shortly.";
  };
  const activities = [
    [
      "network",
      "Capture the intention",
      "Your native agent plugin",
      "Every project",
    ],
    ["file", "Keep the evidence", "Original source records", "Full provenance"],
    [
      "cloud",
      "Synchronize context",
      "Your private workspace",
      "Across devices",
    ],
    ["sync", "Continue the work", "Your next agent session", "Nothing lost"],
  ];
  for (const [i, t, p, s] of activities) {
    const el = n("div", undefined, "activity-item"),
      content = n("div", undefined, "activity-content");
    content.append(n("strong", t), n("span", p), n("p", s));
    el.append(symbol(i, "activity-symbol green"), content);
    $("activity-items").append(el);
  }
  const me = await fetch("/api/v1/me");
  if (me.ok) {
    const data = await me.json();
    $("start-trial").textContent = "Open your workspace →";
    $("start-trial").onclick = () => location.assign(data.workspace);
  }
  const error = new URLSearchParams(location.search).get("auth_error");
  if (error) $("signin-status").textContent = error;
}
async function initWorkspace() {
  const me = await api("me");
  state.account = me.account;
  state.access = me.access;
  $("account-name").textContent = me.account.name;
  $("account-handle").textContent = "@" + me.account.handle;
  $("account-toggle").textContent = me.account.name[0].toUpperCase();
  $("profile-name").value = me.account.name;
  $("profile-handle").value = me.account.handle;
  $("profile-preview").textContent = me.account.handle;
  for (const provider of ["github", "google"])
    if (me.providers[provider]) {
      const a = n(
        "a",
        "Link " + (provider === "github" ? "GitHub" : "Google") + " identity ↗",
        "btn compact",
      );
      a.href = "/auth/" + provider + "?link=1";
      $("identity-links").append(a);
    }
  if (me.access?.allowed === false) {
    $("system-status").textContent = "YOUR MEMORY IS SAFELY RETAINED";
    $("system-description").textContent =
      "Subscribe to continue your cloud workspace.";
    showView("billing", true);
    return;
  }
  await loadSnapshot();
  if (me.access?.status === "trialing") {
    $("access-notice").hidden = false;
    $("access-notice").append(
      n(
        "span",
        "Your 7 day trial is active · " +
          me.access.daysRemaining +
          " days remaining. ",
      ),
      action("View subscription →", () => showView("billing"), "link-button"),
    );
  }
  const initial = new URLSearchParams(location.search).get("project");
  if (initial) selectProject(initial);
  else showView(location.hash.slice(1) || "overview", true);
}
(login ? initLogin() : initWorkspace()).catch(report);

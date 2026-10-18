const $ = (id) => document.getElementById(id);
const names = {
  codex: "Codex",
  "claude-code": "Claude Code",
  antigravity: "Antigravity",
};
const kinds = {
  intent: "Intent",
  result: "Result",
  evidence: "Evidence",
  Stop: "Agent result",
  failed: "Failed",
  tool_succeeded: "Tool completed",
  api_request: "API request",
  api_result: "API result",
  api_failed: "API failed",
  api_unresolved: "API unresolved",
  unresolved: "Unresolved",
  PreToolUse: "Tool started",
  PostToolUse: "Tool result",
  SessionStart: "Session started",
  SessionEnd: "Session ended",
  Interrupt: "Interrupted",
  "intent.finished": "Completed",
  "intent.failed": "Failed",
  "intent.held": "Unresolved",
  "intent.released": "Resumed",
  "intent.superseded": "Superseded",
  "verification.passed": "Verified",
  "verification.failed": "Verification failed",
};
const state = {
  project: new URLSearchParams(location.search).get("project") || "",
  session: "",
  agent: "",
  audit: false,
  kind: "work",
  query: "",
  offset: 0,
  sessionOffset: 0,
  selected: null,
};
let request;
const label = (project) =>
  project === "unassigned"
    ? "Unassigned"
    : project?.split(/[\\/]/).filter(Boolean).at(-1) || "Unassigned";
function element(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function selectProject(project) {
  state.project = project;
  state.session = "";
  state.agent = "";
  state.offset = 0;
  state.sessionOffset = 0;
  state.selected = null;
  history.replaceState(
    {},
    "",
    "/workspace/" + (project ? "?project=" + encodeURIComponent(project) : ""),
  );
  load();
}
function facts(event) {
  $("evidence-empty").hidden = Boolean(event);
  $("evidence").hidden = !event;
  if (!event) return;
  $("facts").replaceChildren();
  for (const [name, value] of Object.entries({
    Record: event.id,
    Agent: names[event.agent] || event.agent,
    Project: event.project || "Unassigned",
    Session: event.session,
    Time: new Date(event.at).toLocaleString(),
    Type: event.kind,
    Summary: event.summary,
    Revision: event.data.head || undefined,
    "Worktree state": event.data.head
      ? event.data.worktree || "Clean"
      : undefined,
    "Provider request": event.data.providerRequestId,
  })) {
    if (value === undefined) continue;
    $("facts").append(element("dt", name), element("dd", value));
  }
  $("data").textContent = JSON.stringify(event.data, null, 2);
}
function map(data) {
  const svg = $("map"),
    ns = "http://www.w3.org/2000/svg";
  svg.replaceChildren();
  const focus = (id) => {
    svg.classList.toggle("focused", Boolean(id));
    for (const line of svg.querySelectorAll("line"))
      line.classList.toggle(
        "related",
        line.dataset.source === id || line.dataset.target === id,
      );
  };
  const projects = data.projects;
  $("map-empty").hidden = Boolean(projects.length);
  svg.hidden = !projects.length;
  $("map-count").textContent = data.projects.length + " projects";
  const columns = Math.min(4, Math.max(1, projects.length));
  const height = Math.max(140, Math.ceil(projects.length / columns) * 85 + 30);
  svg.setAttribute("viewBox", "0 0 900 " + height);
  const positions = new Map(
    projects.map((project, index) => [
      project.id,
      {
        x: (((index % columns) + 0.5) * 900) / columns,
        y: 65 + Math.floor(index / columns) * 85,
      },
    ]),
  );
  for (const relation of data.relationships) {
    const a = positions.get(relation.source),
      b = positions.get(relation.target);
    if (!a || !b) continue;
    const line = document.createElementNS(ns, "line");
    line.dataset.source = relation.source;
    line.dataset.target = relation.target;
    for (const [key, value] of Object.entries({
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
    }))
      line.setAttribute(key, value);
    const title = document.createElementNS(ns, "title");
    title.textContent =
      relation.relation ||
      relation.sessions + " sessions shared across these projects";
    line.append(title);
    svg.append(line);
  }
  for (const project of projects) {
    const { x, y } = positions.get(project.id),
      group = document.createElementNS(ns, "g");
    group.setAttribute("tabindex", "0");
    group.setAttribute("role", "button");
    group.setAttribute("aria-label", project.id);
    const title = document.createElementNS(ns, "title");
    title.textContent = project.id;
    if (state.project === project.id) group.classList.add("selected");
    const rect = document.createElementNS(ns, "rect");
    for (const [key, value] of Object.entries({
      x: x - 92,
      y: y - 25,
      width: 184,
      height: 54,
      rx: 8,
    }))
      rect.setAttribute(key, value);
    const text = document.createElementNS(ns, "text");
    text.setAttribute("x", x);
    text.setAttribute("y", y - 4);
    text.setAttribute("text-anchor", "middle");
    text.textContent = project.name.slice(0, 24);
    const count = document.createElementNS(ns, "text");
    count.setAttribute("x", x);
    count.setAttribute("y", y + 15);
    count.setAttribute("text-anchor", "middle");
    count.classList.add("graph-count");
    count.textContent =
      project.sessions +
      (project.sessions === 1 ? " session · " : " sessions · ") +
      project.events +
      " events";
    group.append(title, rect, text, count);
    group.onmouseenter = group.onfocus = () => focus(project.id);
    group.onmouseleave = group.onblur = () => focus(state.project);
    group.onclick = () => selectProject(project.id);
    group.onkeydown = (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectProject(project.id);
      }
    };
    svg.append(group);
  }
  focus(state.project);
}
function render(data) {
  $("account").textContent = data.account?.handle || "";
  $("title").textContent = state.project ? label(state.project) : "Projects";
  $("repository").textContent =
    state.project ||
    data.projects.length +
      " projects · " +
      (data.sessionCount || 0) +
      " sessions";
  $("projects").replaceChildren();
  const entries = [
    {
      id: "",
      name: "All projects",
      events: data.projects.reduce(
        (n, p) => n + p.events,
        data.unassigned || 0,
      ),
    },
    ...data.projects,
  ];
  if (data.unassigned)
    entries.push({
      id: "unassigned",
      name: "Unassigned",
      events: data.unassigned,
    });
  for (const project of entries) {
    const button = element(
      "button",
      undefined,
      state.project === project.id ? "active" : "",
    );
    button.append(
      element("span", project.name),
      element("small", project.events),
    );
    button.onclick = () => selectProject(project.id);
    $("projects").append(button);
  }
  map(data);
  $("events").replaceChildren();
  for (const event of data.events) {
    const button = element(
        "button",
        undefined,
        "event" + (event.id === state.selected ? " active" : ""),
      ),
      top = element("div", undefined, "event-top");
    const time = element("time", new Date(event.at).toLocaleString());
    time.dateTime = event.at;
    top.append(
      element(
        "span",
        kinds[event.kind] || event.kind,
        "kind " + event.kind.replace(/[^a-z_]/gi, ""),
      ),
      element("span", names[event.agent] || event.agent),
      time,
    );
    button.append(top, element("div", event.summary, "event-summary"));
    if (!state.project)
      button.append(element("span", label(event.project), "event-project"));
    button.onclick = () => {
      state.selected = event.id;
      for (const row of $("events").children)
        row.classList.toggle("active", row === button);
      facts(event);
    };
    $("events").append(button);
  }
  $("event-count").textContent = "Latest first";
  $("empty").hidden = Boolean(data.events.length);
  $("previous").disabled = state.offset === 0;
  $("next").disabled = !data.more;
  $("page").textContent = "Page " + (Math.floor(state.offset / 50) + 1);
  const selected = data.events.find((event) => event.id === state.selected);
  if (!selected) state.selected = null;
  facts(selected || null);
  $("session-filter").hidden = !state.session;
  $("session-label").textContent = state.session;
  $("sessions").replaceChildren();
  $("session-count").textContent = data.sessionCount || 0;
  $("session-pages").hidden = !state.sessionOffset && !data.moreSessions;
  $("sessions-previous").disabled = !state.sessionOffset;
  $("sessions-next").disabled = !data.moreSessions;
  $("sessions-page").textContent =
    "Page " + (Math.floor(state.sessionOffset / 20) + 1);
  for (const session of data.sessions) {
    const button = element(
      "button",
      names[session.agent] || session.agent,
      "session",
    );
    button.append(
      element("small", session.session),
      element(
        "small",
        new Date(session.lastActivity).toLocaleString() +
          " · " +
          session.events +
          " events",
      ),
    );
    button.onclick = () => {
      state.session = session.session;
      state.agent = session.agent;
      state.offset = 0;
      load();
    };
    $("sessions").append(button);
  }
  $("connections").replaceChildren();
  for (const connection of data.connections) {
    const row = element("div", connection.name, "connection");
    row.append(element("small", connection.account || connection.provider));
    if (connection.lastRequest)
      row.append(
        element(
          "small",
          (connection.lastRequest.status
            ? "HTTP " + connection.lastRequest.status
            : "No response") +
            " · " +
            new Date(connection.lastRequest.at).toLocaleString(),
        ),
      );
    $("connections").append(row);
  }
  if (!data.connections.length)
    $("connections").append(
      element(
        "div",
        data.connectionError || "No API connections for this project.",
        "connection",
      ),
    );
  $("directories").replaceChildren(
    ...data.directories.map((directory) =>
      element("div", directory, "directory"),
    ),
  );
}
async function load() {
  request?.abort();
  request = new AbortController();
  const controller = request,
    params = new URLSearchParams();
  for (const key of [
    "project",
    "session",
    "agent",
    "audit",
    "kind",
    "query",
    "offset",
    "sessionOffset",
  ])
    if (state[key]) params.set(key, state[key]);
  try {
    const response = await fetch("data?" + params, {
      signal: controller.signal,
    });
    const data = await response.json();
    if (response.status === 401) {
      state.project = "";
      state.session = "";
      state.agent = "";
      state.selected = null;
      history.replaceState({}, "", "/workspace/");
      document.body.classList.add("signed-out");
      $("account").textContent = "";
      $("projects").replaceChildren();
      $("events").replaceChildren();
      $("reopen").hidden = false;
      $("error").hidden = true;
      return;
    }
    if (!response.ok)
      throw new Error(data.error || "ASIP could not load project history.");
    if (controller !== request) return;
    document.body.classList.remove("signed-out");
    $("reopen").hidden = true;
    $("error").hidden = true;
    render(data);
  } catch (error) {
    if (error.name === "AbortError") return;
    $("error").textContent = error.message;
    $("error").hidden = false;
  }
}
async function beacon(view) {
  try {
    const response = await fetch(
      "beacon" + (typeof view === "string" ? "?view=" + view : ""),
      { method: "POST" },
    );
    if (!response.ok) throw new Error("Reopen ASIP from Beacon.");
  } catch (error) {
    $("error").textContent = error.message;
    $("error").hidden = false;
  }
}
$("beacon").onclick = beacon;
$("reopen-workspace").onclick = async () => {
  try {
    const response = await fetch("reopen", { method: "POST" });
    if (!response.ok) throw new Error("Could not reopen ASIP.");
  } catch (error) {
    $("error").textContent = error.message;
    $("error").hidden = false;
  }
};
$("manage-connections").onclick = () => beacon("connections");
$("sessions-previous").onclick = () => {
  state.sessionOffset = Math.max(0, state.sessionOffset - 20);
  load();
};
$("sessions-next").onclick = () => {
  state.sessionOffset += 20;
  load();
};
$("refresh").onclick = load;
$("kind").onchange = () => {
  state.kind = $("kind").value;
  state.offset = 0;
  load();
};
$("clear-session").onclick = () => {
  state.session = "";
  state.agent = "";
  state.offset = 0;
  load();
};
$("audit").onchange = () => {
  state.audit = $("audit").checked;
  state.offset = 0;
  load();
};
$("previous").onclick = () => {
  state.offset = Math.max(0, state.offset - 50);
  state.selected = null;
  load();
};
$("next").onclick = () => {
  state.offset += 50;
  state.selected = null;
  load();
};
let debounce;
$("search").oninput = () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    state.query = $("search").value;
    state.offset = 0;
    load();
  }, 200);
};
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) load();
});
setInterval(() => {
  if (!document.hidden) load();
}, 15000);
load();

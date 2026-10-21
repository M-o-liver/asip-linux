const $ = (id) => document.getElementById(id);
const names = {
  codex: "Codex",
  "claude-code": "Claude Code",
  antigravity: "Antigravity",
};
let renderedAccount = "",
  formError = "",
  view = "overview",
  currentState,
  selectedPlugin,
  lastCards = "",
  lastConnections = "",
  lastRecent = "",
  lastPending = "";
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(svg.namespaceURI, "use");
  use.setAttribute("href", "#i-" + name);
  svg.append(use);
  return svg;
}
function navigate(page) {
  if (
    !["overview", "agents", "connections", "recovery", "settings"].includes(
      page,
    )
  )
    return;
  view = page;
  for (const element of document.querySelectorAll("[data-page]"))
    element.hidden = element.dataset.page !== page;
  for (const button of document.querySelectorAll("[data-nav]")) {
    button.classList.toggle("selected", button.dataset.nav === page);
    if (button.dataset.nav === page)
      button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  $("page-label").textContent = {
    overview: "Overview",
    agents: "Agents",
    connections: "API connections",
    recovery: "Recovery",
    settings: "Settings",
  }[page];
  if (page === "recovery" && currentState?.account)
    $("recovery-details").ontoggle();
  window.scrollTo(0, 0);
}
window.asip.onNavigate(navigate);
for (const button of document.querySelectorAll("[data-nav]"))
  button.onclick = () => navigate(button.dataset.nav);
$("view-agents").onclick = () => navigate("agents");
$("expand-window").onclick = () => window.asip.showFull();
$("hide-window").onclick = () => window.asip.hideWindow();
$("quit").onclick = () => window.asip.quit();
$("cloud-connect").onclick = async () => {
  try {
    await window.asip.cloudConnect();
  } catch (error) {
    $("cloud-error").textContent = error.message;
  }
};
$("cloud-open").onclick = () => window.asip.cloudOpen();
$("cloud-disconnect").onclick = () => window.asip.cloudDisconnect();
$("cloud-sync").onclick = async () => {
  try {
    await window.asip.cloudSync();
  } catch (error) {
    $("cloud-error").textContent = error.message;
  }
};
function openPluginFolder(plugin) {
  selectedPlugin = plugin;
  $("agent-setup-title").textContent = plugin.name + " plugin";
  $("setup-description").textContent =
    "ASIP keeps this folder up to date. You can use it as a source in " +
    plugin.name +
    "’s plugin manager.";
  $("plugin-directory").textContent = plugin.directory;
  $("setup-error").textContent = "";
  $("agent-setup").showModal();
}
$("close-agent-setup").onclick = () => $("agent-setup").close();
$("show-plugin-folder").onclick = () =>
  window.asip.pluginFolder(selectedPlugin.id);
$("copy-plugin-folder").onclick = async () => {
  await window.asip.copyText(selectedPlugin.directory);
};
function renderAgents(state) {
  const key = JSON.stringify([state.plugins, state.clients]);
  if (key === lastCards) return;
  lastCards = key;
  $("agent-cards").replaceChildren();
  for (const plugin of state.plugins || []) {
    const connected = state.clients.some(
      (client) => client.agent === plugin.id,
    );
    const card = document.createElement("article");
    card.className = "agent-card";
    const logo = document.createElement("div");
    logo.className = "agent-logo " + plugin.id;
    logo.append(icon(plugin.id));
    const text = document.createElement("div");
    text.className = "agent-info";
    const title = document.createElement("h3");
    title.textContent = plugin.name;
    const status = document.createElement("p");
    status.textContent = connected
      ? "Connected"
      : plugin.addedAt
        ? plugin.id === "antigravity"
          ? "Added · Restart Antigravity"
          : "Added · Open a new session"
        : "Not connected";
    status.className = connected ? "connected" : "";
    text.append(title, status);
    const actions = document.createElement("div");
    actions.className = "agent-actions";
    const install = document.createElement("button");
    install.className = connected ? "secondary" : "primary";
    install.textContent = plugin.installing
      ? "Installing…"
      : plugin.desktop
        ? "Open in ChatGPT"
        : !plugin.available
          ? "Use plugin folder"
          : plugin.addedAt || connected
            ? "Update"
            : "Install";
    install.disabled = plugin.installing;
    install.onclick = async () => {
      if (!plugin.available) {
        openPluginFolder(plugin);
        return;
      }
      install.disabled = true;
      install.textContent = "Installing…";
      try {
        const result = await window.asip.installPlugin(plugin.id);
        formError = "";
        $("agent-result").textContent = result.message;
      } catch (error) {
        formError = error.message;
        $("error").textContent = formError;
      } finally {
        lastCards = "";
        render(await window.asip.status());
      }
    };
    const folder = document.createElement("button");
    folder.className = "icon-button";
    folder.title = "Show " + plugin.name + " plugin folder";
    folder.setAttribute("aria-label", folder.title);
    folder.append(icon("folder"));
    folder.onclick = () => openPluginFolder(plugin);
    actions.append(install, folder);
    if (connected) {
      const disconnect = document.createElement("button");
      disconnect.className = "text-button disconnect";
      disconnect.textContent = "Disconnect";
      disconnect.onclick = () => window.asip.disconnect(plugin.id);
      actions.append(disconnect);
    }
    card.append(logo, text, actions);
    $("agent-cards").append(card);
  }
}
function renderRecent(state) {
  const recent = state.workspace?.recent || [],
    key = JSON.stringify(recent);
  if (key === lastRecent) return;
  lastRecent = key;
  $("recent-work").replaceChildren();
  if (!recent.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Your agents’ work will appear here.";
    $("recent-work").append(empty);
  }
  for (const event of recent) {
    const row = document.createElement("button");
    row.className = "recent-row";
    row.title =
      "Open " +
      (event.project?.split(/[\\/]/).filter(Boolean).at(-1) ||
        "unassigned work");
    row.onclick = () =>
      window.asip.openWorkspace(event.project || "unassigned");
    const marker = document.createElement("div");
    marker.className = "record-marker";
    marker.append(
      icon(
        /failed|unresolved|held|Failure/.test(event.kind)
          ? "recovery"
          : "check",
      ),
    );
    const text = document.createElement("div"),
      summary = document.createElement("p"),
      meta = document.createElement("span");
    summary.textContent = event.summary;
    meta.textContent =
      (names[event.agent] || event.agent) +
      " · " +
      (event.project?.split(/[\\/]/).filter(Boolean).at(-1) || "Unassigned") +
      " · " +
      new Date(event.at).toLocaleString(undefined, {
        dateStyle: "short",
        timeStyle: "short",
      });
    text.append(summary, meta);
    row.append(marker, text);
    $("recent-work").append(row);
  }
}
function resetConnectionForm() {
  formError = "";
  $("connection-form").reset();
  $("connection-name").readOnly = false;
  $("connection-provider").disabled = false;
  $("connection-credential").placeholder = "";
  $("connection-custom").hidden = true;
  $("connection-github").hidden = true;
  $("connection-credential-label").hidden = false;
  $("connection-credential").required = true;
  $("connection-save").hidden = false;
  $("connection-project-label").hidden = true;
  $("connection-projects").required = false;
}
function render(state) {
  currentState = state;
  document.body.dataset.panel = String(Boolean(state.panel));
  document.body.dataset.platform = state.platform;
  $("expand-window").hidden = !state.panel;
  $("hide-window").hidden = !state.panel;
  const accountKey = state.account
    ? state.account.provider + ":" + state.account.handle
    : "";
  if (accountKey !== renderedAccount) {
    $("agent-setup").close();
    resetConnectionForm();
    $("connection-details").open = false;
    $("connection-projects").replaceChildren();
    $("recovery-list").replaceChildren();
    lastCards = "";
    lastConnections = "";
    lastRecent = "";
    renderedAccount = accountKey;
  }
  if (state.pending?.id && lastPending !== state.pending.id) {
    navigate("overview");
    $("agent-setup").close();
  }
  lastPending = state.pending?.id || "";
  $("signed-out").hidden = Boolean(state.account);
  $("account").hidden = !state.account;
  $("overview").classList.toggle("onboarding", Boolean(state.pending));
  $("signout").hidden = !state.account;
  $("request").hidden = !state.pending;
  $("connection-details").hidden = !state.account;
  $("recovery-details").hidden = !state.account;
  $("error").textContent = state.error || formError;
  $("launch-at-login").checked = state.launchAtLogin;
  $("launch-at-login").disabled = !state.installed;
  $("progress").textContent = state.signingIn ? "Waiting for sign-in…" : "";
  $("signin-cancel").hidden = !state.signingIn;
  $("connection-github-signin").disabled =
    state.signingIn || !state.providers.github;
  for (const provider of ["google", "github"])
    $(provider).disabled = state.signingIn || !state.providers[provider];
  $("preview").hidden = state.providers.google || state.providers.github;
  $("sidebar-status").textContent = state.online
    ? "Service running"
    : "Service unavailable";
  document.body.classList.toggle("offline", !state.online);
  $("overview-caption").textContent = !state.online
    ? "Service unavailable"
    : state.clients.length
      ? state.clients.length +
        " agent" +
        (state.clients.length === 1 ? "" : "s") +
        " connected"
      : "Service running";
  $("account-name").textContent = state.account?.name || "ASIP account";
  $("account-handle").textContent = state.account?.handle || "Signed out";
  $("build-version").textContent =
    "ASIP " +
    (state.build?.version || "") +
    " · " +
    (state.build?.revision || "development").slice(0, 8) +
    (state.build?.dirty ? " (development)" : "");
  $("metric-projects").textContent = state.workspace?.projects || 0;
  $("metric-agents").textContent = state.clients.length;
  $("metric-records").textContent = state.records;
  $("cloud-connect").hidden = state.cloud?.connected && !state.cloud?.error;
  $("cloud-connect").disabled = Boolean(state.cloud?.connecting);
  $("cloud-connect").textContent = state.cloud?.connecting
    ? "Finish in browser…"
    : state.cloud?.connected
      ? "Reconnect cloud"
      : "Connect cloud";
  $("cloud-actions").hidden = !state.cloud?.connected;
  $("cloud-sync").disabled = Boolean(state.cloud?.syncing);
  $("cloud-status").textContent = state.cloud?.syncing
    ? "Synchronizing… · " +
      (state.cloud.sent || 0).toLocaleString() +
      " sent · " +
      (state.cloud.received || 0).toLocaleString() +
      " received"
    : state.cloud?.connected
      ? (state.cloud.pending
          ? state.cloud.pending.toLocaleString() + " records waiting · "
          : "") +
        "Connected as " +
        state.cloud.account +
        (state.cloud.lastSync
          ? " · Synced " + new Date(state.cloud.lastSync).toLocaleTimeString()
          : " · Ready to sync")
      : "Keep your project memory across computers.";
  $("cloud-error").textContent = state.cloud?.error || "";
  $("project-count").textContent =
    (state.workspace?.projects || 0) +
    (state.workspace?.projects === 1 ? " project · " : " projects · ") +
    state.records +
    (state.records === 1 ? " record" : " records");
  if (state.pending) {
    $("request-title").textContent =
      (state.account ? "Connect " : "Sign in to connect ") +
      names[state.pending.agent];
    $("request-account").textContent =
      state.account?.handle || "Choose Google or GitHub below.";
    $("connect").hidden = !state.account;
  }
  $("device").hidden = !state.deviceCode;
  $("device-code").textContent = state.deviceCode?.code || "";
  renderAgents(state);
  renderRecent(state);
  const connectionKey = JSON.stringify(state.connections || []);
  if (lastConnections !== connectionKey) {
    lastConnections = connectionKey;
    $("connection-list").replaceChildren();
    for (const connection of state.connections || []) {
      const row = document.createElement("div");
      row.className = "client";
      const text = document.createElement("span");
      const description = document.createElement("span");
      description.textContent =
        connection.name +
        " · " +
        (connection.label ||
          connection.account ||
          (connection.provider === "secret"
            ? "Signing secret"
            : connection.provider));
      const status = document.createElement("small");
      const last = connection.lastRequest;
      status.className = "connection-status";
      status.textContent =
        connection.provider === "secret"
          ? "Stored signing secret"
          : !last
            ? "Not checked yet"
            : last.error
              ? "No response · Check connection"
              : [401, 403].includes(last.status)
                ? "Access rejected · HTTP " + last.status
                : "Last response · HTTP " + last.status;
      status.classList.toggle(
        "attention",
        Boolean(last && (last.error || last.status >= 400)),
      );
      if (last) status.title = new Date(last.at).toLocaleString();
      text.append(description, status);
      const remove = document.createElement("button");
      remove.textContent = "Remove";
      remove.onclick = async () => {
        try {
          await window.asip.removeConnection(connection.name);
        } catch (error) {
          $("error").textContent = error.message;
        }
      };
      const edit = document.createElement("button");
      edit.textContent = "Edit";
      edit.onclick = async () => {
        resetConnectionForm();
        $("connection-details").open = true;
        $("connection-name").value = connection.name;
        $("connection-name").readOnly = true;
        $("connection-provider").value = connection.provider;
        $("connection-provider").disabled = connection.provider !== "secret";
        $("connection-origin").value = connection.origin;
        $("connection-header").value = connection.header;
        $("connection-custom").hidden = connection.provider !== "custom";
        $("connection-credential").required = false;
        $("connection-credential").placeholder =
          "Leave empty to keep current key";
        $("connection-all-projects").checked = !connection.projects.length;
        $("connection-all-projects").onchange();
        await loadProjects(connection.projects);
        $("connection-form").scrollIntoView({ block: "nearest" });
      };
      const actions = document.createElement("div");
      actions.className = "buttons";
      if (connection.canCheck) {
        const check = document.createElement("button");
        check.textContent = "Check";
        check.onclick = async () => {
          check.disabled = true;
          check.textContent = "Checking…";
          try {
            await window.asip.checkConnection(connection.name);
          } catch (error) {
            $("connection-import-result").textContent = error.message;
          } finally {
            render(await window.asip.status());
            check.disabled = false;
            check.textContent = "Check";
          }
        };
        actions.append(check);
      }
      actions.append(edit, remove);
      row.append(text, actions);
      $("connection-list").append(row);
    }
  }
}
$("import-connections").onclick = async () => {
  $("import-connections").disabled = true;
  try {
    const result = await window.asip.importConnections();
    if (result)
      $("connection-import-result").textContent =
        result.imported.length + " connections imported and verified.";
  } catch (error) {
    $("connection-import-result").textContent = error.message;
  } finally {
    $("import-connections").disabled = false;
  }
};
for (const id of ["google"]) $(id).onclick = () => window.asip.signIn("google");
for (const id of ["github"]) $(id).onclick = () => window.asip.signIn("github");
$("launch-at-login").onchange = async () => {
  try {
    formError = "";
    render(await window.asip.startup($("launch-at-login").checked));
  } catch (error) {
    formError = error.message;
    $("error").textContent = formError;
  }
};
$("cancel").onclick = () => window.asip.cancel();
$("signin-cancel").onclick = () => window.asip.cancel();
$("connect").onclick = () => window.asip.connect();
$("connection-provider").onchange = () => {
  $("connection-custom").hidden = $("connection-provider").value !== "custom";
  $("connection-github").hidden = $("connection-provider").value !== "github";
  const github = $("connection-provider").value === "github";
  $("connection-credential-label").hidden = github;
  $("connection-credential").required = !github;
  $("connection-save").hidden = github;
};
$("connection-github-token").onclick = () => {
  $("connection-github").hidden = true;
  $("connection-credential-label").hidden = false;
  $("connection-credential").required = true;
  $("connection-save").hidden = false;
};
$("connection-github-signin").onclick = async () => {
  if (!$("connection-name").reportValidity()) return;
  if (!$("connection-projects").reportValidity()) return;
  try {
    const result = await window.asip.githubConnection({
      name: $("connection-name").value.trim(),
      scope: $("connection-github-scope").value,
      projects: $("connection-all-projects").checked
        ? []
        : [...$("connection-projects").selectedOptions].map(
            (option) => option.value,
          ),
    });
    if (!result.error) resetConnectionForm();
  } catch (error) {
    $("error").textContent = error.message;
  }
};
$("connection-all-projects").onchange = () => {
  $("connection-project-label").hidden = $("connection-all-projects").checked;
  $("connection-projects").required = !$("connection-all-projects").checked;
};
async function loadProjects(selected = []) {
  try {
    const projects = await window.asip.projects();
    $("connection-projects").replaceChildren();
    for (const project of projects) {
      const option = document.createElement("option");
      option.value = project.id;
      option.selected = selected.includes(project.id);
      option.textContent =
        project.name + " · " + project.id.split(/[\\/]/).slice(0, -1).join("/");
      $("connection-projects").append(option);
    }
  } catch (error) {
    formError = error.message;
    $("error").textContent = formError;
  }
}
$("connection-details").ontoggle = async () => {
  if (!$("connection-details").open || $("connection-name").readOnly) return;
  await loadProjects();
};
$("connection-cancel").onclick = () => {
  resetConnectionForm();
  $("connection-details").open = false;
};
$("connection-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await window.asip.saveConnection({
      name: $("connection-name").value.trim(),
      provider: $("connection-provider").value,
      credential: $("connection-credential").value,
      origin: $("connection-origin").value.trim(),
      header: $("connection-header").value.trim(),
      projects: $("connection-all-projects").checked
        ? []
        : [...$("connection-projects").selectedOptions].map(
            (option) => option.value,
          ),
    });
    resetConnectionForm();
  } catch (error) {
    $("error").textContent = error.message;
  }
};
$("signout").onclick = () => window.asip.signOut();
$("open-workspace").onclick = () => window.asip.openWorkspace();
$("import-history").onclick = async () => {
  $("import-history").disabled = true;
  try {
    const result = await window.asip.importHistory();
    if (result)
      $("import-result").textContent = result.alreadyImported
        ? "This history is already imported."
        : "Imported " +
          result.projects +
          " projects and " +
          result.events +
          " events.";
  } catch (error) {
    $("error").textContent = error.message;
  } finally {
    $("import-history").disabled = false;
  }
};
function renderRecovery(records) {
  $("recovery-list").replaceChildren();
  for (const record of records) {
    const row = document.createElement("div"),
      label = document.createElement("span"),
      button = document.createElement("button");
    row.className = "client";
    label.textContent =
      new Date(record.at).toLocaleString() + " · " + record.events + " events";
    button.textContent = "Restore";
    button.onclick = async () => {
      try {
        renderRecovery(await window.asip.recoveryRestore(record.id));
      } catch (error) {
        formError = error.message;
        $("error").textContent = formError;
      }
    };
    row.append(label, button);
    $("recovery-list").append(row);
  }
}
$("recovery-details").ontoggle = async () => {
  if (!$("recovery-details").open) return;
  try {
    renderRecovery(await window.asip.recoveryList());
  } catch (error) {
    formError = error.message;
    $("error").textContent = formError;
  }
};
$("recovery-save").onclick = async () => {
  try {
    formError = "";
    renderRecovery(await window.asip.recoverySave());
  } catch (error) {
    formError = error.message;
    $("error").textContent = formError;
  }
};
window.asip.onStatus(render);
window.asip.status().then((state) => {
  render(state);
  navigate("overview");
});

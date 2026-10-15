const $ = (id) => document.getElementById(id);
const names = {
  codex: "Codex",
  "claude-code": "Claude Code",
  antigravity: "Antigravity",
};
let platform,
  connectedAgents = [],
  renderedAccount = "",
  formError = "";
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
  platform = state.platform;
  const accountKey = state.account
    ? state.account.provider + ":" + state.account.handle
    : "";
  if (accountKey !== renderedAccount) {
    $("agent-setup").close();
    $("install-steps").hidden = true;
    $("install-command").textContent = "";
    $("setup-error").textContent = "";
    resetConnectionForm();
    $("connection-details").open = false;
    $("connection-custom").hidden = true;
    $("connection-github").hidden = true;
    $("connection-project-label").hidden = true;
    $("connection-projects").replaceChildren();
    $("recovery-details").open = false;
    $("recovery-list").replaceChildren();
    renderedAccount = accountKey;
  }
  $("signed-out").hidden = Boolean(state.account) || Boolean(state.pending);
  $("account").hidden = !state.account || Boolean(state.pending);
  $("agents").hidden = !state.account || Boolean(state.pending);
  $("signout").hidden = !state.account || Boolean(state.pending);
  if (state.pending) $("agent-setup").close();
  $("request").hidden = !state.pending;
  $("connections").hidden = !state.account || Boolean(state.pending);
  $("recovery").hidden = !state.account || Boolean(state.pending);
  $("connection-list").replaceChildren();
  for (const connection of state.connections || []) {
    const row = document.createElement("div");
    row.className = "client";
    const text = document.createElement("span");
    text.textContent =
      connection.name + " · " + (connection.account || connection.provider);
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
      $("connection-provider").disabled = true;
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
    actions.append(edit, remove);
    row.append(text, actions);
    $("connection-list").append(row);
  }
  $("error").textContent = state.error || formError;
  $("launch-at-login").checked = state.launchAtLogin;
  $("launch-at-login").disabled = !state.installed;
  $("progress").textContent = state.signingIn ? "Waiting for sign-in…" : "";
  $("signin-cancel").hidden = !state.signingIn;
  $("connection-github-signin").disabled =
    state.signingIn || !state.providers.github;
  for (const id of ["google"])
    $(id).disabled = state.signingIn || !state.providers.google;
  for (const id of ["github"])
    $(id).disabled = state.signingIn || !state.providers.github;
  $("preview").hidden = state.providers.google || state.providers.github;
  if (state.account) {
    connectedAgents = state.clients.map((client) => client.agent);
    $("account-name").textContent = state.account.name;
    $("account-handle").textContent = state.account.handle;
    $("connection-state").textContent = state.clients.length
      ? ""
      : "No agents connected";
    $("connection-state").hidden = Boolean(state.clients.length);
    $("record-count").textContent = state.clients.length
      ? state.records + " recorded events"
      : "";
    $("clients").replaceChildren();
    for (const client of state.clients) {
      const row = document.createElement("div");
      row.className = "client";
      const label = document.createElement("span");
      label.textContent = names[client.agent] || client.agent;
      const disconnect = document.createElement("button");
      disconnect.textContent = "Disconnect";
      disconnect.onclick = () => window.asip.disconnect(client.agent);
      row.append(label, disconnect);
      $("clients").append(row);
    }
  }
  if (state.pending) {
    $("request-title").textContent = "Connect " + names[state.pending.agent];
    $("request-account").textContent = state.pending.account;
  }
  $("device").hidden = !state.deviceCode;
  $("device-code").textContent = state.deviceCode?.code || "";
}
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
        project.name + " · " + project.id.split("/").slice(0, -1).join("/");
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
$("add-agent").onclick = () => {
  if ($("install-steps").hidden)
    $("agent").value =
      Object.keys(names).find((agent) => !connectedAgents.includes(agent)) ||
      "codex";
  $("agent-setup").showModal();
};
$("close-agent-setup").onclick = () => $("agent-setup").close();
$("agent").onchange = () => {
  $("install-steps").hidden = true;
  $("install-command").textContent = "";
  $("setup-error").textContent = "";
  $("copy-install").textContent = "Copy commands";
};
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
$("export").onclick = async () => {
  $("export").disabled = true;
  $("agent").disabled = true;
  $("setup-error").textContent = "";
  try {
    const agent = $("agent").value,
      directory = await window.asip.exportPlugin(agent);
    if (!directory) return;
    const quoted =
      platform === "win32"
        ? "'" + directory.replaceAll("'", "''") + "'"
        : "'" + directory.replaceAll("'", "'\\''") + "'";
    $("install-command").textContent =
      agent === "codex"
        ? "codex plugin marketplace add " +
          quoted +
          "\ncodex plugin add asip@asip-local"
        : agent === "claude-code"
          ? "claude plugin marketplace add " +
            quoted +
            "\nclaude plugin install asip@asip-local"
          : "agy plugin install " + quoted;
    $("install-title").textContent = "2. Install in " + names[agent];
    $("install-shell").textContent =
      platform === "win32" ? "Run in PowerShell:" : "Run in a terminal:";
    $("install-reload").textContent =
      "Then start a new " + names[agent] + " session.";
    $("install-connect").textContent =
      "Ask " +
      names[agent] +
      " to “Connect ASIP”, then click Connect in Beacon.";
    $("install-hooks").hidden = agent !== "codex";
    $("copy-install").textContent = "Copy commands";
    $("install-steps").hidden = false;
    $("install-title").scrollIntoView({ block: "nearest" });
  } catch (error) {
    $("setup-error").textContent = error.message;
  } finally {
    $("export").disabled = false;
    $("agent").disabled = false;
  }
};
$("copy-install").onclick = async () => {
  try {
    await window.asip.copyText($("install-command").textContent);
    $("copy-install").textContent = "Copied";
  } catch (error) {
    $("setup-error").textContent = error.message;
  }
};
window.asip.onStatus(render);
window.asip.status().then(render);

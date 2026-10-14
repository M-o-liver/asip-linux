const $ = (id) => document.getElementById(id);
const names = {
  codex: "Codex",
  "claude-code": "Claude Code",
  antigravity: "Antigravity",
};
let platform,
  renderedAccount = "";
function resetConnectionForm() {
  $("connection-form").reset();
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
    resetConnectionForm();
    $("connection-details").open = false;
    $("connection-custom").hidden = true;
    $("connection-github").hidden = true;
    $("connection-project-label").hidden = true;
    $("connection-projects").replaceChildren();
    renderedAccount = accountKey;
  }
  $("signed-out").hidden = Boolean(state.account) || Boolean(state.pending);
  $("account").hidden = !state.account || Boolean(state.pending);
  $("request").hidden = !state.pending;
  $("connections").hidden = !state.account || Boolean(state.pending);
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
    row.append(text, remove);
    $("connection-list").append(row);
  }
  $("error").textContent = state.error || "";
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
    $("account-name").textContent = state.account.name;
    $("account-handle").textContent = state.account.handle;
    $("connection-state").textContent = state.clients.length
      ? "Connected plugins"
      : "No plugins connected";
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
$("connection-details").ontoggle = async () => {
  if (!$("connection-details").open) return;
  try {
    const projects = await window.asip.projects();
    $("connection-projects").replaceChildren();
    for (const project of projects) {
      const option = document.createElement("option");
      option.value = project.id;
      option.textContent =
        project.name + " · " + project.id.split("/").slice(0, -1).join("/");
      $("connection-projects").append(option);
    }
  } catch (error) {
    $("error").textContent = error.message;
  }
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
$("export").onclick = async () => {
  try {
    const agent = $("agent").value,
      directory = await window.asip.exportPlugin(agent);
    if (!directory) return;
    const quoted =
      platform === "win32"
        ? "'" + directory.replaceAll("'", "''") + "'"
        : "'" + directory.replaceAll("'", "'\\''") + "'";
    $("install-command").textContent =
      (platform === "win32" ? "# PowerShell\n" : "") +
      (agent === "codex"
        ? "codex plugin marketplace add " +
          quoted +
          "\ncodex plugin add asip@asip-local"
        : agent === "claude-code"
          ? "claude plugin marketplace add " +
            quoted +
            "\nclaude plugin install asip@asip-local"
          : "agy plugin install " + quoted);
  } catch (error) {
    $("error").textContent = error.message;
  }
};
window.asip.onStatus(render);
window.asip.status().then(render);

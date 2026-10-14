const $ = (id) => document.getElementById(id);
const names = {
  codex: "Codex",
  "claude-code": "Claude Code",
  antigravity: "Antigravity",
};
let platform;
function render(state) {
  platform = state.platform;
  $("signed-out").hidden = Boolean(state.account) || Boolean(state.pending);
  $("account").hidden = !state.account || Boolean(state.pending);
  $("request").hidden = !state.pending;
  $("error").textContent = state.error || "";
  $("progress").textContent = state.signingIn ? "Waiting for sign-in…" : "";
  for (const id of ["google", "request-google"])
    $(id).disabled = state.signingIn || !state.providers.google;
  for (const id of ["github", "request-github"])
    $(id).disabled = state.signingIn || !state.providers.github;
  $("request-google").hidden = state.pending?.provider === "github";
  $("request-github").hidden = state.pending?.provider === "google";
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
    $("request-account").textContent = "Sign in as " + state.pending.account;
  }
  $("device").hidden = !state.deviceCode;
  $("device-code").textContent = state.deviceCode?.code || "";
}
for (const id of ["google", "request-google"])
  $(id).onclick = () => window.asip.signIn("google");
for (const id of ["github", "request-github"])
  $(id).onclick = () => window.asip.signIn("github");
$("cancel").onclick = () => window.asip.cancel();
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

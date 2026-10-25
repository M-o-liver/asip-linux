const status = document.querySelector("#signin-status");
const params = new URLSearchParams(location.search);
const returnPath = params.get("return");
for (const link of document.querySelectorAll("[data-provider]")) {
  if (returnPath?.startsWith("/connect?"))
    link.href += "?return=" + encodeURIComponent(returnPath);
}
if (params.has("auth_error")) status.textContent = params.get("auth_error");
async function load() {
  const response = await fetch("/api/config");
  if (!response.ok)
    throw Error("Sign-in is temporarily unavailable. Please try again.");
  const config = await response.json();
  for (const link of document.querySelectorAll("[data-provider]")) {
    if (!config.providers[link.dataset.provider]) link.hidden = true;
  }
  if (!config.providers.google && !config.providers.github)
    status.textContent =
      "Sign-in is temporarily unavailable. Please try again.";
  const me = await fetch("/api/v1/me");
  if (me.ok) {
    const account = await me.json();
    const open = document.querySelector("#open-workspace");
    open.hidden = false;
    open.href = returnPath?.startsWith("/connect?")
      ? returnPath
      : account.workspace;
    const nav = document.querySelector("#account-link");
    nav.textContent = "Your memory ↗";
    nav.href = open.href;
  }
}
load().catch((error) => {
  status.textContent = error.message;
});

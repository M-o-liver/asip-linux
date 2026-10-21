const params = new URLSearchParams(location.search),
  error = document.querySelector("#error"),
  approve = document.querySelector("#approve"),
  consent = document.querySelector("#consent");
let ready = false;
document.querySelector("#computer").textContent =
  params.get("label") + " · " + params.get("platform");
document.querySelector("#local-account").textContent =
  params.get("account") || "Beacon account";
consent.onchange = () => {
  approve.disabled = !ready || !consent.checked;
};
async function init() {
  try {
    if (!/^[a-f0-9]{64}$/.test(params.get("challenge") || ""))
      throw Error("Start this connection from Beacon.");
    const r = await fetch("/api/v1/me");
    if (r.status === 401) {
      location.replace(
        "/auth/access?return=" +
          encodeURIComponent(location.pathname + location.search),
      );
      return;
    }
    const d = await r.json();
    if (!r.ok) throw Error(d.error);
    document.querySelector("#owner").textContent =
      d.account.name + " · " + d.account.handle;
    ready = true;
    consent.onchange();
  } catch (e) {
    error.textContent = e.message;
  }
}
approve.onclick = async () => {
  approve.disabled = true;
  error.textContent = "";
  try {
    const response = await fetch("/api/v1/devices/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(params)),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error);
    const form = document.createElement("form");
    form.method = "POST";
    form.action = result.redirect;
    for (const name of ["code", "state", "access"]) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = result[name];
      form.append(input);
    }
    document.body.append(form);
    form.submit();
  } catch (e) {
    error.textContent = e.message;
    approve.disabled = false;
  }
};
init();

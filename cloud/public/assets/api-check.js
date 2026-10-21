// Exercise the same HTTP and MCP interfaces an external agent uses.
export async function checkConnection(token, assigned = [], fetcher = fetch) {
  if (!/^asip_[a-f0-9]{64}$/.test(token))
    throw Error("Use an ASIP bearer token.");
  const headers = {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  };
  async function call(path, body) {
    const response = await fetcher(path, {
      method: body ? "POST" : "GET",
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || "Connection check failed.");
    if (result.error || result.result?.isError)
      throw Error("The MCP request failed.");
    return result;
  }
  const me = await call("/api/v1/me"),
    catalogue = await call("/api/v1/projects");
  if (
    assigned.length &&
    catalogue.projects.some((p) => !assigned.includes(p.id))
  )
    throw Error(
      "The connection returned a project outside its selected scope.",
    );
  if (assigned.length) {
    const denied = await fetcher(
      "/api/v1/events?project=" +
        encodeURIComponent("asip:unassigned-connection-check"),
      { headers },
    );
    if (denied.status !== 403)
      throw Error("The project restriction check failed.");
  }
  const project = catalogue.projects[0]?.id,
    history = await call(
      "/api/v1/events?limit=1" +
        (project ? "&project=" + encodeURIComponent(project) : ""),
    ),
    record = history.events[0];
  if (record) {
    const response = await fetcher(
      "/api/v1/events/" + encodeURIComponent(record.id) + "/source",
      { headers },
    );
    if (!response.ok) throw Error("The source record could not be retrieved.");
    const raw = await response.arrayBuffer(),
      digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", raw))]
        .map((n) => n.toString(16).padStart(2, "0"))
        .join("");
    if (
      digest !== record.sha256 ||
      JSON.parse(new TextDecoder().decode(raw)).id !== record.id
    )
      throw Error("The source record failed its integrity check.");
  }
  const rpc = (id, method, params) =>
    call("/mcp", { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
  const initialized = await rpc(1, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "ASIP connection check", version: "1" },
  });
  if (initialized.result?.serverInfo?.name !== "asip-cloud")
    throw Error("The MCP service did not initialize.");
  const tools = await rpc(2, "tools/list"),
    recalled = await rpc(3, "tools/call", {
      name: "asip_recall",
      arguments: project ? { project } : {},
    });
  const memory = JSON.parse(
    recalled.result.content.find((c) => c.type === "text").text,
  );
  if (!Array.isArray(memory.events))
    throw Error("MCP recall did not return project memory.");
  return {
    account: me.account.handle,
    projects: catalogue.projects.map((p) => p.id),
    record: record?.id || null,
    sourceVerified: Boolean(record),
    write: tools.result.tools.some((t) => t.name === "asip_record"),
  };
}

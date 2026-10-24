export function setupState(
  { devices = [], recordCount = 0, agents = [] },
  clock = Date.now(),
) {
  const connected = devices.some(
    (d) => !d.revoked_at && Date.parse(d.expires_at) > clock,
  );
  const recorded = recordCount > 0;
  const observedAgent = agents.some((a) =>
    ["codex", "claude-code", "antigravity"].includes(a.id),
  );
  return {
    connected,
    recorded,
    observedAgent,
    title: recorded
      ? "Your work has a memory."
      : connected
        ? "Ready for your first memory."
        : "Connect your first computer.",
    description: recorded
      ? "Saved work is available to your connected agents. Ask ASIP to recall a project before continuing."
      : connected
        ? "Your computer is authorized. Connect an agent in Beacon, then ask it to save a decision."
        : "Install Beacon, sign in, and choose Connect cloud to bring your project memory here.",
    steps: [
      {
        done: connected,
        title: "Connect Beacon",
        text: connected
          ? "A computer is authorized to sync."
          : "Install Beacon, sign in, then choose Connect cloud.",
        href: "/download",
        action: "Get Beacon",
      },
      {
        done: observedAgent,
        title: "Connect an agent",
        text: observedAgent
          ? "Agent activity has reached your cloud memory."
          : "In Beacon → Agents, choose your agent. Approve its connection and recording hooks.",
        href: "/download#connect-agent",
        action: "Setup guide",
      },
      {
        done: recorded,
        title: "Save your first memory",
        text: recorded
          ? "A saved record is available in your account."
          : "Ask your connected agent to save a decision and the next step.",
      },
    ],
  };
}

export function recallPrompt(project) {
  return (
    "Use ASIP to recall the project " +
    project +
    ". Summarize the latest decisions, verified results, and unfinished work. Check the recorded evidence before suggesting the next step."
  );
}

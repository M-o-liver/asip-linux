export function continuityState(state) {
  if (!state.online)
    return {
      tone: "attention",
      title: "Beacon needs attention",
      detail: "The local service is unavailable. Reopen Beacon to reconnect.",
      action: "agents",
    };
  if (!state.account)
    return {
      tone: "setup",
      title: "Give your work a memory.",
      detail: "Sign in, then connect your first agent.",
      action: "signin",
    };
  if (!state.clients?.length)
    return {
      tone: "setup",
      title: "Connect your first agent.",
      detail: "Choose an agent below to start saving work to this computer.",
      action: "agents",
    };
  const cloud = state.cloud || {};
  if (cloud.reconnectRequired)
    return {
      tone: "attention",
      title: "Reconnect cloud",
      detail:
        "Local recording is available. Reconnect to resume sharing memory across computers.",
      action: "cloud",
    };
  if (cloud.error)
    return {
      tone: "attention",
      title: "Cloud sync needs attention",
      detail: "Local recording is available. " + cloud.error,
      action: "cloud",
    };
  if (!cloud.connected)
    return {
      tone: "local",
      title: "Ready on this computer.",
      detail:
        "Your agents can save and recall locally. Connect cloud to carry your memory to other computers.",
      action: "cloud",
    };
  if (cloud.syncing || cloud.pending)
    return {
      tone: "syncing",
      title: "Your memory is catching up.",
      detail: cloud.pending
        ? cloud.pending.toLocaleString() +
          " records waiting to sync. Local recording is available."
        : "Syncing saved work across your connected computers.",
      action: "memory",
    };
  return {
    tone: "ready",
    title: state.records
      ? "Ready for your next session."
      : "Ready for your first memory.",
    detail: state.records
      ? "Your agents are connected. Ask ASIP to recall your project before you continue."
      : "Ask your agent to save a decision, then recall it in a new session.",
    action: "memory",
  };
}

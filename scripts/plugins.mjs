import fs from "node:fs";
import path from "node:path";
const version = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

const description = "Recall project work and record what your agent does.";
const skill = `---
name: asip
description: Connect ASIP, recall earlier project work, and save intentions, results, evidence, and unfinished work.
---

ASIP opens its account connection when this plugin first starts. Use asip_status to check it. If the user asks to reconnect, call asip_connect and tell them to finish the connection in Beacon.
If Beacon is missing or the plugin is disconnected, explain the reported status and continue the user's work. Do not configure agent hooks or MCP servers yourself.
Tools may be namespaced or loaded on demand. Use the client's native MCP discovery to load ASIP's tool schemas before reporting that its tools are unavailable.

In Codex CLI, automatic recording also requires reviewing ASIP's hooks in /hooks. Use Codex's native hook manager; do not edit hook trust files or bypass hook review.

Once connected, call asip_recall when continuing work on a project. Use the repository identity returned by asip_status or provide the project's repository identity.
Before meaningful project work, use asip_record to save the intended task. Afterward save the result, supporting evidence, and anything unresolved. Codex supplies its calling thread automatically. Other clients should use the native ASIP context injected by their hooks, or the current session returned by asip_status. Never borrow lastSession from another conversation. Describe what happened and include verification or paths that support the result. Do not claim success without evidence. Hooks collect tool activity; avoid repeating each tool call as a manual record.

Use asip_projects to find recorded projects and asip_connections to find their named API access. Use asip_api_request with the connection name and an API path. Include the current project and session when the client does not supply them. If a connection is missing, direct the user to API connections in Beacon. Credentials are entered there, never in chat.
`;

export function buildPlugin({ root, target, agent, binary }) {
  const directory = path.join(
    root,
    "build",
    "plugins",
    target,
    "asip-" + agent,
  );
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(path.join(directory, "bin"), { recursive: true });
  const name = path.basename(binary),
    executable = path.join(directory, "bin", name);
  fs.copyFileSync(binary, executable);
  fs.chmodSync(executable, 0o755);
  const write = (file, data) => {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(
      path.join(directory, file),
      typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n",
    );
  };
  write("skills/asip/SKILL.md", skill);
  fs.mkdirSync(path.join(directory, "assets"), { recursive: true });
  fs.copyFileSync(
    path.join(root, "beacon", "icon.png"),
    path.join(directory, "assets", "icon.png"),
  );
  write(
    "skills/setup/SKILL.md",
    "---\nname: setup\ndescription: Connect the ASIP plugin.\n---\n\nCall asip_status first. If already connected, report it. Otherwise call asip_connect and tell the user to finish sign-in or click Connect in ASIP Beacon. Use asip_status to check the connection when they return.\n",
  );
  const variable =
    agent === "claude-code" ? "${CLAUDE_PLUGIN_ROOT}" : "${PLUGIN_ROOT}";
  const command = variable + "/bin/" + name;
  const server = { command, args: ["mcp", "--agent", agent] };
  const events =
    agent === "antigravity"
      ? ["SessionStart", "PreToolUse", "PostToolUse", "Stop"]
      : [
          "SessionStart",
          "UserPromptSubmit",
          "PreToolUse",
          "PostToolUse",
          "Stop",
          "SubagentStart",
          "SubagentStop",
          "SessionEnd",
          ...(agent === "claude-code"
            ? ["PostToolUseFailure", "StopFailure"]
            : ["Interrupt"]),
        ];
  const hooks = {};
  for (const event of events) {
    const handler = {
      type: "command",
      command: '"' + command + '" hook --agent ' + agent + " --event " + event,
      timeout:
        agent === "codex" && ["SessionEnd", "Interrupt"].includes(event)
          ? 3
          : 8,
      statusMessage: "ASIP activity",
    };
    if (agent === "claude-code") {
      handler.command = command;
      handler.args = ["hook", "--agent", agent, "--event", event];
    }
    if (agent === "codex" && target.startsWith("win32-"))
      handler.commandWindows =
        '& "' + command + '" hook --agent codex --event ' + event;
    hooks[event] =
      agent === "antigravity" && ["SessionStart", "Stop"].includes(event)
        ? [handler]
        : [{ hooks: [handler] }];
  }
  if (agent === "claude-code") {
    write(".claude-plugin/plugin.json", {
      name: "asip",
      version,
      description,
      author: { name: "ASIP" },
      homepage: "https://github.com/M-o-liver/asip-linux",
    });
    write(".claude-plugin/marketplace.json", {
      name: "asip",
      description,
      owner: { name: "ASIP" },
      plugins: [{ name: "asip", source: "./", description, version }],
    });
    write(".mcp.json", { mcpServers: { asip: server } });
    write("hooks/hooks.json", { hooks });
  } else if (agent === "codex") {
    // Codex 0.162.1 skips hooks for portable Agent Plugins manifests.
    // Use its native layout so actual lifecycle events reach ASIP.
    write(".codex-plugin/plugin.json", {
      name: "asip",
      version,
      description,
      skills: "./skills/",
      mcpServers: "./.mcp.json",
      hooks: "./hooks/hooks.json",
      extensions: {
        "com.openai": { onboardingSkill: "./skills/setup/SKILL.md" },
      },
      interface: {
        displayName: "ASIP",
        shortDescription: "Project history and API connections.",
        developerName: "ASIP",
        category: "Productivity",
        composerIcon: "./assets/icon.png",
        logo: "./assets/icon.png",
      },
    });
    write(".mcp.json", {
      mcpServers: {
        asip: { command: "./bin/" + name, args: server.args, cwd: "." },
      },
    });
    write("hooks/hooks.json", { hooks });
    write(".agents/plugins/marketplace.json", {
      name: "asip",
      interface: { displayName: "ASIP" },
      plugins: [
        {
          name: "asip",
          source: { source: "local", path: "./" },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Productivity",
        },
      ],
    });
  } else {
    // Antigravity does not document a plugin-root substitution. Bind the
    // commands to the exported bundle, rather than inventing one.
    write("plugin.json", { name: "asip", description });
    write("mcp_config.json", {
      mcpServers: { asip: { command: executable, args: server.args } },
    });
    for (const event of events) {
      for (const group of hooks[event])
        for (const handler of group.hooks || [group])
          handler.command =
            '"' + executable + '" hook --agent ' + agent + " --event " + event;
    }
    write("hooks.json", { asip: hooks });
  }
  write(
    "README.md",
    `# ASIP plugin\n\nInstall this folder using your agent's plugin manager. When the plugin first starts, Beacon opens the ASIP connection. Sign in with Google or GitHub, or click Connect if already signed in.\n\n${agent === "codex" ? "In ChatGPT desktop, open Plugins → Add → Add a marketplace, enter this folder, then install ASIP from Personal. For Codex CLI, review ASIP in /hooks for automatic recording.\n" : ""}${agent === "antigravity" ? "Beacon maintains this folder; installed commands use its location.\n" : ""}`,
  );
  return directory;
}

export function rebindAntigravity(directory, destination = directory) {
  const binary = path.join(
    destination,
    "bin",
    process.platform === "win32" ? "asip-plugin.exe" : "asip-plugin",
  );
  const server = JSON.parse(
    fs.readFileSync(path.join(directory, "mcp_config.json")),
  );
  server.mcpServers.asip.command = binary;
  fs.writeFileSync(
    path.join(directory, "mcp_config.json"),
    JSON.stringify(server, null, 2) + "\n",
  );
  const hooks = JSON.parse(fs.readFileSync(path.join(directory, "hooks.json")));
  for (const [event, groups] of Object.entries(hooks.asip))
    for (const group of groups)
      for (const handler of group.hooks || [group])
        handler.command =
          '"' + binary + '" hook --agent antigravity --event ' + event;
  fs.writeFileSync(
    path.join(directory, "hooks.json"),
    JSON.stringify(hooks, null, 2) + "\n",
  );
}

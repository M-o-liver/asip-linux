import fs from "node:fs";
import path from "node:path";

const description = "Recall project work and record what your agent does.";
const skill = `---
name: asip
description: Connect ASIP, recall earlier project work, and save intentions, results, evidence, and unfinished work.
---

When the user asks to connect ASIP, call asip_connect. Tell them to click Connect in Beacon.
If Beacon is missing or the plugin is disconnected, explain the reported status and continue the user's work. Do not configure agent hooks or MCP servers yourself.

In Codex, automatic recording also requires reviewing ASIP's hooks in /hooks. Use Codex's native hook manager; do not edit hook trust files or bypass hook review.

Once connected, call asip_recall when continuing work on a project. Use the repository identity returned by asip_status or provide the project's repository identity.
Use asip_record for meaningful intent, result, evidence, and unresolved records. Use the native session ID from asip_status. Describe what happened and include verification or paths that support the result. Do not claim success without evidence. Hooks collect tool activity; avoid repeating each tool call as a manual record.
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
  write(
    "skills/setup/SKILL.md",
    "---\nname: setup\ndescription: Connect the ASIP plugin.\n---\n\nCall asip_connect. Tell the user to click Connect in ASIP Beacon. Use asip_status to check the connection when they return.\n",
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
      version: "0.1.0",
      description,
      author: { name: "ASIP" },
      homepage: "https://github.com/M-o-liver/asip-linux",
    });
    write(".claude-plugin/marketplace.json", {
      name: "asip-local",
      description,
      owner: { name: "ASIP" },
      plugins: [{ name: "asip", source: "./", description, version: "0.1.0" }],
    });
    write(".mcp.json", { mcpServers: { asip: server } });
    write("hooks/hooks.json", { hooks });
  } else if (agent === "codex") {
    // Codex 0.162.1 skips hooks for portable Agent Plugins manifests.
    // Use its native layout so actual lifecycle events reach ASIP.
    write(".codex-plugin/plugin.json", {
      name: "asip",
      version: "0.1.0",
      description,
      skills: "./skills/",
      mcpServers: "./.mcp.json",
      hooks: "./hooks/hooks.json",
      extensions: {
        "com.openai": { onboardingSkill: "./skills/setup/SKILL.md" },
      },
    });
    write(".mcp.json", {
      mcpServers: {
        asip: { command: "./bin/" + name, args: server.args, cwd: "." },
      },
    });
    write("hooks/hooks.json", { hooks });
    write(".agents/plugins/marketplace.json", {
      name: "asip-local",
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
    `# ASIP plugin\n\nInstall this folder using your agent's plugin manager, then ask the agent to connect ASIP. Open ASIP Beacon and sign in first.\n\n${agent === "antigravity" ? "Export this bundle from the installed Beacon. Keep the exported folder in place; its native commands use that location.\n" : ""}`,
  );
  return directory;
}

export function rebindAntigravity(directory) {
  const binary = path.join(
    directory,
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

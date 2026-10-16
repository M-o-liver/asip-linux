import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { qualifyCodex } from "./qualify-codex.mjs";
import assert from "node:assert/strict";
import { installAntigravity } from "./install-antigravity.mjs";
import { qualifyClaude } from "./qualify-claude.mjs";
import { Runtime } from "../beacon/runtime.mjs";
import { accountId } from "../beacon/identity.mjs";
import {
  AgentPlugins,
  findAgentCommand,
  runAgentCommand,
} from "../beacon/agent-plugins.mjs";

// Native installation checks belong in disposable CI users, never the
// developer's agent profile. This script does not sign in or run an agent.
if (process.env.CI !== "true")
  throw new Error("Run native installation qualification in CI.");
const target = process.platform + "-" + process.arch;
const codex = path.resolve("build/plugins", target, "asip-codex");
const claude = path.resolve("build/plugins", target, "asip-claude-code");
const antigravity = path.resolve("build/plugins", target, "asip-antigravity");
const evidence = [];
function run(command, args, native = false) {
  // Official npm CLIs expose .cmd wrappers on Windows.
  const output = execFileSync(
    process.platform === "win32" && !native ? command + ".cmd" : command,
    args,
    {
      encoding: "utf8",
      timeout: 60000,
      shell: process.platform === "win32" && !native,
    },
  );
  evidence.push({ command, args, output });
  console.log(output);
  return output;
}
const agy = await installAntigravity();
const manager = new AgentPlugins({
  home: path.resolve("build/qualification-beacon"),
  source: path.resolve("build/plugins"),
  find: (agent) =>
    agent === "antigravity" ? agy.executable : findAgentCommand(agent),
  run: async (file, args) => {
    const result = await runAgentCommand(file, args);
    evidence.push({ command: file, args, output: result.stdout });
    return result;
  },
});
manager.prepare();
process.env.ASIP_PLUGIN_STATE = path.resolve(
  "build/qualification-plugin-state",
);
// MCP clients filter inherited environment variables. Bind disposable state
// explicitly in these test bundles, never in a user's provider settings.
for (const agent of ["codex", "claude-code"]) {
  const file = path.join(manager.directory(agent), ".mcp.json");
  const config = JSON.parse(fs.readFileSync(file));
  config.mcpServers.asip.env = {
    ASIP_PLUGIN_STATE: process.env.ASIP_PLUGIN_STATE,
  };
  fs.writeFileSync(file, JSON.stringify(config));
}
for (const agent of ["codex", "claude-code", "antigravity"])
  await manager.install(agent);
run("claude", [
  "plugin",
  "validate",
  path.join(manager.directory("claude-code"), ".claude-plugin/plugin.json"),
]);
run(
  agy.executable,
  ["plugin", "validate", manager.directory("antigravity")],
  true,
);
const installed = JSON.parse(
  run(agy.executable, ["plugin", "list", "--json"], true),
);
const asip = installed.find((plugin) => plugin.name === "asip");
assert.ok(asip?.enabled, "Antigravity must enable the installed ASIP plugin.");
assert.ok(
  asip.mcpServers?.includes("asip"),
  "Antigravity must discover ASIP's MCP server.",
);
assert.ok(asip.hooks?.length, "Antigravity must discover ASIP's native hooks.");
// Exercise automatic account connection through the actual native MCP clients.
// Only this disposable CI profile trusts the fixture identity; no model runs.
const onboarding = [];
const identity = {
  accountId: accountId("github", "fixture"),
  provider: "github",
  handle: "fixture",
  name: "Fixture",
};
const runtime = new Runtime(path.resolve("build/qualification-memory"), {
  port: 12945,
  onPluginSignIn: (request) => {
    onboarding.push(request.agent);
    console.log("Fixture sign-in requested by " + request.agent);
    runtime.signIn(identity);
    runtime.completeSignIn(request.id, identity);
  },
});
await runtime.listen();
let codexStartup, claudeStartup;
try {
  codexStartup = await qualifyCodex({ connected: true });
  console.log(JSON.stringify(codexStartup));
  claudeStartup = await qualifyClaude({
    verify: async () => {
      const deadline = Date.now() + 15000;
      while (
        Date.now() < deadline &&
        !runtime.status().clients.some((c) => c.agent === "claude-code")
      )
        await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(
        runtime.status().clients.some((c) => c.agent === "claude-code"),
        "Claude's first MCP startup must connect ASIP.",
      );
    },
  });
  console.log(JSON.stringify(claudeStartup));
  assert.ok(onboarding.includes("codex") && onboarding.includes("claude-code"));
} finally {
  await runtime.close();
}
fs.writeFileSync(
  "build/qualification.json",
  JSON.stringify(
    {
      platform: target,
      nativeInstallation: evidence,
      codexStartup,
      claudeStartup,
      automaticAccountConnection: onboarding,
      antigravity: {
        version: agy.version,
        sha512: agy.sha512,
        installed: asip,
      },
    },
    null,
    2,
  ) + "\n",
);

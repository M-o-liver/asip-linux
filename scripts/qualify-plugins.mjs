import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { qualifyCodex } from "./qualify-codex.mjs";
import assert from "node:assert/strict";
import { installAntigravity } from "./install-antigravity.mjs";
import { qualifyClaude } from "./qualify-claude.mjs";

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
run("codex", ["plugin", "marketplace", "add", codex, "--json"]);
run("codex", ["plugin", "add", "asip@asip-local", "--json"]);
run("codex", ["plugin", "list", "--json"]);
run("claude", [
  "plugin",
  "validate",
  path.join(claude, ".claude-plugin/plugin.json"),
]);
run("claude", ["plugin", "marketplace", "add", claude]);
run("claude", ["plugin", "install", "asip@asip-local"]);
run("claude", ["plugin", "list", "--json"]);
const agy = await installAntigravity();
run(agy.executable, ["plugin", "validate", antigravity], true);
run(agy.executable, ["plugin", "install", antigravity], true);
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
const codexStartup = await qualifyCodex();
console.log(JSON.stringify(codexStartup));
const claudeStartup = await qualifyClaude();
console.log(JSON.stringify(claudeStartup));
fs.writeFileSync(
  "build/qualification.json",
  JSON.stringify(
    {
      platform: target,
      nativeInstallation: evidence,
      codexStartup,
      claudeStartup,
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

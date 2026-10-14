import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Native installation checks belong in disposable CI users, never the
// developer's agent profile. This script does not sign in or run an agent.
if (process.env.CI !== "true")
  throw new Error("Run native installation qualification in CI.");
const target = process.platform + "-" + process.arch;
const codex = path.resolve("build/plugins", target, "asip-codex");
const claude = path.resolve("build/plugins", target, "asip-claude-code");
const evidence = [];
function run(command, args) {
  // Official npm CLIs expose .cmd wrappers on Windows.
  const output = execFileSync(
    process.platform === "win32" ? command + ".cmd" : command,
    args,
    { encoding: "utf8", timeout: 60000, shell: process.platform === "win32" },
  );
  evidence.push({ command, args, output });
  console.log(output);
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
fs.writeFileSync(
  "build/qualification.json",
  JSON.stringify(
    {
      platform: target,
      nativeInstallation: evidence,
      antigravity: "Not qualified: no native Antigravity runner available.",
    },
    null,
    2,
  ) + "\n",
);

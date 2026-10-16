import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildPlugin } from "./plugins.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
).version;
const targets = process.argv.includes("--all")
  ? [
      ["linux", "x64"],
      ["linux", "arm64"],
      ["darwin", "x64"],
      ["darwin", "arm64"],
      ["win32", "x64"],
      ["win32", "arm64"],
    ]
  : [[process.platform, process.arch]];
for (const [platform, architecture] of targets) {
  const binary = platform === "win32" ? "asip-plugin.exe" : "asip-plugin";
  const target = platform + "-" + architecture;
  const directory = path.join(root, "build", "helper", target);
  fs.mkdirSync(directory, { recursive: true });
  execFileSync(
    "go",
    [
      "build",
      "-trimpath",
      "-ldflags=-s -w -X main.version=" + version,
      "-o",
      path.join(directory, binary),
      ".",
    ],
    {
      cwd: path.join(root, "plugin-helper"),
      stdio: "inherit",
      env: {
        ...process.env,
        CGO_ENABLED: "0",
        GOOS: platform === "win32" ? "windows" : platform,
        GOARCH: architecture === "x64" ? "amd64" : architecture,
      },
    },
  );
  for (const agent of ["codex", "claude-code", "antigravity"])
    buildPlugin({ root, target, agent, binary: path.join(directory, binary) });
  console.log("Built " + target + " helper and plugins");
}
const nativeTarget = process.platform + "-" + process.arch;
const packaged = path.join(root, "build", "packaged");
fs.rmSync(packaged, { recursive: true, force: true });
for (const component of ["helper", "plugins"]) {
  fs.cpSync(
    path.join(root, "build", component, nativeTarget),
    path.join(packaged, component, nativeTarget),
    { recursive: true },
  );
}

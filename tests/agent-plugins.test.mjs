import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentPlugins,
  findAgentCommand,
  runAgentCommand,
} from "../beacon/agent-plugins.mjs";
import desktop from "../beacon/desktop.cjs";

test("managed bundles keep stable paths, update their source, and preserve native Antigravity command paths", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "asip-managed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = new AgentPlugins({
    home: root,
    source: path.resolve("build/plugins"),
  });
  manager.prepare();
  const directory = manager.directory("antigravity");
  const mcp = JSON.parse(
    fs.readFileSync(path.join(directory, "mcp_config.json")),
  );
  assert.equal(
    path.dirname(path.dirname(mcp.mcpServers.asip.command)),
    directory,
  );
  assert.ok(!JSON.stringify(mcp).includes(".new"));
  const marker = path.join(manager.directory("codex"), "old-version-marker");
  fs.writeFileSync(marker, "");
  manager.prepare();
  assert.equal(fs.existsSync(marker), false);
  const installedPath = manager.directory("codex");
  manager.source = path.join(root, "missing-source");
  assert.throws(() => manager.prepare());
  assert.ok(
    fs.existsSync(path.join(installedPath, ".codex-plugin/plugin.json")),
  );
  assert.throws(() => manager.directory("../elsewhere"));
});

test("native install keeps paths as arguments, migrates only the legacy ASIP plugin, and records successful completion", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "asip-native-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = [];
  const manager = new AgentPlugins({
    home: path.join(home, "A & B's ASIP"),
    source: path.resolve("build/plugins"),
    find: () => process.execPath,
    run: async (file, args) => {
      calls.push(args);
      return {
        stdout: JSON.stringify({
          installed: [
            { pluginId: "asip@asip-local" },
            { pluginId: "other@other" },
          ],
        }),
      };
    },
  });
  manager.prepare();
  await manager.install("codex");
  assert.ok(calls.some((args) => args.includes(manager.directory("codex"))));
  assert.deepEqual(calls.at(-1), ["plugin", "remove", "asip@asip-local"]);
  assert.ok(manager.list().find((p) => p.id === "codex").addedAt);
  assert.equal(manager.list().find((p) => p.id === "codex").installing, false);
  manager.run = async () => {
    throw new Error("Native installer failed");
  };
  await assert.rejects(
    manager.install("claude-code"),
    /Native installer failed/,
  );
  assert.equal(
    manager.list().find((p) => p.id === "claude-code").addedAt,
    null,
  );
});

test("agent detection finds per-user installs outside the desktop PATH", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "asip-detect-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(
    home,
    ".local/bin",
    process.platform === "win32" ? "claude.exe" : "claude",
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
  fs.chmodSync(file, 0o755);
  assert.equal(
    findAgentCommand("claude-code", { home, env: { PATH: "" } }),
    file,
  );
});

test(
  "Windows npm wrappers preserve spaces, apostrophes, and shell punctuation in plugin paths",
  { skip: process.platform !== "win32" },
  async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "asip A & B-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const file = path.join(home, "agent.cmd");
    fs.writeFileSync(
      file,
      '@echo off\r\n"' +
        process.execPath +
        '" -e "console.log(JSON.stringify(process.argv.slice(1)))" %*\r\n',
    );
    const args = [
      "plugin",
      "install",
      "C:\\Users\\A & B\\ASIP plugins\\Claude's",
    ];
    const result = await runAgentCommand(file, args);
    assert.deepEqual(JSON.parse(result.stdout.trim()), args);
  },
);

test("tray panels stay inside negative-coordinate displays and handle top, bottom, and missing tray bounds", () => {
  const area = { x: -1920, y: 24, width: 1920, height: 1056 };
  for (const tray of [
    { x: -80, y: 0, width: 22, height: 22 },
    { x: -80, y: 1080, width: 22, height: 22 },
    { x: -1910, y: 400, width: 22, height: 22 },
  ]) {
    const p = desktop.panelBounds(tray, area);
    assert.ok(p.x >= area.x && p.y >= area.y);
    assert.ok(p.x + p.width <= area.x + area.width);
    assert.ok(p.y + p.height <= area.y + area.height);
  }
  assert.equal(desktop.panelBounds({ width: 0, height: 0 }, area), null);
});

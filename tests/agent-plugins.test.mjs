import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  AgentPlugins,
  findAgentCommand,
  runAgentCommand,
  codexDesktopURL,
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

test("ChatGPT installation links keep the local marketplace path intact", () => {
  const directory = path.join(os.tmpdir(), "A & B's ASIP", "asip-codex");
  const url = new URL(codexDesktopURL(directory));
  assert.equal(url.protocol, "codex:");
  assert.equal(url.host, "plugins");
  assert.equal(url.pathname, "/asip");
  assert.equal(
    url.searchParams.get("marketplacePath"),
    path.join(directory, ".agents/plugins/marketplace.json"),
  );
  assert.equal([...url.searchParams].length, 1);
});

test("Windows bundle refresh continues past locked retired directories and cleans them after release", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "asip-retired-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = new AgentPlugins({
    home: path.join(root, "beacon"),
    nativeHome: path.join(root, "native"),
    source: path.resolve("build/plugins"),
    find: () => null,
    platform: "win32",
  });
  manager.prepare();
  await manager.install("antigravity");
  const native = path.join(manager.nativeHome, ".gemini/config/plugins/asip");
  const old = manager.directory("antigravity") + ".previous";
  fs.mkdirSync(old);
  fs.writeFileSync(path.join(old, "locked"), "still running");
  const original = fs.rmSync;
  const removal = t.mock.method(fs, "rmSync", (directory, options) => {
    if (String(directory).includes(".previous"))
      throw Object.assign(new Error("Executable is in use"), { code: "EPERM" });
    if (path.basename(String(directory)).startsWith(".asip-stage-"))
      throw Object.assign(new Error("Directory watcher is still closing"), {
        code: "ENOTEMPTY",
      });
    return original(directory, options);
  });
  fs.writeFileSync(path.join(native, "old-version"), "");
  const rename = fs.renameSync;
  const rootLock = t.mock.method(fs, "renameSync", (from, to) => {
    if (from === native)
      throw Object.assign(new Error("Directory is watched"), { code: "EBUSY" });
    return rename(from, to);
  });
  manager.prepare();
  manager.prepare();
  const stagingParent = path.dirname(path.dirname(native));
  assert.ok(
    fs
      .readdirSync(stagingParent)
      .some((name) => name.startsWith(".asip-stage-")),
    "temporary cleanup failures must not abort a successful registration",
  );
  assert.ok(
    !fs
      .readdirSync(path.dirname(native))
      .some((name) => name.startsWith(".asip-stage-")),
    "temporary plugins must stay outside Antigravity's discovery directory",
  );
  assert.equal(fs.existsSync(path.join(native, "old-version")), false);
  assert.ok(fs.existsSync(path.join(old, "locked")));
  assert.deepEqual(
    fs.readFileSync(path.join(native, "mcp_config.json")),
    fs.readFileSync(
      path.join(manager.directory("antigravity"), "mcp_config.json"),
    ),
  );
  removal.mock.restore();
  rootLock.mock.restore();
  manager.prepare();
  assert.equal(fs.existsSync(old), false);
  for (const directory of [
    path.join(manager.home, "plugins"),
    path.dirname(native),
    stagingParent,
  ])
    assert.ok(
      !fs
        .readdirSync(directory)
        .some(
          (name) =>
            name.includes(".previous") || name.startsWith(".asip-stage-"),
        ),
    );
});

test(
  "native Windows upgrade retains a running executable and refreshes all plugin registrations",
  { skip: process.platform !== "win32", timeout: 30000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "asip-live-upgrade-"));
    let child;
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const ended = once(child, "exit");
        child.kill();
        await ended;
      }
      fs.rmSync(root, { recursive: true, force: true });
    });
    const manager = new AgentPlugins({
      home: path.join(root, "beacon"),
      nativeHome: path.join(root, "native"),
      source: path.resolve("build/plugins"),
      find: () => null,
    });
    manager.prepare();
    await manager.install("antigravity");
    const directory = manager.directory("antigravity");
    const native = path.join(manager.nativeHome, ".gemini/config/plugins/asip");
    const executable = path.join(directory, "bin/asip-plugin.exe");
    // A real executable image supplies Windows' file lock without signing in
    // or launching a browser from a test MCP process.
    fs.copyFileSync(process.execPath, executable);
    child = spawn(
      executable,
      ["-e", "console.log('ready');setInterval(()=>{},1000)"],
      {
        cwd: native,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    assert.match(String((await once(child.stdout, "data"))[0]), /ready/);
    manager.prepare();
    assert.equal(child.exitCode, null);
    const retired = fs
      .readdirSync(path.dirname(directory))
      .find((name) => name.startsWith("asip-antigravity.previous-"));
    assert.ok(retired, "the running image must remain until its process exits");
    // Recover the fixed-name leftover created by older Beacon builds too.
    fs.renameSync(
      path.join(path.dirname(directory), retired),
      directory + ".previous",
    );
    manager.prepare();
    assert.deepEqual(
      fs.readFileSync(path.join(native, "mcp_config.json")),
      fs.readFileSync(path.join(directory, "mcp_config.json")),
    );
    assert.ok(
      !fs.readFileSync(executable).equals(fs.readFileSync(process.execPath)),
    );
    const ended = once(child, "exit");
    child.kill();
    await ended;
    manager.prepare();
    assert.ok(
      !fs
        .readdirSync(path.dirname(directory))
        .some((name) => name.includes(".previous")),
    );
  },
);

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

test("Antigravity desktop uses the managed bundle without requiring its CLI or replacing another installation", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "asip-agy-desktop-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = new AgentPlugins({
    home: path.join(root, "beacon"),
    nativeHome: path.join(root, "native home"),
    source: path.resolve("build/plugins"),
    find: () => null,
  });
  manager.prepare();
  await manager.install("antigravity");
  const native = path.join(manager.nativeHome, ".gemini/config/plugins/asip");
  const command = JSON.parse(
    fs.readFileSync(path.join(native, "mcp_config.json")),
  ).mcpServers.asip.command;
  assert.equal(
    path.dirname(path.dirname(command)),
    manager.directory("antigravity"),
  );
  // Replacing the managed source on upgrade keeps the desktop registration valid.
  manager.prepare();
  await manager.install("antigravity");
  assert.ok(fs.existsSync(path.join(native, "hooks.json")));
  if (fs.lstatSync(native).isSymbolicLink()) fs.unlinkSync(native);
  else fs.rmSync(native, { recursive: true });
  fs.mkdirSync(native);
  fs.writeFileSync(path.join(native, "user-file"), "preserve");
  await assert.rejects(
    manager.install("antigravity"),
    /already has an ASIP folder/,
  );
  assert.equal(
    fs.readFileSync(path.join(native, "user-file"), "utf8"),
    "preserve",
  );
  fs.rmSync(native, { recursive: true });
  // The pinned CLI copies the matching bundle into the desktop directory.
  manager.find = () => "fixture-agy";
  manager.run = async () => {
    fs.cpSync(manager.directory("antigravity"), native, { recursive: true });
  };
  await manager.install("antigravity");
  assert.ok(fs.existsSync(path.join(native, "hooks.json")));
});

test("Windows Antigravity registration migrates junctions to discoverable directories and refreshes them on upgrade", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "asip-agy-windows-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = new AgentPlugins({
    home: path.join(root, "beacon"),
    nativeHome: path.join(root, "native home"),
    source: path.resolve("build/plugins"),
    find: () => null,
    platform: "win32",
  });
  manager.prepare();
  const native = path.join(manager.nativeHome, ".gemini/config/plugins/asip");
  fs.mkdirSync(path.dirname(native), { recursive: true });
  fs.symlinkSync(
    manager.directory("antigravity"),
    native,
    process.platform === "win32" ? "junction" : "dir",
  );
  await manager.install("antigravity");
  // Directory enumeration used by the desktop must see a directory, not a link.
  assert.ok(
    fs
      .readdirSync(path.dirname(native), { withFileTypes: true })
      .find((entry) => entry.name === "asip")
      .isDirectory(),
  );
  assert.equal(fs.lstatSync(native).isSymbolicLink(), false);
  const stale = path.join(native, "old-bundle-marker");
  fs.writeFileSync(stale, "old");
  fs.writeFileSync(path.join(native, "plugin.json"), '{"version":"old"}');
  manager.prepare();
  assert.equal(fs.existsSync(stale), false);
  assert.deepEqual(
    fs.readFileSync(path.join(native, "plugin.json")),
    fs.readFileSync(path.join(manager.directory("antigravity"), "plugin.json")),
  );
  assert.ok(fs.existsSync(path.join(manager.directory("antigravity"), "bin")));
  fs.rmSync(path.join(native, ".asip-beacon.json"));
  fs.writeFileSync(path.join(native, "plugin.json"), '{"name":"someone-else"}');
  await assert.rejects(
    manager.install("antigravity"),
    /already has an ASIP folder/,
  );
  assert.equal(
    fs.readFileSync(path.join(native, "plugin.json"), "utf8"),
    '{"name":"someone-else"}',
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

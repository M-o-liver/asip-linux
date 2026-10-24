import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { rebindAntigravity } from "../scripts/plugins.mjs";
import { writePluginArchive } from "./plugin-archive.mjs";

const execute = promisify(execFile);

// Windows keeps a running executable mapped after its directory is renamed.
// Retiring that directory must not prevent the new bundle from being used.
function removeRetired(directory, platform) {
  try {
    fs.rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: platform === "win32" ? 3 : 0,
      retryDelay: 50,
    });
  } catch (error) {
    if (
      platform !== "win32" ||
      !["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"].includes(error.code)
    )
      throw error;
  }
}

function cleanStaging(parent, platform) {
  if (!fs.existsSync(parent)) return;
  for (const entry of fs.readdirSync(parent))
    if (entry.startsWith(".asip-stage-"))
      removeRetired(path.join(parent, entry), platform);
}

function cleanRetired(destination, platform) {
  const parent = path.dirname(destination);
  if (!fs.existsSync(parent)) return;
  const prefix = path.basename(destination) + ".previous";
  for (const entry of fs.readdirSync(parent))
    if (entry === prefix || entry.startsWith(prefix + "-"))
      removeRetired(path.join(parent, entry), platform);
}

function refreshOwnedDirectory(source, destination, platform) {
  fs.mkdirSync(destination, { recursive: true });
  const entries = fs.readdirSync(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      refreshOwnedDirectory(from, to, platform);
    } else {
      if (
        fs.existsSync(to) &&
        fs.readFileSync(to).equals(fs.readFileSync(from))
      )
        continue;
      const temporary = to + ".new-" + randomUUID();
      try {
        fs.copyFileSync(from, temporary);
        fs.renameSync(temporary, to);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    }
  }
  const names = new Set(entries.map((entry) => entry.name));
  for (const name of fs.readdirSync(destination))
    if (!names.has(name)) removeRetired(path.join(destination, name), platform);
}
export const agents = {
  codex: { name: "Codex", command: "codex" },
  "claude-code": { name: "Claude Code", command: "claude" },
  antigravity: { name: "Antigravity", command: "agy" },
};

export function codexDesktopURL(directory) {
  const marketplace = path.join(
    directory,
    ".agents",
    "plugins",
    "marketplace.json",
  );
  return (
    "codex://plugins/asip?" +
    new URLSearchParams({ marketplacePath: marketplace })
  );
}

export function findAgentCommand(
  agent,
  { platform = process.platform, env = process.env, home = os.homedir() } = {},
) {
  if (!agents[agent]) throw new Error("Choose a supported agent.");
  const directories = [
    ...(env.PATH || "").split(platform === "win32" ? ";" : ":"),
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    ...(platform === "win32"
      ? [
          path.join(
            env.LOCALAPPDATA || path.join(home, "AppData", "Local"),
            "agy",
            "bin",
          ),
          env.APPDATA && path.join(env.APPDATA, "npm"),
        ]
      : ["/opt/homebrew/bin", "/usr/local/bin"]),
  ].filter(Boolean);
  for (const directory of directories)
    for (const suffix of platform === "win32"
      ? [".exe", ".cmd", ".bat"]
      : [""]) {
      const file = path.join(directory, agents[agent].command + suffix);
      try {
        fs.accessSync(
          file,
          platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK,
        );
        if (fs.statSync(file).isFile()) return file;
      } catch {}
    }
  return null;
}

// Arguments remain data, including paths with spaces and shell punctuation.
// PowerShell invokes npm's Windows .cmd wrappers without assembling a command.
export async function runAgentCommand(
  file,
  args,
  { platform = process.platform, env = process.env } = {},
) {
  const options = {
    timeout: 90000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    env,
  };
  if (platform === "win32" && /\.(cmd|bat)$/i.test(file))
    return execute(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$nativeArgs = ConvertFrom-Json $env:ASIP_INSTALL_ARGS; & $env:ASIP_INSTALL_CLI @nativeArgs; exit $LASTEXITCODE",
      ],
      {
        ...options,
        env: {
          ...env,
          ASIP_INSTALL_CLI: file,
          ASIP_INSTALL_ARGS: JSON.stringify(args),
        },
      },
    );
  return execute(file, args, options);
}

export class AgentPlugins {
  constructor({
    home,
    source,
    target = process.platform + "-" + process.arch,
    find = findAgentCommand,
    run = runAgentCommand,
    nativeHome = os.homedir(),
    platform = process.platform,
  }) {
    Object.assign(this, {
      home,
      source,
      target,
      find,
      run,
      nativeHome,
      platform,
    });
    this.busy = new Set();
    this.receipts = path.join(home, "plugin-installs.json");
  }
  directory(agent) {
    if (!agents[agent]) throw new Error("Choose a supported agent.");
    return path.join(this.home, "plugins", "asip-" + agent);
  }
  prepare() {
    for (const agent of Object.keys(agents)) {
      const destination = this.directory(agent);
      cleanRetired(destination, this.platform);
      const staging = destination + ".new";
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(staging), { recursive: true });
      fs.cpSync(path.join(this.source, this.target, "asip-" + agent), staging, {
        recursive: true,
      });
      // Absolute Antigravity commands must name the final, durable directory.
      if (agent === "antigravity") rebindAntigravity(staging, destination);
      // Provider caches are independent. Keep the managed source path stable
      // across Beacon upgrades so existing marketplace registrations still work.
      const previous = destination + ".previous-" + randomUUID();
      if (fs.existsSync(destination)) fs.renameSync(destination, previous);
      try {
        fs.renameSync(staging, destination);
      } catch (error) {
        if (fs.existsSync(previous)) fs.renameSync(previous, destination);
        throw error;
      }
      removeRetired(previous, this.platform);
      writePluginArchive(destination);
    }
    if (this.platform === "win32" && this.saved().antigravity)
      this.registerAntigravityDesktop();
  }
  saved() {
    try {
      return JSON.parse(fs.readFileSync(this.receipts, "utf8"));
    } catch {
      return {};
    }
  }
  list() {
    const receipts = this.saved();
    return Object.entries(agents).map(([id, agent]) => ({
      id,
      name: agent.name,
      directory: this.directory(id),
      archive: this.directory(id) + ".zip",
      available:
        id === "antigravity" || id === "codex" || Boolean(this.find(id)),
      desktop: id === "codex" && !this.find(id),
      installing: this.busy.has(id),
      addedAt: receipts[id]?.at || null,
    }));
  }
  registerAntigravityDesktop() {
    // The desktop app/IDE reads this native global directory. Native CLI
    // versions may install here too; a desktop-only install needs no CLI.
    const directory = this.directory("antigravity");
    const destination = path.join(
      this.nativeHome,
      ".gemini",
      "config",
      "plugins",
      "asip",
    );
    let existing;
    try {
      existing = fs.lstatSync(destination);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (existing) {
      let matches = fs.realpathSync(destination) === fs.realpathSync(directory);
      if (!matches && this.platform === "win32" && existing.isDirectory()) {
        try {
          const owner = JSON.parse(
            fs.readFileSync(
              path.join(destination, ".asip-beacon.json"),
              "utf8",
            ),
          );
          matches = owner.schema === 1 && owner.source === directory;
        } catch {}
      }
      if (!matches && existing.isDirectory()) {
        try {
          matches = ["plugin.json", "mcp_config.json", "hooks.json"].every(
            (file) =>
              fs
                .readFileSync(path.join(destination, file))
                .equals(fs.readFileSync(path.join(directory, file))),
          );
        } catch {}
      }
      if (!matches)
        throw new Error(
          "Antigravity already has an ASIP folder at " +
            destination +
            ". Remove that installation in Antigravity before adding this one.",
        );
    }
    if (this.platform === "win32") {
      // Antigravity's Windows desktop discovery skips directory junctions.
      // Keep a real native directory and refresh only our own installation.
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      cleanRetired(destination, this.platform);
      // A temporary bundle inside plugins is itself discovered and watched by
      // Antigravity. Stage beside that directory, on the same volume, instead.
      const stagingParent = path.dirname(path.dirname(destination));
      cleanStaging(stagingParent, this.platform);
      cleanStaging(path.dirname(destination), this.platform);
      const staging = fs.mkdtempSync(path.join(stagingParent, ".asip-stage-"));
      const previous = destination + ".previous-" + randomUUID();
      try {
        // The commands point at the durable managed helper. A second executable
        // copy here is unnecessary and can itself become locked by old clients.
        fs.cpSync(directory, staging, {
          recursive: true,
          filter: (file) =>
            path.relative(directory, file).split(path.sep)[0] !== "bin",
        });
        fs.writeFileSync(
          path.join(staging, ".asip-beacon.json"),
          JSON.stringify({ schema: 1, source: directory }),
        );
        if (existing?.isDirectory() && !existing.isSymbolicLink()) {
          // Antigravity's directory watcher (or an agent's current directory)
          // can lock this root even when no executable in it is running.
          refreshOwnedDirectory(staging, destination, this.platform);
        } else {
          if (existing) fs.renameSync(destination, previous);
          try {
            fs.renameSync(staging, destination);
          } catch (error) {
            if (existing) fs.renameSync(previous, destination);
            throw error;
          }
          if (existing?.isSymbolicLink()) fs.unlinkSync(previous);
          else if (existing) removeRetired(previous, this.platform);
        }
      } finally {
        removeRetired(staging, this.platform);
      }
    } else if (!existing) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.symlinkSync(directory, destination, "dir");
    }
    return destination;
  }
  async install(agent) {
    const directory = this.directory(agent);
    if (this.busy.has(agent))
      throw new Error("Installation is already running.");
    const file = this.find(agent);
    if (!file && agent !== "antigravity")
      throw new Error(
        "ASIP could not find " +
          agents[agent].name +
          "’s command-line installer. Use its plugin manager with the ASIP folder below.",
      );
    this.busy.add(agent);
    try {
      const commands =
        agent === "antigravity"
          ? [["plugin", "install", directory]]
          : [
              ["plugin", "marketplace", "add", directory],
              ["plugin", agent === "codex" ? "add" : "install", "asip@asip"],
            ];
      if (file) for (const args of commands) await this.run(file, args);
      if (agent === "antigravity") this.registerAntigravityDesktop();
      if (agent !== "antigravity") {
        const { stdout } = await this.run(file, ["plugin", "list", "--json"]);
        const listing = JSON.parse(stdout);
        const installed = Array.isArray(listing)
          ? listing
          : listing.installed || [];
        if (
          installed.some(
            (entry) => (entry.pluginId || entry.id) === "asip@asip-local",
          )
        )
          await this.run(file, [
            "plugin",
            agent === "codex" ? "remove" : "uninstall",
            "asip@asip-local",
          ]);
      }
      const receipts = this.saved();
      receipts[agent] = { at: new Date().toISOString() };
      fs.writeFileSync(this.receipts, JSON.stringify(receipts), {
        mode: 0o600,
      });
      return {
        agent,
        directory,
        message:
          agent === "codex"
            ? "Added to Codex. Review ASIP in /hooks for automatic recording, then open a new session."
            : agent === "antigravity"
              ? "Added to Antigravity. Restart the app, then open a new conversation. ASIP sign-in will appear automatically."
              : "Added to " +
                agents[agent].name +
                ". Open a new session; ASIP sign-in will appear automatically.",
      };
    } catch (error) {
      throw new Error(
        (error.stderr || error.message || "Installation failed.")
          .trim()
          .slice(-1600),
      );
    } finally {
      this.busy.delete(agent);
    }
  }
}

const fs = require("node:fs");
const path = require("node:path");

function startup(app, { platform = process.platform } = {}) {
  const preference = path.join(app.getPath("userData"), "startup.json");
  const executable = process.env.APPIMAGE || app.getPath("exe");
  const file = path.join(
    process.env.XDG_CONFIG_HOME || path.join(app.getPath("home"), ".config"),
    "autostart",
    "com.asip.beacon.desktop",
  );
  const options =
    platform === "win32" ? { path: executable, args: ["--background"] } : {};
  const launchAgent = path.join(
    app.getPath("home"),
    "Library/LaunchAgents/com.asip.beacon.plist",
  );
  const save = (enabled, mechanism) => {
    fs.mkdirSync(path.dirname(preference), { recursive: true });
    fs.writeFileSync(preference, JSON.stringify({ enabled, mechanism }), {
      mode: 0o600,
    });
  };
  return {
    initialize() {
      if (!app.isPackaged) return;
      if (!fs.existsSync(preference)) this.set(true);
      else {
        const saved = JSON.parse(fs.readFileSync(preference, "utf8"));
        // Older unsigned Mac builds silently failed to register a login item.
        // Migrate that failed attempt once; later OS removals remain respected.
        if (
          this.enabled() ||
          (platform === "darwin" && saved.enabled && !saved.mechanism)
        )
          this.set(true);
      }
    },
    enabled() {
      if (!app.isPackaged) return false;
      return platform === "linux"
        ? fs.existsSync(file)
        : app.getLoginItemSettings(options).openAtLogin ||
            (platform === "darwin" && fs.existsSync(launchAgent));
    },
    set(enabled) {
      if (!app.isPackaged)
        throw new Error("Install Beacon before enabling launch at login.");
      if (typeof enabled !== "boolean")
        throw new Error("Choose whether Beacon launches at login.");
      if (platform !== "linux") {
        app.setLoginItemSettings({ ...options, openAtLogin: enabled });
        let mechanism = "native";
        if (platform === "darwin") {
          if (enabled && !app.getLoginItemSettings(options).openAtLogin) {
            // Unsigned alpha builds cannot register Electron's native login
            // item. A per-user LaunchAgent starts the installed app at login.
            // No KeepAlive: Quit stays effective until the next login.
            const xmlPath = executable.replace(
              /[&<>"']/g,
              (character) =>
                ({
                  "&": "&amp;",
                  "<": "&lt;",
                  ">": "&gt;",
                  '"': "&quot;",
                  "'": "&apos;",
                })[character],
            );
            fs.mkdirSync(path.dirname(launchAgent), { recursive: true });
            fs.writeFileSync(
              launchAgent,
              '<?xml version="1.0" encoding="UTF-8"?>\n' +
                '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
                '<plist version="1.0"><dict><key>Label</key><string>com.asip.beacon</string>' +
                "<key>ProgramArguments</key><array><string>" +
                xmlPath +
                "</string><string>--background</string></array>" +
                "<key>RunAtLoad</key><true/><key>LimitLoadToSessionType</key><string>Aqua</string></dict></plist>\n",
              { mode: 0o600 },
            );
            mechanism = "launch-agent";
          } else fs.rmSync(launchAgent, { force: true });
        }
        save(enabled, mechanism);
        return;
      }
      if (!enabled) {
        fs.rmSync(file, { force: true });
        save(enabled, "desktop-entry");
        return;
      }
      // Desktop Entry string escaping follows Exec argument escaping. Percent
      // signs must be doubled so filenames cannot become field codes.
      const quoted =
        '"' +
        executable.replace(/[\\"`$]/g, "\\$&").replaceAll("%", "%%") +
        '"';
      const exec = quoted.replaceAll("\\", "\\\\");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        "[Desktop Entry]\nType=Application\nName=ASIP Beacon\nExec=" +
          exec +
          " --background\nTerminal=false\n",
        { mode: 0o600 },
      );
      save(enabled, "desktop-entry");
    },
    background() {
      return (
        process.argv.includes("--background") ||
        (platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin)
      );
    },
  };
}
module.exports = { startup };

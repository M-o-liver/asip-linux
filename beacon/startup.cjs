const fs = require("node:fs");
const path = require("node:path");

function startup(app) {
  const executable = process.env.APPIMAGE || app.getPath("exe");
  const file = path.join(
    process.env.XDG_CONFIG_HOME || path.join(app.getPath("home"), ".config"),
    "autostart",
    "com.asip.beacon.desktop",
  );
  const options =
    process.platform === "win32"
      ? { path: executable, args: ["--background"] }
      : {};
  return {
    enabled() {
      if (!app.isPackaged) return false;
      return process.platform === "linux"
        ? fs.existsSync(file)
        : app.getLoginItemSettings(options).openAtLogin;
    },
    set(enabled) {
      if (!app.isPackaged)
        throw new Error("Install Beacon before enabling launch at login.");
      if (typeof enabled !== "boolean")
        throw new Error("Choose whether Beacon launches at login.");
      if (process.platform !== "linux") {
        app.setLoginItemSettings({ ...options, openAtLogin: enabled });
        return;
      }
      if (!enabled) {
        fs.rmSync(file, { force: true });
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
    },
    background() {
      return (
        process.argv.includes("--background") ||
        (process.platform === "darwin" &&
          app.getLoginItemSettings().wasOpenedAtLogin)
      );
    },
  };
}
module.exports = { startup };

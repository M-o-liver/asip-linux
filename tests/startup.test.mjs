import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import startupModule from "../beacon/startup.cjs";

test("packaged Beacon defaults to login startup, preserves opt-out, and respects OS removal", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "asip-startup-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(home, "config");
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
  let enabled = false;
  const app = {
    isPackaged: true,
    getPath(name) {
      return name === "home"
        ? home
        : name === "userData"
          ? path.join(home, "data")
          : "/installed/ASIP Beacon";
    },
    getLoginItemSettings() {
      return { openAtLogin: enabled };
    },
    setLoginItemSettings(settings) {
      enabled = settings.openAtLogin;
    },
  };
  let login = startupModule.startup(app);
  login.initialize();
  assert.equal(login.enabled(), true);
  login.set(false);
  login = startupModule.startup(app);
  login.initialize();
  assert.equal(login.enabled(), false);
  login.set(true);
  if (process.platform === "linux")
    fs.rmSync(
      path.join(
        process.env.XDG_CONFIG_HOME,
        "autostart/com.asip.beacon.desktop",
      ),
    );
  else enabled = false;
  login.initialize();
  assert.equal(login.enabled(), false);
  app.isPackaged = false;
  fs.rmSync(path.join(home, "data/startup.json"));
  login.initialize();
  assert.equal(fs.existsSync(path.join(home, "data/startup.json")), false);
});

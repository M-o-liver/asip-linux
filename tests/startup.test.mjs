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

test("unsigned Mac login registration migrates to a user LaunchAgent and preserves opt-out", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "asip-mac-startup-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const preference = path.join(home, "data/startup.json");
  const file = path.join(home, "Library/LaunchAgents/com.asip.beacon.plist");
  let native = false;
  const app = {
    isPackaged: true,
    getPath: (name) =>
      name === "home"
        ? home
        : name === "userData"
          ? path.join(home, "data")
          : "/Applications/A & B.app/Contents/MacOS/ASIP Beacon",
    getLoginItemSettings: () => ({ openAtLogin: native }),
    setLoginItemSettings() {},
  };
  fs.mkdirSync(path.dirname(preference));
  fs.writeFileSync(preference, JSON.stringify({ enabled: true }));
  let login = startupModule.startup(app, { platform: "darwin" });
  login.initialize();
  assert.equal(login.enabled(), true);
  const plist = fs.readFileSync(file, "utf8");
  assert.ok(plist.includes("A &amp; B.app"));
  assert.ok(plist.includes("--background"));
  assert.ok(plist.includes("<key>RunAtLoad</key><true/>"));
  assert.ok(!plist.includes("KeepAlive"));
  // Removal in the OS is retained after the one-time migration.
  fs.rmSync(file);
  login.initialize();
  assert.equal(login.enabled(), false);
  login.set(false);
  login = startupModule.startup(app, { platform: "darwin" });
  login.initialize();
  assert.equal(login.enabled(), false);
  // A later signed build prefers the native login item, removing the fallback.
  login.set(true);
  native = true;
  login.set(true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(login.enabled(), true);
});

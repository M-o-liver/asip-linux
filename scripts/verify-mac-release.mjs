import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

assert.equal(process.platform, "darwin", "Verify Mac installers on macOS.");
const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const suffix = process.arch === "arm64" ? "-arm64" : "";
const image = path.resolve(`artifacts/ASIP Beacon-${version}${suffix}.dmg`);
assert.ok(fs.existsSync(image), "Current architecture's DMG is missing.");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "asip-dmg-check-"));
const mount = path.join(temporary, "mounted");
const app = path.join(temporary, "ASIP Beacon.app");
fs.mkdirSync(mount);
let attached = false;
const run = (command, args) =>
  execFileSync(command, args, { stdio: "inherit" });
try {
  run("hdiutil", ["verify", image]);
  run("hdiutil", [
    "attach",
    "-readonly",
    "-nobrowse",
    "-mountpoint",
    mount,
    image,
  ]);
  attached = true;
  run("ditto", [path.join(mount, "ASIP Beacon.app"), app]);
  run("hdiutil", ["detach", mount]);
  attached = false;
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  const resources = path.join(app, "Contents", "Resources");
  const target = "darwin-" + process.arch;
  const helpers = [
    path.join(resources, "helper", target, "asip-plugin"),
    ...["codex", "claude-code", "antigravity"].map((agent) =>
      path.join(
        resources,
        "plugins",
        target,
        "asip-" + agent,
        agent === "claude-code" ? "libexec" : "bin",
        "asip-plugin",
      ),
    ),
  ];
  for (const helper of helpers) {
    assert.ok(fs.existsSync(helper), "Packaged helper is missing: " + helper);
    run("codesign", ["--verify", "--strict", "--verbose=2", helper]);
  }
  run(process.execPath, ["scripts/smoke-beacon.mjs", "--app", app]);
  // Prove verification detects a modified executable, rather than only checking
  // that codesign can inspect a bundle. Never launch this modified copy.
  fs.appendFileSync(
    path.join(app, "Contents", "MacOS", "ASIP Beacon"),
    "tampered",
  );
  assert.throws(() =>
    execFileSync("codesign", ["--verify", "--deep", "--strict", app], {
      stdio: "pipe",
    }),
  );
  console.log(
    "DMG integrity, copied app/helper signatures, startup, and tamper rejection passed. Gatekeeper approval and notarization are separate checks.",
  );
} finally {
  if (attached) run("hdiutil", ["detach", mount]);
  fs.rmSync(temporary, { recursive: true, force: true });
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";

const artifacts = path.resolve("artifacts");
let executable;
if (process.platform === "darwin") {
  const directory = fs
    .readdirSync(artifacts)
    .find((name) => /^mac(?:-|$)/.test(name));
  executable = path.join(
    artifacts,
    directory,
    "ASIP Beacon.app",
    "Contents",
    "MacOS",
    "ASIP Beacon",
  );
} else
  executable = path.join(
    artifacts,
    process.platform === "win32" ? "win-unpacked" : "linux-unpacked",
    process.platform === "win32" ? "ASIP Beacon.exe" : "asip-beacon",
  );
if (process.platform === "linux" && process.argv.includes("--installed"))
  executable = "/usr/bin/asip-beacon";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "asip-beacon-smoke-"));
const child = spawn(executable, ["--user-data-dir=" + profile], {
  stdio: ["ignore", "pipe", "pipe"],
});
let errors = "";
child.stderr.on("data", (chunk) => (errors += chunk));
child.stdout.on("data", () => {});
try {
  let status;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      status = await fetch("http://127.0.0.1:12945/status", {
        signal: AbortSignal.timeout(1000),
      }).then((r) => r.json());
      break;
    } catch {}
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("Beacon exited: " + errors);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(status, "Beacon did not start: " + errors);
  assert.deepEqual(status, { running: true, signedIn: false });
  const response = await fetch("http://127.0.0.1:12945/events", {
    method: "POST",
    body: JSON.stringify({
      session: "smoke",
      kind: "intent",
      summary: "Must not be recorded",
    }),
  });
  assert.equal(response.status, 401);
  assert.equal(fs.existsSync(path.join(profile, "accounts")), false);
  assert.equal(fs.existsSync(path.join(profile, "signin.bin")), false);
  console.log("Packaged Beacon starts signed out and refuses activity.");
} finally {
  if (process.platform === "win32") {
    // Terminating only Electron's main process can leave a renderer holding
    // the disposable profile open. Stop the exact process tree we launched.
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } catch {
      /* It may have exited before cleanup. */
    }
  } else child.kill();
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else {
      child.once("exit", resolve);
      setTimeout(resolve, 5000);
    }
  });
  child.stdout.destroy();
  child.stderr.destroy();
  await fs.promises.rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}

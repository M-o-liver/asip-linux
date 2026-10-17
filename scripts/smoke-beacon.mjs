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
if (process.platform === "linux" && process.argv.includes("--appimage"))
  executable = path.join(
    artifacts,
    "ASIP Beacon-" +
      JSON.parse(fs.readFileSync("package.json")).version +
      (process.arch === "x64" ? "" : "-" + process.arch) +
      ".AppImage",
  );
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "asip-beacon-smoke-"));
const child = spawn(
  executable,
  ["--user-data-dir=" + profile, "--background"],
  {
    stdio: ["ignore", "pipe", "pipe"],
  },
);
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
  // A secondary invocation forwards actions and quits without initializing a
  // Runtime. Its shutdown must not erase the primary's saved account file.
  const savedAccount = path.join(profile, "signin.bin");
  const marker = Buffer.from("fixture-existing-encrypted-account-state");
  fs.writeFileSync(savedAccount, marker);
  const secondary = spawn(
    executable,
    [
      "--user-data-dir=" + profile,
      "--import-connections",
      path.join(profile, "fixture.json"),
    ],
    { stdio: "ignore" },
  );
  const secondaryCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      secondary.kill();
      reject(new Error("Secondary Beacon did not exit."));
    }, 15000);
    secondary.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    secondary.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  assert.equal(secondaryCode, 0);
  assert.deepEqual(
    fs.readFileSync(savedAccount),
    marker,
    "Secondary launch erased the saved ASIP account.",
  );
  const importDeadline = Date.now() + 10000;
  while (
    !errors.includes("Sign in before importing connections.") &&
    Date.now() < importDeadline
  )
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(
    errors.includes(
      "ASIP connection import failed: Sign in before importing connections.",
    ),
    "Secondary launch must forward its import action to the primary instance: " +
      errors,
  );
  fs.rmSync(savedAccount);
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
  console.log(
    "Packaged Beacon starts signed out, refuses activity, and preserves saved accounts during secondary launches.",
  );
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

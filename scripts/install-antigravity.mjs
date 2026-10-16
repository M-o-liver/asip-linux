import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

// The official installers use these manifests. Pin their release URLs and
// SHA-512 hashes so native qualification does not change under an existing PR.
export async function installAntigravity() {
  const releases = JSON.parse(
    fs.readFileSync(new URL("antigravity-releases.json", import.meta.url)),
  );
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  const release = releases[platform + "_" + arch];
  if (!release) throw new Error("No pinned Antigravity CLI for this runner.");
  const directory = path.resolve("build/qualification-tools/antigravity");
  fs.mkdirSync(directory, { recursive: true });
  const response = await fetch(release.url, {
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok)
    throw new Error("Antigravity download returned HTTP " + response.status);
  const payload = Buffer.from(await response.arrayBuffer());
  if (
    crypto.createHash("sha512").update(payload).digest("hex") !== release.sha512
  )
    throw new Error("Antigravity CLI checksum mismatch.");
  const executable = path.join(
    directory,
    process.platform === "win32" ? "agy.exe" : "agy",
  );
  if (process.platform === "win32") fs.writeFileSync(executable, payload);
  else {
    const archive = path.join(directory, "release.tar.gz");
    fs.writeFileSync(archive, payload);
    execFileSync("tar", ["-xzf", archive, "-C", directory, "antigravity"]);
    fs.renameSync(path.join(directory, "antigravity"), executable);
    fs.rmSync(archive);
    fs.chmodSync(executable, 0o755);
  }
  const version = execFileSync(executable, ["--version"], {
    encoding: "utf8",
    timeout: 30000,
  }).trim();
  if (version !== release.version)
    throw new Error("Unexpected Antigravity CLI version: " + version);
  return { executable, version, sha512: release.sha512 };
}

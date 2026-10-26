import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  BeaconUpdates,
  compareVersions,
  releaseAsset,
} from "../beacon/updates.mjs";
import { hostedWorkspace } from "../beacon/hosted-workspace.mjs";
const bytes = Buffer.from("fixture installer");
const digest = crypto.createHash("sha256").update(bytes).digest("hex");
const release = (version = "0.6.1-alpha.2", arch = "arm64") => ({
  tag_name: "v" + version,
  assets: [
    {
      name: `ASIP.Beacon-${version.split("-")[0]}-${arch}.dmg`,
      digest: "sha256:" + digest,
      size: bytes.length,
      browser_download_url: `https://github.com/M-o-liver/asip-linux/releases/download/v${version}/ASIP.Beacon-${version.split("-")[0]}-${arch}.dmg`,
    },
  ],
});
function setup(t, fetcher) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "asip-update-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const opened = [];
  const updater = new BeaconUpdates({
    home,
    version: "0.6.0",
    platform: "darwin",
    arch: "arm64",
    fetcher,
    openInstaller: async (file) => opened.push(file),
  });
  return { updater, opened, home };
}
test("workspace links use hosted identity, preserve project scope, and never infer a handle from local Google email", () => {
  assert.equal(
    hostedWorkspace({ account: "bosslikedat" }),
    "https://asip.ca/users/bosslikedat",
  );
  assert.equal(
    hostedWorkspace({ account: "person@example.com" }),
    "https://asip.ca/app",
  );
  assert.equal(
    hostedWorkspace({ account: "../../evil.test" }),
    "https://asip.ca/app",
  );
  const url = new URL(
    hostedWorkspace({ account: "owner" }, "github.com/example/project?x=1&y=2"),
  );
  assert.equal(
    url.searchParams.get("project"),
    "github.com/example/project?x=1&y=2",
  );
});
test("release ordering understands numeric prerelease components and stable releases", () => {
  assert.equal(compareVersions("0.6.1-alpha.10", "0.6.1-alpha.2"), 1);
  assert.equal(compareVersions("0.6.1", "0.6.1-alpha.10"), 1);
  assert.equal(compareVersions("0.6.0", "0.6.0"), 0);
  assert.throws(() => compareVersions("invalid", "0.6.0"));
  assert.equal(releaseAsset(release(), "darwin", "x64"), null);
  const forged = release();
  forged.assets[0].browser_download_url = "https://evil.test/update.dmg";
  assert.equal(releaseAsset(forged, "darwin", "arm64"), null);
  const noHash = release();
  delete noHash.assets[0].digest;
  assert.equal(releaseAsset(noHash, "darwin", "arm64"), null);
});
test("updates select architecture, verify bytes, and reverify before opening an installer", async (t) => {
  let fetches = 0;
  const { updater, opened } = setup(t, async (url) => {
    fetches++;
    return url.includes("api.github.com")
      ? Response.json([
          release(),
          release("0.6.1-alpha.10"),
          release("0.7.0", "x64"),
        ])
      : new Response(bytes);
  });
  assert.equal((await updater.check()).version, "0.6.1-alpha.10");
  assert.equal(fetches, 1, "check never downloads the installer");
  assert.equal((await updater.download()).phase, "ready");
  assert.equal(opened.length, 0, "download never launches the installer");
  await updater.install();
  assert.equal(opened.length, 1);
  fs.appendFileSync(opened[0], "tampered");
  await assert.rejects(updater.install(), /changed/);
  assert.equal(opened.length, 1);
});
test("corrupt, truncated, oversized, and untrusted downloads are rejected without keeping partial installers", async (t) => {
  for (const body of [
    Buffer.from("bad"),
    Buffer.alloc(bytes.length),
    Buffer.concat([bytes, bytes]),
  ]) {
    const { updater, home } = setup(t, async (url) =>
      url.includes("api.github.com")
        ? Response.json([release()])
        : new Response(body),
    );
    await updater.check();
    await assert.rejects(updater.download(), /verified/);
    assert.equal(updater.status().phase, "error");
    assert.deepEqual(
      fs.readdirSync(path.join(home, "updates", "0.6.1-alpha.2")),
      [],
    );
  }
  let requests = 0;
  const { updater } = setup(t, async (url) => {
    requests++;
    return url.includes("api.github.com")
      ? Response.json([release()])
      : new Response(null, {
          status: 302,
          headers: { location: "https://evil.test/installer" },
        });
  });
  await updater.check();
  await assert.rejects(updater.download());
  assert.equal(requests, 2, "untrusted redirect is never fetched");
});
test("failed checks recover and current/dev installations do not download or downgrade", async (t) => {
  let fails = true;
  const { updater } = setup(t, async () => {
    if (fails) throw new Error("offline");
    return Response.json([release("0.5.0")]);
  });
  assert.equal((await updater.check()).phase, "error");
  fails = false;
  assert.equal((await updater.check()).phase, "current");
  await assert.rejects(updater.download());
  updater.installed = false;
  updater.fetcher = () =>
    assert.fail("development builds must not check automatically");
  await updater.check();
});

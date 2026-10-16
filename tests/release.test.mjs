import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

test(
  "release staging keeps both Mac architectures, all installer sets, evidence, and matching hashes",
  { skip: process.platform === "win32" },
  (t) => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "asip-release-")),
    );
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ version: "0.4.0" }),
    );
    const fixtures = {
      "ubuntu-latest": [
        "ASIP Beacon-0.4.0.AppImage",
        "asip-beacon_0.4.0_amd64.deb",
        "asip-beacon-0.4.0.x86_64.rpm",
      ],
      "windows-latest": [
        "ASIP Beacon Setup 0.4.0.exe",
        "ASIP Beacon-0.4.0-win.zip",
      ],
      "macos-latest": [
        "ASIP Beacon-0.4.0-arm64.dmg",
        "ASIP Beacon-0.4.0-arm64-mac.zip",
      ],
      "macos-15-intel": ["ASIP Beacon-0.4.0.dmg", "ASIP Beacon-0.4.0-mac.zip"],
    };
    for (const [platform, names] of Object.entries(fixtures)) {
      const source = path.join(root, "release-builds/asip-" + platform);
      fs.mkdirSync(path.join(source, "artifacts"), { recursive: true });
      fs.mkdirSync(path.join(source, "build"));
      fs.writeFileSync(
        path.join(source, "build/qualification.json"),
        JSON.stringify({ platform }),
      );
      for (const name of names)
        fs.writeFileSync(
          path.join(source, "artifacts", name),
          platform + ":" + name,
        );
    }
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "gh"),
      '#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.GH_RELEASE_LOG, JSON.stringify(process.argv.slice(2))+"\\n");\n',
      { mode: 0o755 },
    );
    execFileSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../scripts/publish-release.mjs", import.meta.url),
        ),
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: bin + path.delimiter + process.env.PATH,
          GITHUB_ACTIONS: "true",
          GITHUB_REF_TYPE: "tag",
          GITHUB_REF_NAME: "v0.4.0-alpha.1",
          GH_RELEASE_LOG: path.join(root, "calls.jsonl"),
        },
      },
    );
    const calls = fs
      .readFileSync(path.join(root, "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(calls[0], ["release", "view", "v0.4.0-alpha.1"]);
    assert.deepEqual(calls[1].slice(0, 3), [
      "release",
      "upload",
      "v0.4.0-alpha.1",
    ]);
    const output = path.join(root, "release-assets");
    assert.equal(fs.readdirSync(output).length, 14);
    assert.ok(fs.existsSync(path.join(output, "ASIP.Beacon-0.4.0-x64.dmg")));
    assert.ok(fs.existsSync(path.join(output, "ASIP.Beacon-0.4.0-arm64.dmg")));
    for (const line of fs
      .readFileSync(path.join(output, "SHA256SUMS"), "utf8")
      .trim()
      .split("\n")) {
      const [sha, name] = line.split("  ");
      assert.equal(
        sha,
        createHash("sha256")
          .update(fs.readFileSync(path.join(output, name)))
          .digest("hex"),
      );
      assert.ok(calls[1].includes(path.join(output, name)));
    }
  },
);

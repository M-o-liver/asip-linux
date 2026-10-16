import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

// Only tag builds can publish, after every native job has passed. Downloaded
// artifacts stay separated by platform so their qualification records survive.
const tag = process.env.GITHUB_REF_NAME;
const version = JSON.parse(fs.readFileSync("package.json")).version;
if (
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.GITHUB_REF_TYPE !== "tag" ||
  !tag?.startsWith("v" + version + "-")
)
  throw new Error("Publish an alpha tag matching the application version.");
const output = path.resolve("release-assets");
fs.mkdirSync(output, { recursive: true });
const installers = [];
for (const platform of [
  "ubuntu-latest",
  "windows-latest",
  "macos-latest",
  "macos-15-intel",
]) {
  const source = path.join("release-builds", "asip-" + platform);
  const qualification = path.join(source, "build/qualification.json");
  fs.copyFileSync(
    qualification,
    path.join(output, "qualification-" + platform + ".json"),
  );
  for (const name of fs.readdirSync(path.join(source, "artifacts"))) {
    if (!/\.(exe|dmg|zip|AppImage|deb|rpm)$/.test(name)) continue;
    let published = name.replaceAll(" ", ".");
    if (platform === "macos-15-intel")
      published = published.replace(
        "ASIP.Beacon-" + version,
        "ASIP.Beacon-" + version + "-x64",
      );
    const target = path.join(output, published);
    if (fs.existsSync(target)) throw new Error("Duplicate asset: " + published);
    fs.copyFileSync(path.join(source, "artifacts", name), target);
    installers.push(published);
  }
}
if (installers.length !== 9)
  throw new Error("Expected Windows, Linux, and both Mac installer sets.");
const sums = fs
  .readdirSync(output)
  .sort()
  .map((name) => {
    const sha = createHash("sha256")
      .update(fs.readFileSync(path.join(output, name)))
      .digest("hex");
    return sha + "  " + name;
  });
fs.writeFileSync(path.join(output, "SHA256SUMS"), sums.join("\n") + "\n");
try {
  execFileSync("gh", ["release", "view", tag], { stdio: "ignore" });
} catch {
  execFileSync(
    "gh",
    [
      "release",
      "create",
      tag,
      "--verify-tag",
      "--prerelease",
      "--generate-notes",
    ],
    { stdio: "inherit" },
  );
}
execFileSync(
  "gh",
  [
    "release",
    "upload",
    tag,
    ...fs
      .readdirSync(output)
      .sort()
      .map((name) => path.join(output, name)),
    "--clobber",
  ],
  { stdio: "inherit" },
);

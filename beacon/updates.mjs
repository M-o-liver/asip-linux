import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const repository = "M-o-liver/asip-linux";
const feed = `https://api.github.com/repos/${repository}/releases?per_page=20`;
function versionParts(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  if (!match) throw new Error("Invalid release version.");
  return { numbers: match.slice(1, 4).map(Number), pre: match[4]?.split(".") };
}
export function compareVersions(left, right) {
  const a = versionParts(left),
    b = versionParts(right);
  for (let i = 0; i < 3; i++)
    if (a.numbers[i] !== b.numbers[i])
      return Math.sign(a.numbers[i] - b.numbers[i]);
  if (!a.pre || !b.pre) return a.pre ? -1 : b.pre ? 1 : 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i],
      y = b.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x),
      ny = /^\d+$/.test(y);
    if (nx && ny) return Math.sign(Number(x) - Number(y));
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
export function releaseAsset(release, platform, arch, format = "AppImage") {
  if (release.draft) return null;
  const value = release.tag_name?.replace(/^v/, "");
  versionParts(value || "");
  const base = value.split("-")[0];
  let name;
  if (platform === "win32" && arch === "x64")
    name = `ASIP.Beacon.Setup.${base}.exe`;
  else if (platform === "darwin" && ["arm64", "x64"].includes(arch))
    name = `ASIP.Beacon-${base}-${arch}.dmg`;
  else if (platform === "linux" && arch === "x64") {
    name =
      format === "deb"
        ? `asip-beacon_${base}_amd64.deb`
        : format === "rpm"
          ? `asip-beacon-${base}.x86_64.rpm`
          : `ASIP.Beacon-${base}.AppImage`;
  } else return null;
  const asset = release.assets?.find((a) => a.name === name);
  if (
    !asset ||
    !/^sha256:[a-f0-9]{64}$/.test(asset.digest || "") ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.size > 500 * 1024 * 1024
  )
    return null;
  const expected = `https://github.com/${repository}/releases/download/${release.tag_name}/${name}`;
  if (asset.browser_download_url !== expected) return null;
  return {
    version: value,
    name,
    url: expected,
    sha256: asset.digest.slice(7),
    size: asset.size,
  };
}
async function request(url, fetcher) {
  for (let redirects = 0; redirects < 6; redirects++) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      ![
        "api.github.com",
        "github.com",
        "release-assets.githubusercontent.com",
        "objects.githubusercontent.com",
      ].includes(parsed.hostname)
    )
      throw new Error("Untrusted update source.");
    const response = await fetcher(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(300000),
      headers: {
        "User-Agent": "ASIP-Beacon",
        Accept:
          parsed.hostname === "api.github.com"
            ? "application/vnd.github+json"
            : "application/octet-stream",
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get("location");
      await response.body?.cancel();
      if (!next) throw new Error("Invalid update redirect.");
      url = new URL(next, url).href;
      continue;
    }
    if (!response.ok)
      throw new Error("Update service unavailable. Try again later.");
    return response;
  }
  throw new Error("Too many update redirects.");
}
export class BeaconUpdates {
  constructor({
    home,
    version,
    platform = process.platform,
    arch = process.arch,
    format,
    installed = true,
    fetcher = fetch,
    onChange = () => {},
    openInstaller = () => {},
  }) {
    Object.assign(this, {
      home,
      version,
      platform,
      arch,
      format,
      installed,
      fetcher,
      onChange,
      openInstaller,
    });
    this.state = {
      phase: "idle",
      installed,
      current: version,
      message:
        "Updates are checked automatically each day. Downloads start when you choose.",
    };
  }
  status() {
    return { ...this.state };
  }
  set(value) {
    Object.assign(this.state, value);
    this.onChange();
  }
  start() {
    if (!this.installed) return;
    this.initial = setTimeout(() => this.check(), 30000);
    this.initial.unref();
    this.timer = setInterval(() => this.check(), 86400000);
    this.timer.unref();
  }
  stop() {
    clearTimeout(this.initial);
    clearInterval(this.timer);
  }
  async check() {
    if (
      !this.installed ||
      this.operation ||
      ["downloading", "ready"].includes(this.state.phase)
    )
      return this.status();
    this.set({ phase: "checking", message: "Checking for updates…" });
    this.operation = (async () => {
      try {
        const response = await request(feed, this.fetcher);
        const releases = await response.json();
        if (!Array.isArray(releases)) throw new Error("Invalid release feed.");
        const candidates = releases
          .flatMap((release) => {
            try {
              const asset = releaseAsset(
                release,
                this.platform,
                this.arch,
                this.format,
              );
              return asset && compareVersions(asset.version, this.version) > 0
                ? [asset]
                : [];
            } catch {
              return [];
            }
          })
          .sort((a, b) => compareVersions(b.version, a.version));
        this.candidate = candidates[0];
        this.set(
          this.candidate
            ? {
                phase: "available",
                version: this.candidate.version,
                message: `Beacon ${this.candidate.version} is available.`,
              }
            : {
                phase: "current",
                version: null,
                message: "You're up to date.",
              },
        );
      } catch {
        this.set({
          phase: "error",
          message: "Could not check for updates. Try again when you're online.",
        });
      }
      return this.status();
    })();
    try {
      return await this.operation;
    } finally {
      this.operation = null;
    }
  }
  async download() {
    if (
      !this.installed ||
      !this.candidate ||
      !["available", "error"].includes(this.state.phase) ||
      this.operation
    )
      throw new Error("Check for an available update first.");
    const candidate = { ...this.candidate };
    this.set({
      phase: "downloading",
      progress: 0,
      message: "Downloading the installer…",
    });
    const directory = path.join(this.home, "updates", candidate.version);
    const file = path.join(directory, candidate.name),
      temporary = file + "." + crypto.randomUUID() + ".part";
    let descriptor;
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const response = await request(candidate.url, this.fetcher);
      if (!response.body) throw new Error("Empty download.");
      descriptor = fs.openSync(temporary, "wx", 0o600);
      const hash = crypto.createHash("sha256");
      let size = 0,
        progress = -1;
      for await (const bytes of response.body) {
        size += bytes.length;
        if (size > candidate.size) throw new Error("Unexpected download size.");
        hash.update(bytes);
        fs.writeFileSync(descriptor, bytes);
        const next = Math.floor((size / candidate.size) * 100);
        if (next !== progress) {
          progress = next;
          this.set({ progress });
        }
      }
      fs.closeSync(descriptor);
      descriptor = undefined;
      if (size !== candidate.size || hash.digest("hex") !== candidate.sha256)
        throw new Error("Installer verification failed. Download again.");
      fs.renameSync(temporary, file);
      this.file = file;
      this.set({
        phase: "ready",
        message:
          "Installer verified. Open it to update Beacon; your account and history stay in place.",
      });
    } catch (error) {
      this.set({
        phase: "error",
        message: "The update could not be downloaded or verified. Try again.",
      });
      throw new Error(this.state.message);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      fs.rmSync(temporary, { force: true });
    }
    return this.status();
  }
  async install() {
    if (this.state.phase !== "ready" || !this.file)
      throw new Error("Download and verify the update first.");
    const bytes = fs.readFileSync(this.file);
    if (
      bytes.length !== this.candidate.size ||
      crypto.createHash("sha256").update(bytes).digest("hex") !==
        this.candidate.sha256
    ) {
      this.file = null;
      this.set({
        phase: "error",
        message: "The saved installer changed. Download it again.",
      });
      throw new Error(this.state.message);
    }
    await this.openInstaller(this.file);
  }
}

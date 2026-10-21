// Capture the actual Beacon workspace using public alpha 3 release evidence.
// This intentionally never opens the installed user's account or credentials.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
app.commandLine.appendSwitch("disable-gpu");
app
  .whenReady()
  .then(async () => {
    const { Runtime } = await import("../beacon/runtime.mjs");
    const { Workspace } = await import("../beacon/workspace.mjs");
    const { accountId } = await import("../beacon/identity.mjs");
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "asip-product-capture-"),
    );
    const runtime = new Runtime(home);
    try {
      runtime.signIn({
        accountId: accountId("github", "public-release-evidence"),
        handle: "ASIP release qualification",
        provider: "github",
      });
      const project = "github.com/M-o-liver/asip-linux",
        db = runtime.storage();
      const records = [
        [
          "linux-intent",
          "2026-10-21T11:00:00Z",
          "codex",
          "linux-qualification",
          "intent",
          "Verify automatic summaries across agents and computers.",
          { source: "QUALIFICATION.md", release: "v0.4.1-alpha.3" },
        ],
        [
          "linux-response",
          "2026-10-21T11:01:00Z",
          "antigravity",
          "5d49d953-c68a-4c4d-adc3-c23956e7385f",
          "Stop",
          "Automatic turn summary verified.",
          {
            source: {
              transcript: "Native Antigravity conversation",
              sha256:
                "66b61c466d58c7b9f71340558f9ae9ffb94857acc0be0a49f69925b0010ea9f1",
            },
            platform: "Linux",
            record: "34558e14-b60b-4b24-8715-521bc46d175b",
          },
        ],
        [
          "windows-response",
          "2026-10-21T11:02:00Z",
          "antigravity",
          "520c4ef0-fbb5-4d25-b0ae-8d8e4e92086a",
          "Stop",
          "Automatic turn summary verified.",
          {
            source: { step: 17 },
            platform: "Windows",
            record: "3a6feb8b-4069-43ea-9f12-0d5828aa4dd1",
          },
        ],
        [
          "mac-response",
          "2026-10-21T11:03:00Z",
          "antigravity",
          "61778954-87a7-467e-9b2e-61f5adf13aa8",
          "Stop",
          "Automatic turn summary verified.",
          {
            source: { step: 11 },
            platform: "macOS",
            record: "20c89226-53c8-42f4-ab38-d1264098820e",
          },
        ],
        [
          "codex-recall",
          "2026-10-21T11:04:00Z",
          "codex",
          "release-qualification",
          "evidence",
          "Codex recalled the original Antigravity response and its source.",
          {
            release: "v0.4.1-alpha.3",
            qualification:
              "Published cross-agent retrieval evidence on Linux, Windows and Intel macOS.",
          },
        ],
        [
          "release",
          "2026-10-21T11:05:00Z",
          "codex",
          "release-qualification",
          "result",
          "Alpha 3 published. Native builds and source evidence verified.",
          {
            revision: "57f5c7ca90f422ee38c758470e6fb18805858f35",
            checks: "13 published asset digests match SHA256SUMS",
            source:
              "https://github.com/M-o-liver/asip-linux/blob/main/QUALIFICATION.md",
          },
        ],
      ];
      for (const [id, at, agent, session, kind, summary, data] of records)
        db.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?)").run(
          id,
          at,
          agent,
          session,
          kind,
          project,
          summary,
          JSON.stringify(data),
        );
      const workspace = new Workspace(runtime);
      await runtime.listen();
      const win = new BrowserWindow({
        width: 1280,
        height: 900,
        show: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          offscreen: true,
        },
      });
      await win.loadURL(workspace.openURL(project));
      for (let i = 0; i < 60; i++) {
        if (
          await win.webContents.executeJavaScript(
            "Boolean(document.querySelector('#events')?.children.length)",
          )
        )
          break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await win.webContents.executeJavaScript(
        "document.querySelector('#events button')?.click()",
      );
      const output = path.resolve("cloud/public/assets/workspace.png");
      fs.writeFileSync(output, (await win.webContents.capturePage()).toPNG());
      console.log(output);
      win.destroy();
    } finally {
      await runtime.close();
      fs.rmSync(home, { recursive: true, force: true });
      app.quit();
    }
  })
  .catch((e) => {
    console.error(e);
    app.exit(1);
  });

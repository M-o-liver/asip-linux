const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  shell,
  nativeImage,
  safeStorage,
  dialog,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const userDataDirectory = app.commandLine.getSwitchValue("user-data-dir");
if (userDataDirectory) {
  fs.mkdirSync(userDataDirectory, { recursive: true });
  app.setPath("userData", userDataDirectory);
}
let runtime,
  identity,
  window,
  tray,
  pending = null,
  abort = null,
  deviceCode = null,
  lastError = "";
const sessionPath = () => path.join(app.getPath("userData"), "signin.bin");

function persist() {
  if (!runtime?.account) {
    fs.rmSync(sessionPath(), { force: true });
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) return;
  if (
    process.platform === "linux" &&
    safeStorage.getSelectedStorageBackend() === "basic_text"
  )
    return;
  const value = JSON.stringify({
    account: runtime.account,
    clients: [...runtime.clients.entries()],
    expires: Date.now() + 30 * 86400000,
  });
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(sessionPath(), safeStorage.encryptString(value), {
    mode: 0o600,
  });
}

function snapshot() {
  return {
    ...runtime.status(),
    pending,
    deviceCode,
    error: lastError,
    signingIn: Boolean(abort),
    providers: {
      google: Boolean(identity.config.googleClientId),
      github: Boolean(identity.config.githubClientId),
    },
  };
}
function send() {
  window?.webContents.send("asip:status", snapshot());
}

function show() {
  if (window && !window.isDestroyed()) {
    window.show();
    window.focus();
    send();
    return;
  }
  window = new BrowserWindow({
    width: 440,
    height: 600,
    resizable: false,
    title: "ASIP Beacon",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.loadFile(path.join(__dirname, "window.html"));
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.on("closed", () => {
    window = null;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else
  app.whenReady().then(async () => {
    app.on("second-instance", show);
    const { Runtime } = await import("./runtime.mjs");
    const { Identity } = await import("./identity.mjs");
    const { rebindAntigravity } = await import("../scripts/plugins.mjs");
    const configPath = path.join(__dirname, "signin.json");
    const config = fs.existsSync(configPath)
      ? JSON.parse(fs.readFileSync(configPath, "utf8"))
      : {};
    config.googleClientId =
      process.env.ASIP_GOOGLE_CLIENT_ID || config.googleClientId;
    config.githubClientId =
      process.env.ASIP_GITHUB_CLIENT_ID || config.githubClientId;
    runtime = new Runtime(app.getPath("userData"), {
      port: 12945,
      onConnectionChange: persist,
      onPluginSignIn: (request) => {
        pending = request;
        lastError = "";
        show();
        send();
      },
    });
    identity = new Identity(config, {
      openBrowser: (url) => shell.openExternal(url),
      onCode: (code) => {
        deviceCode = code;
        send();
      },
    });
    try {
      if (fs.existsSync(sessionPath()) && safeStorage.isEncryptionAvailable()) {
        const state = JSON.parse(
          safeStorage.decryptString(fs.readFileSync(sessionPath())),
        );
        if (state.expires > Date.now()) {
          runtime.signIn(state.account);
          runtime.clients = new Map(state.clients);
        }
      }
      await runtime.listen();
    } catch (error) {
      lastError = "ASIP Beacon could not start: " + error.message;
    }
    const icon = path.join(__dirname, "icon.png");
    tray = new Tray(
      nativeImage.createFromPath(icon).resize({ width: 22, height: 22 }),
    );
    tray.setToolTip("ASIP Beacon");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open ASIP Beacon", click: show },
        { label: "Quit", click: () => app.quit() },
      ]),
    );
    tray.on("click", show);
    ipcMain.handle("asip:status", () => snapshot());
    ipcMain.handle("asip:signin", async (_event, provider) => {
      if (abort) return snapshot();
      lastError = "";
      abort = new AbortController();
      send();
      const controller = abort,
        request = pending;
      try {
        const account = await identity.signIn(provider, controller.signal);
        controller.signal.throwIfAborted();
        if (request) {
          runtime.completeSignIn(request.id, account);
          pending = null;
        } else runtime.signIn(account);
        persist();
      } catch (error) {
        lastError = error.message;
      } finally {
        abort = null;
        deviceCode = null;
        send();
      }
      return snapshot();
    });
    ipcMain.handle("asip:cancel", () => {
      abort?.abort();
      if (pending) runtime.cancelSignIn(pending.id);
      pending = null;
      deviceCode = null;
      send();
      return snapshot();
    });
    ipcMain.handle("asip:signout", () => {
      abort?.abort();
      runtime.signOut();
      pending = null;
      persist();
      send();
      return snapshot();
    });
    ipcMain.handle("asip:disconnect", (_event, agent) => {
      runtime.disconnect(agent);
      persist();
      send();
      return snapshot();
    });
    ipcMain.handle("asip:export-plugin", async (_event, agent) => {
      if (!["codex", "claude-code", "antigravity"].includes(agent))
        throw new Error("Choose an agent.");
      const selection = await dialog.showOpenDialog(window, {
        title: "Save ASIP plugin",
        properties: ["openDirectory", "createDirectory"],
      });
      if (selection.canceled) return null;
      const sourceRoot = app.isPackaged
        ? path.join(process.resourcesPath, "plugins")
        : path.join(__dirname, "..", "build", "plugins");
      const directory = path.join(selection.filePaths[0], "asip-" + agent);
      if (fs.existsSync(directory))
        throw new Error("Choose a folder without an existing ASIP plugin.");
      fs.cpSync(
        path.join(
          sourceRoot,
          process.platform + "-" + process.arch,
          "asip-" + agent,
        ),
        directory,
        { recursive: true },
      );
      if (agent === "antigravity") rebindAntigravity(directory);
      await shell.openPath(directory);
      return directory;
    });
    setInterval(() => {
      runtime.expireRequests();
      if (pending && !runtime.requests.has(pending.id)) {
        abort?.abort();
        pending = null;
        deviceCode = null;
      }
      send();
      tray.setToolTip(
        runtime.status().recording
          ? "ASIP · " + runtime.clients.size + " connected plugins"
          : "ASIP · Not connected",
      );
    }, 2000).unref();
    show();
  });
app.on("window-all-closed", () => {});
app.on("before-quit", () => {
  abort?.abort();
  persist();
  runtime?.signOut();
  runtime?.server?.close();
});

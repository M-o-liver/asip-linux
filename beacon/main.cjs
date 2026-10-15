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
  connections,
  recovery,
  window,
  tray,
  pending = null,
  abort = null,
  deviceCode = null,
  lastError = "",
  trayState = "";
const agentNames = {
  codex: "Codex",
  "claude-code": "Claude Code",
  antigravity: "Antigravity",
};
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

const loginStartup = require("./startup.cjs").startup(app);

function snapshot() {
  let configuredConnections = [];
  if (runtime.account && connections) {
    try {
      configuredConnections = connections.list();
    } catch {
      lastError = "API connections could not be opened.";
    }
  }
  return {
    ...runtime.status(),
    platform: process.platform,
    pending,
    deviceCode,
    error: lastError || runtime.recordingError || "",
    signingIn: Boolean(abort),
    providers: {
      google: Boolean(
        identity.config.googleClientId && identity.config.googleClientSecret,
      ),
      github: Boolean(identity.config.githubClientId),
    },
    connections: configuredConnections,
    launchAtLogin: loginStartup.enabled(),
    installed: app.isPackaged,
  };
}
function send() {
  const state = snapshot();
  window?.webContents.send("asip:status", state);
  updateTray(state);
}
function updateTray(state) {
  if (!tray) return;
  const available = Boolean(runtime.server?.listening);
  const active = state.clients.some(
    (client) =>
      client.lastActivity &&
      Date.now() - Date.parse(client.lastActivity) < 10000,
  );
  const icon =
    !available || state.error || state.pending || state.signingIn
      ? "attention"
      : active
        ? "active"
        : state.recording
          ? "ready"
          : "inactive";
  const label = !available
    ? "Service unavailable"
    : state.error
      ? "Needs attention"
      : state.pending
        ? "Waiting to connect"
        : state.signingIn
          ? "Waiting for sign-in"
          : !state.account
            ? "Signed out"
            : active
              ? "Recording activity"
              : state.recording
                ? "Ready"
                : "No plugins connected";
  const key = JSON.stringify([icon, label, state.clients, state.records]);
  if (key === trayState) return;
  trayState = key;
  tray.setImage(
    nativeImage
      .createFromPath(path.join(__dirname, icon + ".png"))
      .resize({ width: 22, height: 22 }),
  );
  tray.setToolTip("ASIP · " + label);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label, enabled: false },
      ...state.clients.map((client) => ({
        label:
          (agentNames[client.agent] || client.agent) +
          (client.lastActivity
            ? " · " + new Date(client.lastActivity).toLocaleTimeString()
            : " · Connected"),
        enabled: false,
      })),
      ...(state.recording
        ? [{ label: state.records + " recorded events", enabled: false }]
        : []),
      { type: "separator" },
      { label: "Open ASIP", click: openWorkspace },
      { label: "Beacon settings", click: show },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
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
    height: 680,
    minWidth: 420,
    minHeight: 500,
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

async function openWorkspace() {
  if (!runtime?.server?.listening || !runtime?.workspace) {
    show();
    return;
  }
  try {
    await shell.openExternal(
      runtime.account
        ? runtime.workspace.openURL()
        : "http://" + runtime.host + "/workspace/",
    );
  } catch (error) {
    lastError = error.message;
    show();
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else
  app.whenReady().then(async () => {
    app.on("second-instance", (_event, argv) => {
      if (argv.includes("--background")) return;
      if (argv.includes("--beacon-settings")) show();
      else openWorkspace();
    });
    try {
      loginStartup.initialize();
    } catch (error) {
      lastError = "Could not enable launch at login: " + error.message;
    }
    const { Runtime } = await import("./runtime.mjs");
    const { Identity } = await import("./identity.mjs");
    const { Connections } = await import("./connections.mjs");
    const { Recovery } = await import("./recovery.mjs");
    const { Workspace } = await import("./workspace.mjs");
    const { importHistory, previousHistoryPath } =
      await import("./import-history.mjs");
    const { rebindAntigravity } = await import("../scripts/plugins.mjs");
    const configPath = path.join(__dirname, "signin.json");
    const config = fs.existsSync(configPath)
      ? JSON.parse(fs.readFileSync(configPath, "utf8"))
      : {};
    config.googleClientId =
      process.env.ASIP_GOOGLE_CLIENT_ID || config.googleClientId;
    const desktopClientPath = path.join(__dirname, "google-client.json");
    if (fs.existsSync(desktopClientPath)) {
      const desktopClient = JSON.parse(
        fs.readFileSync(desktopClientPath, "utf8"),
      ).installed;
      if (desktopClient?.client_id === config.googleClientId)
        config.googleClientSecret = desktopClient.client_secret;
    }
    config.googleClientSecret =
      process.env.ASIP_GOOGLE_CLIENT_SECRET || config.googleClientSecret;
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
    recovery = new Recovery(runtime);
    new Workspace(runtime, { openBeacon: show, openWorkspace });
    identity = new Identity(config, {
      openBrowser: (url) => shell.openExternal(url),
      onCode: (code) => {
        deviceCode = code;
        send();
      },
    });
    connections = new Connections(app.getPath("userData"), {
      account: () => runtime.account,
      seal: (value) => {
        if (
          !safeStorage.isEncryptionAvailable() ||
          (process.platform === "linux" &&
            safeStorage.getSelectedStorageBackend() === "basic_text")
        )
          throw new Error("The system keychain is unavailable.");
        return safeStorage.encryptString(value);
      },
      unseal: (value) => safeStorage.decryptString(value),
    });
    runtime.connectionStore = connections;
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
    updateTray(snapshot());
    tray.on("click", openWorkspace);
    ipcMain.handle("asip:open-workspace", openWorkspace);
    ipcMain.handle("asip:status", () => snapshot());
    ipcMain.handle("asip:startup", (_event, enabled) => {
      loginStartup.set(enabled);
      send();
      return snapshot();
    });
    ipcMain.handle("asip:projects", () => runtime.projects());
    ipcMain.handle("asip:import-history", async () => {
      if (!runtime.account)
        throw new Error("Sign in before importing history.");
      const owner = runtime.account.accountId;
      const selection = await dialog.showOpenDialog(window, {
        title: "Import previous ASIP history",
        defaultPath: previousHistoryPath(),
        filters: [
          {
            name: "ASIP workspace database",
            extensions: ["sqlite3", "sqlite", "db"],
          },
        ],
        properties: ["openFile"],
      });
      if (selection.canceled) return null;
      if (runtime.account?.accountId !== owner)
        throw new Error("The ASIP account changed.");
      const result = importHistory(runtime, selection.filePaths[0], {
        checkpoint: () => recovery.save("Before history import"),
      });
      send();
      return result;
    });
    ipcMain.handle("asip:recovery-list", () => recovery.list());
    ipcMain.handle("asip:recovery-save", () => recovery.save());
    ipcMain.handle("asip:recovery-restore", async (_event, id) => {
      const record = recovery.list().find((entry) => entry.id === id);
      if (!record) throw new Error("Choose an existing recovery record.");
      const owner = runtime.account.accountId;
      const answer = await dialog.showMessageBox(window, {
        type: "question",
        buttons: ["Cancel", "Restore history"],
        defaultId: 0,
        cancelId: 0,
        message:
          "Restore activity history from " +
          new Date(record.at).toLocaleString() +
          "?",
        detail:
          "Current history will be saved as a recovery record before it is replaced. API connections are unchanged.",
      });
      if (answer.response !== 1) return recovery.list();
      if (runtime.account?.accountId !== owner)
        throw new Error("The ASIP account changed.");
      runtime.abortRequests();
      const records = recovery.restore(id);
      send();
      return records;
    });
    ipcMain.handle("asip:save-connection", (_event, input) => {
      connections.save(input);
      runtime.abortRequests(undefined, input.name);
      send();
      return snapshot();
    });
    ipcMain.handle("asip:github-connection", async (_event, input) => {
      if (!runtime.account) throw new Error("Sign in to ASIP Beacon first.");
      if (abort) throw new Error("Finish the current sign-in first.");
      if (!/^[a-z][a-z0-9._-]{1,79}$/.test(input.name || ""))
        throw new Error("Enter a connection name such as github.work.");
      if (!["public_repo", "repo"].includes(input.scope))
        throw new Error("Choose repository access.");
      const owner = runtime.account.accountId;
      const controller = new AbortController();
      abort = controller;
      lastError = "";
      send();
      try {
        const result = await identity.github(controller.signal, {
          scope: input.scope,
          includeCredential: true,
        });
        controller.signal.throwIfAborted();
        if (runtime.account?.accountId !== owner)
          throw new Error("The ASIP account changed during authorization.");
        connections.save({
          ...input,
          provider: "github",
          credential: result.credential,
          account: result.account.handle,
        });
        runtime.abortRequests(undefined, input.name);
      } catch (error) {
        lastError = error.message;
      } finally {
        abort = null;
        deviceCode = null;
        send();
      }
      return snapshot();
    });
    ipcMain.handle("asip:remove-connection", (_event, name) => {
      connections.remove(name);
      runtime.abortRequests(undefined, name);
      send();
      return snapshot();
    });
    ipcMain.handle("asip:signin", async (_event, provider) => {
      if (abort) return snapshot();
      lastError = "";
      abort = new AbortController();
      send();
      const controller = abort;
      try {
        const account = await identity.signIn(provider, controller.signal);
        controller.signal.throwIfAborted();
        runtime.signIn(account);
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
    ipcMain.handle("asip:connect", () => {
      try {
        if (!pending) throw new Error("No plugin is waiting to connect.");
        runtime.completeSignIn(pending.id, runtime.account);
        pending = null;
        lastError = "";
      } catch (error) {
        lastError = error.message;
      }
      send();
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
    }, 2000).unref();
    if (process.argv.includes("--beacon-settings")) show();
    else if (!loginStartup.background()) openWorkspace();
  });
app.on("window-all-closed", () => {});
app.on("before-quit", () => {
  abort?.abort();
  persist();
  runtime?.signOut();
  runtime?.server?.close();
});

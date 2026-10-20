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
  clipboard,
  screen,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const buildFile = app.isPackaged
  ? path.join(process.resourcesPath, "build.json")
  : path.join(__dirname, "..", "build", "packaged", "build.json");
const build = fs.existsSync(buildFile)
  ? JSON.parse(fs.readFileSync(buildFile, "utf8"))
  : { version: app.getVersion(), revision: "development" };
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
  pluginBundles,
  recentWork,
  dialogOpen = false,
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
  // A secondary launch exits without a Runtime. It must never delete the
  // primary instance's saved account while forwarding an action to it.
  if (!runtime) return;
  if (!runtime.account) {
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
    build,
    panel: Boolean(window?.asipPanel),
    online: Boolean(runtime.server?.listening),
    plugins: pluginBundles?.list() || [],
    workspace: runtime.account
      ? {
          projects: runtime.projects().length,
          recent: recentWork(runtime),
        }
      : { projects: 0, recent: [] },
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
async function importConnectionFile(file) {
  try {
    const { importConnections } = await import("./import-connections.mjs");
    const result = await importConnections(connections, file, {
      account: () => runtime.account?.accountId,
    });
    lastError = "";
    console.info("ASIP connection import completed: " + result.imported.length);
    send();
    return result;
  } catch (error) {
    lastError = error.message;
    console.error("ASIP connection import failed: " + error.message);
    send();
    throw error;
  }
}
function importArgument(argv, cwd = process.cwd()) {
  const index = argv.indexOf("--import-connections");
  const file =
    index < 0
      ? argv.find((arg) => arg.startsWith("--import-connections="))?.slice(21)
      : argv[index + 1];
  return file && !file.startsWith("--") ? path.resolve(cwd, file) : null;
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
  if (process.platform !== "darwin")
    tray.setImage(
      nativeImage
        .createFromPath(path.join(__dirname, icon + ".png"))
        .resize({ width: 22, height: 22 }),
    );
  tray.setToolTip("ASIP · " + label);
  const menu = Menu.buildFromTemplate([
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
    { label: "Open Beacon", click: () => show({ full: true }) },
    { label: "Quit", click: () => app.quit() },
  ]);
  if (process.platform === "linux") tray.setContextMenu(menu);
  else tray.asipMenu = menu;
}

function show({
  full = process.platform === "linux",
  toggle = false,
  page,
} = {}) {
  let placement;
  if (!full && tray) {
    try {
      const bounds = tray.getBounds();
      placement = require("./desktop.cjs").panelBounds(
        bounds,
        screen.getDisplayMatching(bounds).workArea,
      );
    } catch {}
  }
  const panel = Boolean(!full && placement);
  if (window && !window.isDestroyed() && window.asipPanel === panel) {
    if (toggle && panel && window.isVisible()) {
      window.hide();
      return;
    }
    if (panel) window.setBounds(placement);
    window.show();
    window.focus();
    send();
    if (page) window.webContents.send("asip:navigate", page);
    return;
  }
  window?.destroy();
  const area = screen.getPrimaryDisplay().workArea;
  window = new BrowserWindow({
    ...(panel
      ? {
          ...placement,
          frame: false,
          resizable: false,
          skipTaskbar: true,
          ...(process.platform === "darwin"
            ? { vibrancy: "menu", visualEffectState: "active" }
            : { backgroundMaterial: "mica" }),
        }
      : {
          width: Math.min(1060, area.width - 32),
          height: Math.min(780, area.height - 48),
          minWidth: Math.min(760, area.width - 32),
          minHeight: Math.min(560, area.height - 48),
        }),
    show: false,
    backgroundColor: "#111417",
    title: "ASIP Beacon",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const created = window;
  created.asipPanel = panel;
  if (process.platform === "darwin") {
    if (panel) app.dock?.hide();
    else app.dock?.show();
  }
  created.loadFile(path.join(__dirname, "window.html"));
  created.once("ready-to-show", () => {
    // macOS can report provisional menu-bar bounds during first launch.
    // Place the panel again once the renderer is ready and the icon is laid out.
    if (panel && tray) {
      try {
        const bounds = tray.getBounds();
        const placement = require("./desktop.cjs").panelBounds(
          bounds,
          screen.getDisplayMatching(bounds).workArea,
        );
        if (placement) created.setBounds(placement);
      } catch {}
    }
    created.show();
    created.focus();
    if (page) created.webContents.send("asip:navigate", page);
  });
  created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  created.webContents.on("will-navigate", (event) => event.preventDefault());
  created.on("blur", () => {
    if (panel && !dialogOpen && !pending && !abort) created.hide();
  });
  created.on("closed", () => {
    if (window === created) window = null;
  });
}

async function nativeDialog(method, options) {
  dialogOpen = true;
  try {
    return await dialog[method](window, options);
  } finally {
    dialogOpen = false;
  }
}

async function openWorkspace(project) {
  if (!runtime?.server?.listening || !runtime?.workspace) {
    show();
    return;
  }
  try {
    await shell.openExternal(
      runtime.account
        ? runtime.workspace.openURL(project)
        : "http://" + runtime.host + "/workspace/",
    );
  } catch (error) {
    lastError = error.message;
    show();
  }
}

let finishStartup;
const startupReady = new Promise((resolve) => {
  finishStartup = resolve;
});
if (
  !app.requestSingleInstanceLock({
    importConnections: importArgument(process.argv),
  })
) {
  app.quit();
} else
  app.whenReady().then(async () => {
    app.on("second-instance", async (_event, argv, cwd, data) => {
      await startupReady;
      const file =
        typeof data?.importConnections === "string"
          ? data.importConnections
          : importArgument(argv, cwd);
      if (file) {
        importConnectionFile(file)
          .then(() => show())
          .catch(() => show());
        return;
      }
      if (argv.includes("--background")) return;
      if (argv.includes("--open")) await openWorkspace();
      else if (argv.includes("--beacon-settings")) show();
      else show();
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
    const workspaceModule = await import("./workspace.mjs");
    const { Workspace } = workspaceModule;
    recentWork = workspaceModule.recentWork;
    const { importHistory, previousHistoryPath } =
      await import("./import-history.mjs");
    const { AgentPlugins } = await import("./agent-plugins.mjs");
    pluginBundles = new AgentPlugins({
      home: app.getPath("userData"),
      source: app.isPackaged
        ? path.join(process.resourcesPath, "plugins")
        : path.join(__dirname, "..", "build", "plugins"),
    });
    try {
      pluginBundles.prepare();
    } catch (error) {
      lastError = "Plugin setup failed: " + error.message;
    }
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
    new Workspace(runtime, {
      openBeacon: (page) => show({ page }),
      openWorkspace,
    });
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
    try {
      const image = nativeImage
        .createFromPath(
          path.join(
            __dirname,
            process.platform === "darwin" ? "trayTemplate.png" : "icon.png",
          ),
        )
        .resize({ width: 22, height: 22 });
      if (process.platform === "darwin") image.setTemplateImage(true);
      tray = new Tray(image);
      if (process.platform === "darwin") app.dock?.hide();
      updateTray(snapshot());
      tray.on("click", () => show({ toggle: true }));
      if (process.platform !== "linux")
        tray.on("right-click", () => tray.popUpContextMenu(tray.asipMenu));
    } catch {
      tray = null;
    }
    app.on("activate", () => show({ full: true }));
    ipcMain.handle("asip:open-workspace", (_event, project) =>
      openWorkspace(project),
    );
    ipcMain.handle("asip:status", () => snapshot());
    ipcMain.handle("asip:copy-text", (_event, text) => {
      if (typeof text !== "string" || text.length > 12000)
        throw new Error("Could not copy these commands.");
      clipboard.writeText(text);
    });
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
      const selection = await nativeDialog("showOpenDialog", {
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
      const answer = await nativeDialog("showMessageBox", {
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
    ipcMain.handle("asip:check-connection", async (_event, name) => {
      try {
        return await connections.check(name);
      } finally {
        send();
      }
    });
    ipcMain.handle("asip:import-connections", async () => {
      const owner = runtime.account?.accountId;
      if (!owner) throw new Error("Sign in before importing connections.");
      const selection = await nativeDialog("showOpenDialog", {
        title: "Import API connections",
        filters: [{ name: "Connection list", extensions: ["json"] }],
        properties: ["openFile"],
      });
      if (selection.canceled) return null;
      if (runtime.account?.accountId !== owner)
        throw new Error("The ASIP account changed.");
      return importConnectionFile(selection.filePaths[0]);
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
        if (pending && !pending.account) {
          runtime.completeSignIn(pending.id, account);
          pending = null;
        }
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
      const id = pending?.id;
      pending = null;
      if (id) runtime.cancelSignIn(id);
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
    ipcMain.handle("asip:show-full", () => show({ full: true }));
    ipcMain.handle("asip:hide-window", () => window?.hide());
    ipcMain.handle("asip:quit", () => app.quit());
    ipcMain.handle("asip:plugin-folder", (_event, agent) =>
      shell.openPath(pluginBundles.directory(agent)),
    );
    ipcMain.handle("asip:install-plugin", async (_event, agent) => {
      if (agent === "codex" && !pluginBundles.find(agent)) {
        const { codexDesktopURL } = await import("./agent-plugins.mjs");
        await shell.openExternal(
          codexDesktopURL(pluginBundles.directory(agent)),
        );
        return {
          agent,
          message:
            "Install ASIP in ChatGPT. Open its Hooks → Review to enable recording, then start a new chat.",
        };
      }
      const operation = pluginBundles.install(agent);
      send();
      try {
        return await operation;
      } finally {
        send();
      }
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
    finishStartup();
    const connectionFile = importArgument(process.argv);
    if (connectionFile)
      await importConnectionFile(connectionFile).catch(() => {});
    if (process.argv.includes("--open")) await openWorkspace();
    else if (process.argv.includes("--beacon-settings")) show();
    else if (!loginStartup.background()) show();
    else if (process.platform !== "linux" && !tray) show({ full: true });
  });
app.on("window-all-closed", () => {});
app.on("before-quit", () => {
  abort?.abort();
  persist();
  runtime?.signOut();
  runtime?.server?.close();
});

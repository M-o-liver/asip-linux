const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("asip", {
  status: () => ipcRenderer.invoke("asip:status"),
  startup: (enabled) => ipcRenderer.invoke("asip:startup", enabled),
  projects: () => ipcRenderer.invoke("asip:projects"),
  recoveryList: () => ipcRenderer.invoke("asip:recovery-list"),
  recoverySave: () => ipcRenderer.invoke("asip:recovery-save"),
  recoveryRestore: (id) => ipcRenderer.invoke("asip:recovery-restore", id),
  signIn: (provider) => ipcRenderer.invoke("asip:signin", provider),
  connect: () => ipcRenderer.invoke("asip:connect"),
  saveConnection: (input) => ipcRenderer.invoke("asip:save-connection", input),
  githubConnection: (input) =>
    ipcRenderer.invoke("asip:github-connection", input),
  removeConnection: (name) =>
    ipcRenderer.invoke("asip:remove-connection", name),
  cancel: () => ipcRenderer.invoke("asip:cancel"),
  signOut: () => ipcRenderer.invoke("asip:signout"),
  disconnect: (agent) => ipcRenderer.invoke("asip:disconnect", agent),
  exportPlugin: (agent) => ipcRenderer.invoke("asip:export-plugin", agent),
  onStatus: (callback) =>
    ipcRenderer.on("asip:status", (_event, status) => callback(status)),
});

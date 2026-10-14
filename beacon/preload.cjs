const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("asip", {
  status: () => ipcRenderer.invoke("asip:status"),
  projects: () => ipcRenderer.invoke("asip:projects"),
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

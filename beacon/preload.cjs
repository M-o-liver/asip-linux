const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("asip", {
  status: () => ipcRenderer.invoke("asip:status"),
  signIn: (provider) => ipcRenderer.invoke("asip:signin", provider),
  cancel: () => ipcRenderer.invoke("asip:cancel"),
  signOut: () => ipcRenderer.invoke("asip:signout"),
  disconnect: (agent) => ipcRenderer.invoke("asip:disconnect", agent),
  exportPlugin: (agent) => ipcRenderer.invoke("asip:export-plugin", agent),
  onStatus: (callback) =>
    ipcRenderer.on("asip:status", (_event, status) => callback(status)),
});

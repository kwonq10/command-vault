const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("commandVault", {
  close: () => ipcRenderer.send("window:hide"),
  resize: (height) => ipcRenderer.send("window:resize", height),
  expandSettings: () => ipcRenderer.send("window:expand-settings"),
  collapseSettings: (height) => ipcRenderer.send("window:collapse-settings", height),
  onUpdateAvailable: (callback) => ipcRenderer.on("update:available", (_event, version) => callback(version)),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url)
});

contextBridge.exposeInMainWorld("electronAPI", {
  minimize: () => ipcRenderer.send("minimize-window")
});

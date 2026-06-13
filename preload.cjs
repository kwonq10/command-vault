const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("commandVault", {
  close: () => ipcRenderer.send("window:hide"),
  resize: (height) => ipcRenderer.send("window:resize", height)
});

contextBridge.exposeInMainWorld("electronAPI", {
  minimize: () => ipcRenderer.send("minimize-window")
});

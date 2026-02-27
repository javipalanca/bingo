const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bomboAPI", {
  selectFolder: () => ipcRenderer.invoke("select-folder")
});
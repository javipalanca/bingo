const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");

function isImageFile(name) {
  const ext = path.extname(name).toLowerCase();
  return [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(ext);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 760,
    backgroundColor: "#0b0f17",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("select-folder", async () => {
  const res = await dialog.showOpenDialog({
    properties: ["openDirectory"]
  });
  if (res.canceled || !res.filePaths?.[0]) return { canceled: true };

  const dir = res.filePaths[0];
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter(isImageFile)
      .map((f) => path.join(dir, f));
  } catch (e) {
    return { canceled: false, dir, files: [], error: String(e) };
  }

  // Orden estable para reproducibilidad visual (pero luego barajamos en renderer)
  files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));

  return { canceled: false, dir, files };
});
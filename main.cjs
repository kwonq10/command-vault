process.on('uncaughtException', (err) => {
  require('fs').appendFileSync('C:\\cv\\error.log', new Date().toISOString() + '\n' + err.stack + '\n\n');
});
process.on('unhandledRejection', (reason) => {
  require('fs').appendFileSync('C:\\cv\\error.log', new Date().toISOString() + '\nUnhandledRejection: ' + reason + '\n\n');
});

const { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const PORT = Number(process.env.PORT || 3456);
const APP_URL = `http://127.0.0.1:${PORT}`;

let win;
let tray;
let serverProcess;
let isQuitting = false;

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function waitForServer(timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isPortOpen(PORT)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

function prepareDatabase() {
  const dataPath = path.join(app.getPath("userData"), "commands.json");
  const seedPath = path.join(__dirname, "commands.json");

  if (!fs.existsSync(dataPath)) {
    fs.mkdirSync(path.dirname(dataPath), { recursive: true });
    if (fs.existsSync(seedPath)) {
      fs.copyFileSync(seedPath, dataPath);
    } else {
      fs.writeFileSync(dataPath, "[]\n", "utf8");
    }
  }

  return dataPath;
}

function resolveNodeBin() {
  // インストール済み Electron では process.execPath が .exe 本体を指すため、
  // 同梱の node.exe (resources/node.exe) または PATH 上の node を探す。
  const candidates = [
    path.join(path.dirname(process.execPath), "resources", "node.exe"),
    path.join(path.dirname(process.execPath), "node.exe"),
    process.execPath,
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return process.execPath;
}

async function startServer() {
  if (await isPortOpen(PORT)) return;

  const serverPath = path.join(__dirname, "server.js");
  const nodeBin = resolveNodeBin();
  serverProcess = spawn(nodeBin, [serverPath], {
    cwd: __dirname,
    env: {
      ...process.env,
      COMMANDS_DB_PATH: prepareDatabase(),
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(PORT)
    },
    stdio: "ignore",
    windowsHide: true
  });

  serverProcess.unref();

  if (!(await waitForServer(20000))) {
    throw new Error(`Command Vault server did not start on port ${PORT}.`);
  }
}

function showWindow() {
  if (!win) return;
  win.show();
  win.center();
  win.focus();
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) {
    win.hide();
  } else {
    showWindow();
  }
}

function createTray() {
  const iconPath = path.join(__dirname, "assets", "tray-icon.svg");
  let icon = nativeImage.createFromPath(iconPath);

  if (icon.isEmpty()) {
    icon = nativeImage.createFromDataURL(
      "data:image/svg+xml;utf8," +
        encodeURIComponent(
          "<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16'><rect width='16' height='16' rx='4' fill='#256f72'/><path d='M4 5h8v2H4zm0 4h8v2H4z' fill='white'/></svg>"
        )
    );
  }

  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip("Command Vault");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "\u958b\u304f", click: showWindow },
      {
        label: "\u7d42\u4e86",
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ])
  );
  tray.on("click", toggleWindow);
}

async function checkForUpdates(win) {
  try {
    const { version } = require("./package.json");
    const response = await fetch("https://api.github.com/repos/kwonq10/command-vault/releases/latest", {
      headers: { "User-Agent": "command-vault-app" },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return;
    const data = await response.json();
    const latestVersion = (data.tag_name || "").replace(/^v/, "");
    if (latestVersion && latestVersion !== version) {
      win?.webContents.send("update:available", latestVersion);
    }
  } catch {
    // オフライン・APIエラー時は無視
  }
}

async function createWindow() {
  await startServer();

  win = new BrowserWindow({
    title: "Command Deck",
    icon: path.join(__dirname, "assets", "icon.ico"),
    width: 550,
    height: 160,
    minWidth: 520,
    minHeight: 160,
    resizable: true,
    frame: false,
    transparent: false,
    alwaysOnTop: false,
    center: true,
    vibrancy: "under-window",
    backgroundColor: "#f6f8fb",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  await win.loadURL(APP_URL);
  showWindow();

  win.webContents.on("did-finish-load", () => {
    checkForUpdates(win);
  });

  win.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });

}

app.on("second-instance", showWindow);

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;

  Menu.setApplicationMenu(null);
  createTray();
  await createWindow();

  const primaryShortcutRegistered = globalShortcut.register("Alt+Space", toggleWindow);

  if (!primaryShortcutRegistered) {
    console.warn("Alt+Space は使用中のため Alt+C を登録します");
    if (!globalShortcut.register("Alt+C", toggleWindow)) {
      console.warn("Alt+C could not be registered.");
    }
  }

  ipcMain.on("window:hide", () => {
    win?.hide();
  });

  ipcMain.on("window:resize", (_event, height) => {
    if (!win) return;
    win.setSize(550, Math.min(500, Math.max(160, height)));
  });

  ipcMain.on("window:expand-settings", () => {
    if (!win) return;
    const [w] = win.getSize();
    win.setSize(w, 320);
  });

  ipcMain.on("window:collapse-settings", (_event, height) => {
    if (!win) return;
    const [w] = win.getSize();
    win.setSize(w, Math.min(500, Math.max(160, height)));
  });

  ipcMain.on("minimize-window", () => {
    win?.minimize();
  });

  ipcMain.handle("shell:openExternal", (_event, url) => {
    try {
      const u = new URL(url);
      if (u.protocol !== "https:" && u.protocol !== "http:") return;
      if (u.hostname !== "github.com" && !u.hostname.endsWith(".github.com")) return;
      shell.openExternal(u.toString());
    } catch {
      // malformed URL は無視
    }
  });

  app.on("activate", showWindow);
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (serverProcess) serverProcess.kill();
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});

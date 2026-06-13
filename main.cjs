const { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage } = require("electron");
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

async function startServer() {
  if (await isPortOpen(PORT)) return;

  const serverPath = path.join(__dirname, "server.js");
  serverProcess = spawn(process.execPath, [serverPath], {
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

  if (!(await waitForServer())) {
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

async function createWindow() {
  await startServer();

  win = new BrowserWindow({
    title: "Command収集器",
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
    win.setSize(550, height === 420 ? 420 : 160);
  });

  ipcMain.on("minimize-window", () => {
    win?.minimize();
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

const path = require('node:path');
const { app, BrowserWindow, Notification, ipcMain, Menu } = require('electron');

// Must run before any local require that touches app.getPath('userData') —
// the npm package name stays "desktop-app" (matches the workspace folder),
// but the product Electron reports to Windows should be the real product name.
app.setName('Beam');

// Electron shows a default File/Edit/View/Window/Help menu bar unless told
// not to — there's nothing in that menu this app uses (no File > Open, no
// Edit > Undo), and it doesn't match the frameless, themed rest of the app.
Menu.setApplicationMenu(null);

const { saveLink, savePhoto } = require('./saveHandlers');
const { createTray } = require('./tray');

// Packaged installs default to the hosted relay so they work with zero
// setup; process.env.RELAY_URL overrides this for local development
// (see README.md's "Running locally" section).
const RELAY_URL = process.env.RELAY_URL || 'https://beam-wckn2w.fly.dev';
const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');

let tray;
let mainWindow;

// Closing the window (the X button) hides it back to the tray instead of
// quitting — the tray's own "Quit" entry (see tray.js) is the only real
// exit. Without this flag, that same close handler would also block the
// real quit from ever finishing.
app.on('before-quit', () => {
  app.isQuitting = true;
});

function notify(title, body) {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 640,
    minWidth: 360,
    minHeight: 480,
    title: 'Beam',
    icon: ICON_PATH,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#050308',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  // Belt and suspenders alongside the global Menu.setApplicationMenu(null)
  // above — this is what actually removes the bar rather than just
  // collapsing it behind Alt.
  mainWindow.setMenuBarVisibility(false);
  // This is the literal same page a phone gets when it visits the relay —
  // same origin as the API, same HTML/JS, no separate Electron-only UI to
  // keep in sync with it.
  mainWindow.loadURL(RELAY_URL);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function toggleMainWindow() {
  if (!mainWindow) {
    createMainWindow();
    return;
  }
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

app.whenReady().then(() => {
  // Menu-bar-only app: subscribing (even with a no-op) stops Electron's
  // default behavior of quitting once every window closes on Windows/Linux.
  app.on('window-all-closed', () => {});

  // Keeps Beam "always on" — relaunches with Windows so it doesn't need to
  // be manually started each session. Skipped in dev (electron .) since
  // that would register the electron.exe shell itself as a login item.
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
  }

  const trayHandle = createTray({
    iconPath: ICON_PATH,
    onLeftClick: toggleMainWindow,
    onQuit: () => {
      app.isQuitting = true;
      app.quit();
    },
  });
  tray = trayHandle.tray;

  createMainWindow();

  // A live SSE arrival in the shared web-client page (web-client/src/app.js)
  // calls window.beamNative.itemReceived(...) via preload.js — this is what
  // keeps the relay forgetting its copy after 2 minutes from also meaning
  // "the PC never actually got it."
  ipcMain.on('item-received', async (event, item, relayUrl, token) => {
    try {
      if (item.type === 'link') {
        saveLink(item);
        notify('Link received', item.content);
      } else if (item.type === 'photo') {
        const savedPath = await savePhoto(item, relayUrl, token);
        notify('Photo received', savedPath);
      }
    } catch (err) {
      console.error('failed to save received item', err);
    }
  });

  ipcMain.on('quit', () => {
    app.isQuitting = true;
    app.quit();
  });
});

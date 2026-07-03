const path = require('node:path');
const { app, BrowserWindow, Notification, ipcMain, Menu, clipboard, powerMonitor } = require('electron');

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
let resizeTimer;
let hiddenSince = null;

// Defense in depth, on top of the real fix (the exponential-backoff +
// staleness watchdog in web-client/src/app.js, which is what actually
// keeps the SSE connection alive or promptly reconnects it): if the
// window sat hidden long enough that ANYTHING else about the page's state
// might have gone stale — not just the SSE connection — a full reload is
// cheap insurance. Deliberately much longer than the web-client's own 40s
// staleness threshold, since the real fix should already have recovered
// the connection well before this ever fires; this is only a backstop.
const HIDDEN_RELOAD_THRESHOLD_MS = 3 * 60 * 1000;

// Matches web-client's showOnly() section names. The landing screen is a
// single button and doesn't need the same vertical space as the connect
// screen (QR code + code field + camera-scan button), so the window starts
// small and only grows once there's actually more to show.
const STATE_SIZES = {
  start: { width: 420, height: 260 },
  invite: { width: 420, height: 720 },
  scan: { width: 420, height: 640 },
  active: { width: 420, height: 640 },
  ended: { width: 420, height: 320 },
};

// electron's BrowserWindow.setBounds({...}, animate) only animates on
// macOS — on Windows/Linux the animate flag is silently ignored — so the
// grow/shrink transition is done by hand here, stepping toward the target
// size over a short duration instead of just snapping to it.
function animateResize(win, targetWidth, targetHeight, duration = 220) {
  if (!win || win.isDestroyed()) return;
  clearInterval(resizeTimer);
  const [startWidth, startHeight] = win.getSize();
  if (startWidth === targetWidth && startHeight === targetHeight) return;
  const startTime = Date.now();
  resizeTimer = setInterval(() => {
    if (win.isDestroyed()) {
      clearInterval(resizeTimer);
      return;
    }
    const t = Math.min(1, (Date.now() - startTime) / duration);
    const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
    const width = Math.round(startWidth + (targetWidth - startWidth) * eased);
    const height = Math.round(startHeight + (targetHeight - startHeight) * eased);
    win.setSize(width, height);
    if (t >= 1) clearInterval(resizeTimer);
  }, 14);
}

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
    width: STATE_SIZES.start.width,
    height: STATE_SIZES.start.height,
    minWidth: 360,
    minHeight: 220,
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
  // keep in sync with it. /app specifically (not the bare root) — root now
  // serves beamlot.com's marketing landing page; the actual pairing app
  // lives at /app (see relay-server/index.js's routing).
  mainWindow.loadURL(`${RELAY_URL}/app`);
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
  // A window left hidden in the tray for a long time can end up with a
  // silently-dead SSE connection (see the watchdog in web-client/src/
  // app.js) — the renderer isn't destroyed while hidden, so its JS keeps
  // running, but the underlying connection can still go stale without the
  // page ever finding out promptly. Telling it to recheck the instant the
  // window is actually shown again means that's already fixed by the time
  // anyone's looking, rather than needing a full quit-and-relaunch.
  mainWindow.on('hide', () => {
    hiddenSince = Date.now();
  });
  mainWindow.on('show', () => {
    // Defense in depth (see HIDDEN_RELOAD_THRESHOLD_MS above): a full
    // reload if it's been hidden long enough, on top of the targeted
    // resume-check that handles the common case cheaply.
    if (hiddenSince && Date.now() - hiddenSince > HIDDEN_RELOAD_THRESHOLD_MS) {
      mainWindow.webContents.reload();
    } else {
      mainWindow.webContents.send('resume-check');
    }
    hiddenSince = null;
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

  // The other half of the "stale after being idle" fix, for the case the
  // window was actually still visible when the machine slept — 'show'
  // above only fires on a visibility transition, which an already-visible
  // window waking up alongside the OS doesn't trigger. A real sleep/wake
  // cycle reliably kills network connections regardless of how long it
  // slept, so this is an unconditional reload rather than the
  // duration-gated one on 'show' — a full reload already re-establishes
  // the SSE connection from scratch, so there's no need to also send
  // resume-check.
  powerMonitor.on('resume', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
  });

  // A live SSE arrival in the shared web-client page (web-client/src/app.js)
  // calls window.beamNative.itemReceived(...) via preload.js — this is what
  // keeps the relay forgetting its copy after 2 minutes from also meaning
  // "the PC never actually got it."
  ipcMain.on('item-received', async (event, item, relayUrl, token) => {
    try {
      if (item.type === 'link') {
        saveLink(item);
        // Electron's native clipboard module, not the web Clipboard API —
        // more reliable than navigator.clipboard from a background renderer
        // context, and this is exactly what earlier versions of this app
        // did before the ephemeral-pairing rewrite dropped it. The whole
        // point of beaming a link over is to use it right away.
        clipboard.writeText(item.content);
        notify('Link received — copied to clipboard', item.content);
      } else if (item.type === 'photo') {
        const savedPath = await savePhoto(item, relayUrl, token);
        notify('Photo received', savedPath);
      }
    } catch (err) {
      console.error('failed to save received item', err);
    }
  });

  ipcMain.on('resize-window', (event, state) => {
    const size = STATE_SIZES[state] || STATE_SIZES.start;
    animateResize(mainWindow, size.width, size.height);
  });

  ipcMain.on('quit', () => {
    app.isQuitting = true;
    app.quit();
  });
});

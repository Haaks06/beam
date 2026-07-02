const path = require('node:path');
const { app, BrowserWindow, Notification, clipboard, ipcMain, shell } = require('electron');

// Must run before any local require that touches app.getPath('userData')
// (store.js and saveHandlers.js both compute paths at module-load time) —
// the npm package name stays "desktop-app" (matches the workspace folder),
// but the product Electron reports to Windows, and the userData/Documents
// folder names, should be the real product name.
app.setName('Beam');

const store = require('./store');
const RelayClient = require('./relayClient');
const { saveLink, savePhoto, LINKS_DIR, PHOTOS_DIR } = require('./saveHandlers');
const { createTray } = require('./tray');

// Packaged installs default to the hosted relay so they work with zero
// setup; process.env.RELAY_URL overrides this for local development
// (see README.md's "Running locally" section).
const DEFAULT_RELAY_URL = process.env.RELAY_URL || 'https://share-to-pc-relay.onrender.com';
const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');
const APP_NAME = 'Beam';
const MAX_RECENT_ITEMS = 20;

let tray;
let pairingWindow;
let welcomeWindow;
let hubWindow;
let relayClient;
let status = 'starting';
let recentItems = [];

function setStatus(next) {
  status = next;
  hubWindow?.webContents.send('status-updated', status);
}

app.whenReady().then(async () => {
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
    onLeftClick: () => toggleHubWindow(),
    onQuit: () => app.quit(),
  });
  tray = trayHandle.tray;

  registerIpcHandlers();

  let needsPairing;
  try {
    needsPairing = await ensureOwnDevice();
  } catch (err) {
    // Leaves config.token unset, so the next launch retries from scratch
    // instead of getting stuck with a half-initialized, unusable state.
    console.error('failed to reach relay on startup', err);
    setStatus('cannot reach relay');
    notify(`${APP_NAME} can't connect`, `Could not reach the relay at startup: ${err.message}. Quit and reopen ${APP_NAME} once you're back online.`);
    return;
  }

  if (needsPairing) {
    showWelcomeWindow(() => startRelayClient());
  } else {
    startRelayClient();
  }
});

// Render's free tier disk is ephemeral (see docs/HOSTING.md) — a redeploy
// or instance recycle can wipe the relay's database, silently invalidating
// every previously-issued token including this app's own. Without this
// check, a stale token would make every subsequent call (pairing, item
// sync) fail with 401 forever, since ensureOwnDevice() only ever looks at
// whether a token is *stored*, not whether it still *works*.
async function isTokenValid(config) {
  try {
    const res = await fetch(`${config.relayUrl}/items?since=0`, {
      headers: { Authorization: `Bearer ${config.token}` },
    });
    return res.status !== 401;
  } catch {
    // Can't reach the relay at all right now — don't treat that as an
    // invalid token (which would abandon a perfectly good inbox); let the
    // normal connect-failure handling in app.whenReady() take over instead.
    return true;
  }
}

// Returns true if a brand new inbox was minted (first run, or the old one
// was invalidated — e.g. by a Render free-tier disk wipe), meaning no
// device is paired to it yet and the welcome/QR flow should run again;
// false if an existing, still-working inbox was reused.
async function ensureOwnDevice() {
  const config = store.load();
  if (config.token && config.relayUrl && (await isTokenValid(config))) {
    return false;
  }

  const relayUrl = config.relayUrl || DEFAULT_RELAY_URL;
  // Creates a brand new, isolated inbox and mints this desktop app's owner
  // token in one call — distinct from /pair/init+claim, which is for
  // adding another device to an inbox that already exists (see
  // showPairingWindow below).
  const res = await fetch(`${relayUrl}/inbox`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'Desktop (Windows)' }),
  });
  if (!res.ok) {
    throw new Error(`relay returned ${res.status}`);
  }
  const data = await res.json();
  store.update({ relayUrl, token: data.token });
  return true;
}

function startRelayClient() {
  const config = store.load();
  relayClient = new RelayClient({
    relayUrl: config.relayUrl,
    token: config.token,
    onStatusChange: setStatus,
    onItem: (item) => handleItem(item, config),
  });
  relayClient.start();
}

function pushRecentItem(entry) {
  recentItems.unshift(entry);
  recentItems = recentItems.slice(0, MAX_RECENT_ITEMS);
  hubWindow?.webContents.send('items-updated', recentItems);
}

async function handleItem(item, config) {
  try {
    if (item.type === 'link') {
      saveLink(item);
      // The whole point of "beaming" a link over is to use it right away —
      // copy it straight to the clipboard so it's a paste away, no need to
      // dig through a notification or a file.
      clipboard.writeText(item.content);
      notify('Link copied to clipboard', item.content);
      pushRecentItem({ id: item.id, type: 'link', content: item.content, createdAt: item.createdAt });
    } else if (item.type === 'photo') {
      const savedPath = await savePhoto(item, config.relayUrl, config.token);
      notify('Photo received', savedPath);
      pushRecentItem({ id: item.id, type: 'photo', filePath: savedPath, fileName: path.basename(savedPath), createdAt: item.createdAt });
    }
  } catch (err) {
    console.error('failed to handle item', err);
  }
}

// Only shown once, on first launch: explains what the app does and gets the
// owner's phone paired immediately, instead of silently vanishing into the
// (often auto-hidden) tray icon with no explanation.
function showWelcomeWindow(onClosed) {
  const config = store.load();
  welcomeWindow = new BrowserWindow({
    width: 380,
    height: 520,
    resizable: false,
    title: `Welcome to ${APP_NAME}`,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  welcomeWindow.setMenuBarVisibility(false);
  welcomeWindow.loadFile(path.join(__dirname, 'windows', 'welcome.html'), {
    query: { relayUrl: config.relayUrl, token: config.token, firstRun: '1' },
  });
  welcomeWindow.on('closed', () => {
    welcomeWindow = null;
    notify(`${APP_NAME} is running`, 'Left-click the tray icon anytime to see recent items, pair another device, or quit.');
    onClosed?.();
  });
}

function notify(title, body) {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}

function showPairingWindow() {
  const config = store.load();
  if (!config.token || !config.relayUrl) {
    notify(`${APP_NAME} isn't connected`, 'Quit and reopen the app once you have a network connection, then try again.');
    return;
  }
  if (pairingWindow) {
    pairingWindow.focus();
    return;
  }
  pairingWindow = new BrowserWindow({
    width: 340,
    height: 420,
    resizable: false,
    title: `Pair a device — ${APP_NAME}`,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  pairingWindow.setMenuBarVisibility(false);
  pairingWindow.loadFile(path.join(__dirname, 'windows', 'pairing.html'), {
    query: { relayUrl: config.relayUrl, token: config.token },
  });
  pairingWindow.on('closed', () => {
    pairingWindow = null;
  });
}

// A small popup panel anchored near the tray icon (like Slack/Dropbox),
// rather than a regular window — shows recent items and quick actions,
// consolidating what used to be separate right-click menu entries.
function toggleHubWindow() {
  if (hubWindow) {
    hubWindow.close();
    return;
  }

  const trayBounds = tray.getBounds();
  const width = 340;
  const height = 420;
  const x = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2);
  const y = Math.round(trayBounds.y - height);

  hubWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    resizable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'windows', 'hub-preload.js'),
    },
  });
  hubWindow.loadFile(path.join(__dirname, 'windows', 'hub.html'));
  hubWindow.once('ready-to-show', () => hubWindow.show());
  hubWindow.on('blur', () => hubWindow?.close());
  hubWindow.on('closed', () => {
    hubWindow = null;
  });
}

function registerIpcHandlers() {
  ipcMain.handle('hub:get-items', () => recentItems);
  ipcMain.handle('hub:get-status', () => status);
  ipcMain.handle('hub:copy', (event, text) => clipboard.writeText(text));
  ipcMain.handle('hub:open-folder', (event, which) => shell.openPath(which === 'photos' ? PHOTOS_DIR : LINKS_DIR));
  ipcMain.handle('hub:open-photo', (event, filePath) => shell.openPath(filePath));
  ipcMain.handle('hub:pair', () => {
    hubWindow?.close();
    showPairingWindow();
  });
  ipcMain.handle('hub:quit', () => app.quit());
}

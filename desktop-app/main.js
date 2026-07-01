const path = require('node:path');
const { app, BrowserWindow, Notification } = require('electron');

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

let tray;
let rebuildMenu;
let pairingWindow;
let welcomeWindow;
let relayClient;
let status = 'starting';

app.whenReady().then(async () => {
  // Menu-bar-only app: subscribing (even with a no-op) stops Electron's
  // default behavior of quitting once every window closes on Windows/Linux.
  app.on('window-all-closed', () => {});

  // Computed before ensureOwnDevice() mutates the store, since that call is
  // what would otherwise make "do we already have a token" ambiguous.
  const isFirstRun = !store.load().token;

  const setStatus = (next) => {
    status = next;
    rebuildMenu?.(LINKS_DIR, PHOTOS_DIR);
  };

  const trayHandle = createTray({
    iconPath: ICON_PATH,
    onShowPairing: () => showPairingWindow(),
    getStatus: () => status,
    onQuit: () => app.quit(),
  });
  tray = trayHandle.tray;
  rebuildMenu = trayHandle.rebuildMenu;
  rebuildMenu(LINKS_DIR, PHOTOS_DIR);

  await ensureOwnDevice();

  if (isFirstRun) {
    showWelcomeWindow(() => startRelayClient(setStatus));
  } else {
    startRelayClient(setStatus);
  }
});

async function ensureOwnDevice() {
  const config = store.load();
  if (config.token && config.relayUrl) return config;

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
  const data = await res.json();

  return store.update({ relayUrl, token: data.token });
}

function startRelayClient(setStatus) {
  const config = store.load();
  relayClient = new RelayClient({
    relayUrl: config.relayUrl,
    token: config.token,
    onStatusChange: setStatus,
    onItem: (item) => handleItem(item, config),
  });
  relayClient.start();
}

async function handleItem(item, config) {
  try {
    if (item.type === 'link') {
      saveLink(item);
      notify('Link received', item.content);
    } else if (item.type === 'photo') {
      const savedPath = await savePhoto(item, config.relayUrl, config.token);
      notify('Photo received', savedPath);
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
    notify(`${APP_NAME} is running`, 'Right-click the tray icon anytime to pair another device or open your folders.');
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

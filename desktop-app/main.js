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
const DEFAULT_RELAY_URL = process.env.RELAY_URL || 'https://beam-wckn2w.fly.dev';
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
// Remembers where the Hub was last dragged to (in-session only), so
// reopening it doesn't snap back to the tray-anchored default every time.
let lastHubBounds = null;

// Ramps window opacity 0→1 so popups arrive as a soft fade instead of an
// abrupt pop-in. Windows must be created with show:false and opacity:0,
// then this called from their 'ready-to-show' handler.
function fadeIn(win, durationMs = 160) {
  const steps = 8;
  const stepMs = durationMs / steps;
  let i = 0;
  win.show();
  const timer = setInterval(() => {
    i += 1;
    if (!win || win.isDestroyed()) return clearInterval(timer);
    win.setOpacity(Math.min(1, i / steps));
    if (i >= steps) clearInterval(timer);
  }, stepMs);
}

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

  // Start listening immediately, regardless of whether the welcome/pairing
  // window is still open — it used to wait until that window closed, so
  // anything sent while you were still on the pairing screen (the most
  // likely moment to test it) sat undelivered until you closed the window.
  startRelayClient();
  // Deliberately independent of `needsPairing`: that flag is about whether
  // the relay token is still valid, not about whether this install has ever
  // shown the welcome/intro screen. Without this, upgrading the app on a
  // machine that already paired successfully (the common case — anyone
  // testing an update) would never see the welcome window at all, since
  // ensureOwnDevice() finds the still-valid token from the previous version
  // and reports needsPairing: false.
  if (!store.load().hasSeenWelcome) {
    showWelcomeWindow();
  }

  // Render's free tier can wipe the relay's database well before this app
  // is ever restarted (observed: even a single 15-minute idle sleep/wake
  // cycle can do it, not just redeploys) — so a token minted at startup
  // can go stale while the app keeps running. Periodically re-check and
  // silently re-provision instead of requiring "quit and reopen."
  setInterval(recoverIfTokenInvalid, 5 * 60 * 1000);
});

// If the stored token has been invalidated since we last checked, mint a
// fresh inbox and restart the relay connection with it. Any devices paired
// to the old inbox will need to re-pair (there's no way around that — the
// old inbox is simply gone), so this notifies the user rather than doing
// it silently.
async function recoverIfTokenInvalid() {
  const config = store.load();
  if (!config.token || (await isTokenValid(config))) return;

  try {
    await ensureOwnDevice();
  } catch (err) {
    console.error('failed to recover from an invalidated token', err);
    return;
  }
  relayClient?.stop();
  startRelayClient();
  notify(`${APP_NAME} reconnected`, "The relay reset and your old pairing was lost — left-click the tray icon and choose Pair device to reconnect your phone.");
}

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
    // 401 = token doesn't exist on this server; 404 = the endpoint/service
    // itself is gone (observed: our old Render deployment now 404s on
    // everything, including /health — decommissioned, not just DB-wiped).
    // Either means this config is dead and needs re-provisioning. Anything
    // else (5xx, etc.) is treated as "maybe just a transient blip," per the
    // catch block below — same reasoning, just also covering the case where
    // the server answers but definitively isn't there anymore.
    return res.status !== 401 && res.status !== 404;
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
  // Render is retired — force migration off it even if isTokenValid()
  // somehow still reads it as fine (e.g. a future Render response shape we
  // haven't seen). Belt-and-suspenders alongside the 404 check above.
  const isDeprecatedRelay = config.relayUrl && config.relayUrl.includes('onrender.com');
  if (!isDeprecatedRelay && config.token && config.relayUrl && (await isTokenValid(config))) {
    return false;
  }

  const relayUrl = isDeprecatedRelay ? DEFAULT_RELAY_URL : config.relayUrl || DEFAULT_RELAY_URL;
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
  // A new inbox has no history yet — reset lastSeenId so a stale value left
  // over from a previous (now-abandoned) inbox can't affect anything.
  store.update({ relayUrl, token: data.token, lastSeenId: 0 });
  return true;
}

function startRelayClient() {
  const config = store.load();
  relayClient = new RelayClient({
    relayUrl: config.relayUrl,
    token: config.token,
    lastSeenId: config.lastSeenId,
    onLastSeenIdChange: (id) => store.update({ lastSeenId: id }),
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
function showWelcomeWindow() {
  const config = store.load();
  welcomeWindow = new BrowserWindow({
    width: 380,
    // Tall enough for the intro video (up to 260px), the pairing content,
    // and the "join with a code" section below it, without scrolling.
    height: 840,
    resizable: false,
    show: false,
    opacity: 0,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    roundedCorners: true,
    title: `Welcome to ${APP_NAME}`,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'windows', 'pairing-preload.js'),
      // Electron already defaults to this, but pin it explicitly — a muted
      // autoplay video that silently fails to start would be a bad first
      // impression and hard to notice was even wrong.
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  welcomeWindow.setMenuBarVisibility(false);
  welcomeWindow.loadFile(path.join(__dirname, 'windows', 'welcome.html'), {
    query: { relayUrl: config.relayUrl, token: config.token, firstRun: '1' },
  });
  welcomeWindow.once('ready-to-show', () => fadeIn(welcomeWindow));
  welcomeWindow.on('closed', () => {
    welcomeWindow = null;
    store.update({ hasSeenWelcome: true });
    notify(`${APP_NAME} is running`, 'Left-click the tray icon anytime to see recent items, pair another device, or quit.');
  });
}

function notify(title, body) {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}

async function showPairingWindow() {
  // Re-validate (and silently re-provision if needed) right before opening,
  // so a token that went stale while the app was idle can't produce the
  // blank/broken QR this used to show — see recoverIfTokenInvalid above.
  try {
    if (await ensureOwnDevice()) {
      relayClient?.stop();
      startRelayClient();
    }
  } catch (err) {
    notify(`${APP_NAME} isn't connected`, 'Quit and reopen the app once you have a network connection, then try again.');
    return;
  }

  const config = store.load();
  if (pairingWindow) {
    pairingWindow.focus();
    return;
  }
  pairingWindow = new BrowserWindow({
    width: 340,
    height: 500,
    resizable: false,
    show: false,
    opacity: 0,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    roundedCorners: true,
    title: `Pair a device — ${APP_NAME}`,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'windows', 'pairing-preload.js'),
    },
  });
  pairingWindow.setMenuBarVisibility(false);
  pairingWindow.loadFile(path.join(__dirname, 'windows', 'pairing.html'), {
    query: { relayUrl: config.relayUrl, token: config.token },
  });
  pairingWindow.once('ready-to-show', () => fadeIn(pairingWindow));
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

  const width = 340;
  const height = 420;
  let x, y;
  if (lastHubBounds) {
    // Reopen wherever the user last dragged it to, rather than snapping
    // back to the tray every time — the whole point of making it movable.
    ({ x, y } = lastHubBounds);
  } else {
    const trayBounds = tray.getBounds();
    x = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2);
    y = Math.round(trayBounds.y - height);
  }

  hubWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    resizable: false,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    roundedCorners: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'windows', 'hub-preload.js'),
    },
  });
  hubWindow.loadFile(path.join(__dirname, 'windows', 'hub.html'));
  // Unlike welcome/pairing (which fade the whole window in via fadeIn(), so
  // the video/QR aren't just abruptly present), the Hub's premium entrance
  // is a CSS transform+opacity animation on its own body — cheaper, and
  // avoids stacking two competing opacity ramps on the same surface.
  hubWindow.once('ready-to-show', () => hubWindow.show());
  hubWindow.on('blur', () => hubWindow?.close());
  hubWindow.on('closed', () => {
    hubWindow = null;
  });
  hubWindow.on('moved', () => {
    if (hubWindow && !hubWindow.isDestroyed()) lastHubBounds = hubWindow.getBounds();
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

  // Lets this PC join an existing inbox by typing a code instead of always
  // being the one that generates one — the desktop app previously had no
  // way to become a *joining* device at all, only an owner.
  ipcMain.handle('pairing:claim-code', async (event, code) => {
    if (!code || typeof code !== 'string') {
      return { ok: false, error: 'enter a code' };
    }
    try {
      const res = await fetch(`${DEFAULT_RELAY_URL}/pair/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pairingCode: code.trim().toUpperCase(), label: 'Desktop (Windows)' }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { ok: false, error: data.error || `relay returned ${res.status}` };
      }
      // lastSeenId: 0 — this device has never seen this (possibly
      // different) inbox before, so it should backfill its full history.
      store.update({ relayUrl: DEFAULT_RELAY_URL, token: data.token, hasSeenWelcome: true, lastSeenId: 0 });
      relayClient?.stop();
      startRelayClient();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Notification, ipcMain, Menu, clipboard, powerMonitor, shell, globalShortcut } = require('electron');
const { autoUpdater } = require('electron-updater');

// Must run before any local require that touches app.getPath('userData') —
// the npm package name stays "desktop-app" (matches the workspace folder),
// but the product Electron reports to Windows should be the real product name.
app.setName('Beam');

// Without this, Windows has no AppUserModelID to group this app's windows/
// notifications/jump-list under, so it falls back to deriving one from the
// raw Electron executable identity instead -- the visible symptom is
// notification toasts and Windows' own notification settings showing
// something like "app.electron.beam" rather than "Beam". Must run before
// any window or Notification is created (both register against whatever
// AUMI is current at the time), and must match electron-builder.js's
// `appId` ('com.beam.desktop') -- that's what the NSIS installer writes
// into the Start Menu shortcut's own AUMI, so a mismatch here would still
// show the wrong grouping/identity for anyone running from a shortcut.
app.setAppUserModelId('com.beam.desktop');

// This app already auto-launches at login (see setLoginItemSettings below),
// so a second launch is the common case, not the exception -- Windows
// Explorer's "Beam this file" context menu (build/installer.nsh) spawns
// exactly that: `beam.exe --send "path"` while the real tray instance is
// already running. Without this lock, that would open a second, useless
// tray icon instead of handing the file to the instance already paired (or
// pairing). The losing instance must stop here, before any of the
// tray/window setup below runs.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  return;
}

// Electron shows a default File/Edit/View/Window/Help menu bar unless told
// not to — there's nothing in that menu this app uses (no File > Open, no
// Edit > Undo), and it doesn't match the frameless, themed rest of the app.
Menu.setApplicationMenu(null);

const { saveLink, savePhoto, saveFile, saveVoiceMemo, LINKS_DIR, PHOTOS_DIR, ensureFolders } = require('./saveHandlers');
const { createTray } = require('./tray');

// Packaged installs default to the hosted relay so they work with zero
// setup; process.env.RELAY_URL overrides this for local development
// (see README.md's "Running locally" section). The relay itself now
// redirects the raw fly.dev address here anyway (see index.js), but an
// already-branded default means a fresh install never even makes that
// extra hop.
const RELAY_URL = process.env.RELAY_URL || 'https://www.beamlot.com';
const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');

// Duplicated from web-client/src/app.js's looksLikeLink (same reasoning,
// see its comment there) rather than shared, since this runs in a
// separate Node/CommonJS process from the browser code -- not worth a
// shared package for one three-line regex check.
function looksLikeLink(value) {
  const trimmed = (value || '').trim();
  if (/^https?:\/\//i.test(trimmed)) return true;
  return /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(trimmed);
}

let tray;
let trayHandle;
let mainWindow;
let resizeTimer;
let hiddenSince = null;
let lastReceivedLink = null;

// -- Windows Explorer "Beam this file" (build/installer.nsh registers the
// context menu entry that launches `Beam.exe --send "path"") -----------

const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.zip': 'application/zip',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
};

// The registered Explorer command is exactly `"Beam.exe" --send "%1"` (see
// build/installer.nsh), so the file path is always the last argument --
// safer than assuming it's strictly the element right after '--send'.
// Electron's own dev-mode argv handling (running unpackaged via `electron
// .`) has been observed injecting its own flags (e.g.
// --allow-file-access-from-files) between the two, which breaks a strict
// adjacency check; the path still reliably lands last either way.
function extractSendPath(argv) {
  const idx = argv.indexOf('--send');
  return idx !== -1 ? argv[argv.length - 1] : null;
}

// Set when a file arrives (via --send or the clipboard tray menu) before
// the window has finished its initial load -- flushed by the
// did-finish-load handler in createMainWindow() below, since sending it
// any earlier would race window.beamNative.onQueuedFile not being wired up
// in the page yet.
let pendingFilePayload = null;

function deliverQueuedFile(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    // Shouldn't normally happen (the window is only ever hidden, never
    // destroyed, until a real quit ends the whole process) -- recreating it
    // here is cheap insurance against relying on that invariant forever.
    pendingFilePayload = payload;
    createMainWindow();
    return;
  }
  if (!mainWindow.webContents.isLoadingMainFrame()) {
    mainWindow.webContents.send('queued-file', payload);
    mainWindow.show();
    mainWindow.focus();
  } else {
    pendingFilePayload = payload;
  }
}

function queueFileToSend(filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) return console.error('[send] failed to read', filePath, err);
    deliverQueuedFile({
      name: path.basename(filePath),
      mimeType: MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      dataBase64: data.toString('base64'),
    });
  });
}

// A second launch (e.g. Explorer's context menu while the tray instance is
// already running) hands its argv here instead of opening a second window
// -- see the single-instance lock above.
app.on('second-instance', (event, argv) => {
  const filePath = extractSendPath(argv);
  if (filePath) {
    queueFileToSend(filePath);
  } else if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createMainWindow();
  }
});

// -- Clipboard watching (one-click send) ---------------------------------
// Polls rather than something event-driven since Electron's clipboard
// module has no change-notification API of its own on Windows. 1.2s is
// frequent enough that "copy, then click Beam" feels immediate without
// noticeably burning CPU for something this cheap to read.
const CLIPBOARD_POLL_MS = 1200;
let lastSeenClipboardText = '';
let lastSeenClipboardImageDataUrl = null;
let pendingClipboardSend = null; // { kind: 'text', text } | { kind: 'image', dataBase64 }

// Called right after this app's own clipboard.writeText (see the
// 'item-received' handler below, which copies a just-*received* link so
// it's ready to paste) so the watcher's next poll doesn't mistake that for
// something the user just copied themselves and wants to *send*.
function noteOwnClipboardWrite(text) {
  lastSeenClipboardText = text;
}

function startClipboardWatcher(onReadyChange) {
  lastSeenClipboardText = clipboard.readText();
  const initialImage = clipboard.readImage();
  lastSeenClipboardImageDataUrl = initialImage.isEmpty() ? null : initialImage.toDataURL();

  setInterval(() => {
    // Images take priority over text: copying an image from most apps
    // (browsers, Explorer thumbnails, editors) also populates a text/HTML
    // clipboard format as a side effect, which would otherwise be
    // misdetected as "new text to send" on the very same poll.
    const image = clipboard.readImage();
    const imageDataUrl = image.isEmpty() ? null : image.toDataURL();
    if (imageDataUrl && imageDataUrl !== lastSeenClipboardImageDataUrl) {
      lastSeenClipboardImageDataUrl = imageDataUrl;
      lastSeenClipboardText = clipboard.readText();
      pendingClipboardSend = { kind: 'image', dataBase64: image.toPNG().toString('base64') };
      onReadyChange(true);
      return;
    }
    if (!imageDataUrl) lastSeenClipboardImageDataUrl = null;

    const text = clipboard.readText();
    if (text && text !== lastSeenClipboardText) {
      lastSeenClipboardText = text;
      pendingClipboardSend = { kind: 'text', text };
      onReadyChange(true);
    }
  }, CLIPBOARD_POLL_MS);
}

function sendPendingClipboard() {
  if (!pendingClipboardSend) return;
  const item = pendingClipboardSend;
  pendingClipboardSend = null;
  if (item.kind === 'text') {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('queued-text', item.text);
      mainWindow.show();
      mainWindow.focus();
    }
  } else {
    deliverQueuedFile({ name: `clipboard-${Date.now()}.png`, mimeType: 'image/png', dataBase64: item.dataBase64 });
  }
}

// Defense in depth, on top of the real fix (the exponential-backoff +
// staleness watchdog in web-client/src/app.js, which is what actually
// keeps the SSE connection alive or promptly reconnects it): if the
// window sat hidden long enough that ANYTHING else about the page's state
// might have gone stale — not just the SSE connection — a full reload is
// cheap insurance. Deliberately much longer than the web-client's own 40s
// staleness threshold, since the real fix should already have recovered
// the connection well before this ever fires; this is only a backstop.
const HIDDEN_RELOAD_THRESHOLD_MS = 3 * 60 * 1000;

// Matches web-client's showOnly() section names. The landing screen needs
// less vertical space than the connect screen (QR code + code field +
// camera-scan button), so the window starts smaller and only grows once
// there's actually more to show. Each height is measured against the real
// rendered content (not guessed), including the status line + version
// footer every screen ends with -- a taller-than-content window here is
// exactly what shows up as dead space before that footer.
const STATE_SIZES = {
  start: { width: 420, height: 350 },
  invite: { width: 420, height: 620 },
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

// Shared by the tray menu's checkbox and the in-app Settings tab's toggle
// (see preload.js's beamNative.setAutoLaunch) -- both need to end up at the
// same OS-level call and keep the other surface's UI in sync, rather than
// each maintaining its own notion of the current state.
function setAutoLaunch(enabled) {
  // Windows Store/MSIX builds: verified against Electron's own docs and by
  // checking this machine's registry after toggling it in a sideloaded
  // build -- app.setLoginItemSettings() "will return true for all calls
  // but the registry key it sets won't be accessible by other
  // applications," i.e. it silently no-ops instead of actually
  // registering a startup entry Windows Settings/Task Manager can see (no
  // entry ever appeared under HKCU's StartupApproved\StartupTasks here).
  // The real MSIX mechanism is the manifest's windows.startupTask
  // extension (see electron-builder.js's addAutoLaunchExtension) driven
  // through the WinRT StartupTask API, which Electron doesn't project
  // natively -- not implemented here. Skipping the doomed OS call under
  // process.windowsStore and telling the user directly beats leaving a
  // toggle that looks like it worked but silently does nothing -- see
  // STORE.md for the known-gap writeup.
  if (app.isPackaged && !process.windowsStore) {
    app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath });
  } else if (process.windowsStore) {
    notify('Start at login not yet available', 'This isn’t wired up in the Store version yet -- coming in a future update.');
  }
  trayHandle?.setAutoLaunch(enabled);
}

function notify(title, body) {
  if (Notification.isSupported()) {
    // Without an explicit icon, Windows falls back to a generic Electron
    // icon in the toast -- the one place besides the taskbar this app's
    // brand mark shows up outside its own window, so it's worth setting
    // deliberately rather than leaving it to that default.
    new Notification({ title, body, icon: ICON_PATH }).show();
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
      // Chrome/Chromium escalates timer throttling the longer a page stays
      // hidden -- by several minutes in, a background page's setInterval/
      // setTimeout can be capped to roughly once a minute ("intensive
      // throttling"). This app lives hidden in the tray for exactly that
      // long as its normal resting state, and both the SSE staleness
      // watchdog and the reconnect backoff timer in web-client/src/app.js
      // depend on firing on their normal schedule the whole time it's
      // hidden, not just for the first few minutes. Without this, "reliable
      // while minimized" would start silently degrading back toward
      // browser-tab behavior right around the point a 20+ minute background
      // session is meant to prove it doesn't.
      backgroundThrottling: false,
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
  mainWindow.webContents.once('did-finish-load', () => {
    if (pendingFilePayload) {
      const payload = pendingFilePayload;
      pendingFilePayload = null;
      deliverQueuedFile(payload);
    }
  });
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
    // The user is looking at the window again -- whatever the received
    // indicator was flagging has been seen now.
    trayHandle?.setReceivedIndicator(false);
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
  // be manually started each session, on by default since that's what a
  // tray utility like this is expected to do. Skipped in dev (electron .)
  // since that would register the electron.exe shell itself as a login
  // item. Only forced on the very first run: Windows already remembers
  // whatever setLoginItemSettings last set at the OS level, so doing this
  // unconditionally on every launch would silently re-enable it the moment
  // someone turns it off via the tray's own toggle below.
  // Skipped entirely under process.windowsStore -- see setAutoLaunch()'s
  // comment for why the underlying OS call is a silent no-op there. Still
  // writing the marker would just permanently suppress a feature that
  // never actually ran, for no benefit; not writing it costs nothing since
  // this whole block is skipped again on every future launch anyway.
  const autoLaunchMarker = path.join(app.getPath('userData'), 'autolaunch-initialized');
  if (app.isPackaged && !process.windowsStore && !fs.existsSync(autoLaunchMarker)) {
    app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
    fs.mkdirSync(path.dirname(autoLaunchMarker), { recursive: true });
    fs.writeFileSync(autoLaunchMarker, '');
  }

  // Packaged installs check the update feed on launch; electron-updater
  // silently no-ops in dev. Uses the GitHub Releases provider (see
  // package.json's build.publish) since this repo is public -- errors are
  // logged, not surfaced to the user, since a failed update check shouldn't
  // read as the app itself being broken. Never runs under
  // process.windowsStore: Store apps must update through the Store, not a
  // self-fetched installer -- besides being against Store policy, the
  // GitHub feed only ever publishes the nsis .exe, which wouldn't even be
  // a valid update mechanism for an MSIX install.
  if (app.isPackaged && !process.windowsStore) {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.error('update check failed', err);
    });
  }

  ensureFolders();

  trayHandle = createTray({
    iconPath: ICON_PATH,
    onLeftClick: toggleMainWindow,
    onQuit: () => {
      app.isQuitting = true;
      app.quit();
    },
    onCopyLastLink: () => {
      if (lastReceivedLink) clipboard.writeText(lastReceivedLink);
    },
    onOpenLinksFolder: () => shell.openPath(LINKS_DIR),
    onOpenPhotosFolder: () => shell.openPath(PHOTOS_DIR),
    onSendClipboard: () => {
      sendPendingClipboard();
      trayHandle.setClipboardReady(false);
    },
    onToggleAutoLaunch: (enabled) => setAutoLaunch(enabled),
    autoLaunchEnabled: app.isPackaged ? app.getLoginItemSettings().openAtLogin : false,
  });
  tray = trayHandle.tray;

  startClipboardWatcher((ready) => trayHandle.setClipboardReady(ready));

  createMainWindow();

  // The app's own first launch can be `Beam.exe --send "path"` too -- e.g.
  // right-clicking a file before Beam has ever been auto-launched this
  // session (auto-launch is on by default, but a user can turn it off --
  // see tray.js's toggle).
  const initialSendPath = extractSendPath(process.argv);
  if (initialSendPath) queueFileToSend(initialSendPath);

  // Global hotkey: brings the window forward rather than firing an
  // immediate clipboard send. An instant, no-confirmation send bound to a
  // hotkey is one stray keypress away from beaming whatever happens to be
  // on the clipboard at that moment (a password, an address, anything) to
  // whoever's currently paired -- the tray's own "Send clipboard now" (see
  // startClipboardWatcher above) already covers that action, deliberately
  // one visible click away instead. Bring-to-front is the same kind of
  // convenience without that risk, and covers the more common need: Beam
  // is usually reached for to paste something that just arrived, not to
  // send something out.
  const HOTKEY = 'Control+Shift+B';
  if (!globalShortcut.register(HOTKEY, toggleMainWindow)) {
    console.error(`[hotkey] failed to register ${HOTKEY} (likely already claimed by another app)`);
  }
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });

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
  // keeps the relay forgetting its copy once the session ends from also
  // meaning "the PC never actually got it."
  ipcMain.on('item-received', async (event, item, relayUrl, token) => {
    try {
      if (item.type === 'link') {
        saveLink(item);
        // Only an actual link auto-copies -- a plain-text note sent
        // through the same field still gets saved to links.jsonl (it's
        // just a log file, nothing overwritten by keeping it there) but
        // doesn't silently land on the clipboard, which used to happen for
        // every 'link'-type item regardless of whether it looked like one.
        if (looksLikeLink(item.content)) {
          // Electron's native clipboard module, not the web Clipboard API —
          // more reliable than navigator.clipboard from a background
          // renderer context, and this is exactly what earlier versions of
          // this app did before the ephemeral-pairing rewrite dropped it.
          // The whole point of beaming a link over is to use it right away.
          clipboard.writeText(item.content);
          noteOwnClipboardWrite(item.content);
          lastReceivedLink = item.content;
          trayHandle.setLastLinkAvailable(true);
          notify('Link received — copied to clipboard', item.content);
        } else {
          notify('Text received', item.content);
        }
        trayHandle.setReceivedIndicator(true);
      } else if (item.type === 'photo') {
        const savedPath = await savePhoto(item, relayUrl, token);
        notify('Photo received', `Saved as ${path.basename(savedPath)} in Pictures\\Beam`);
        trayHandle.setReceivedIndicator(true);
      } else if (item.type === 'file') {
        const savedPath = await saveFile(item, relayUrl, token);
        notify('File received', `Saved as ${path.basename(savedPath)} in Documents\\Beam Files`);
        trayHandle.setReceivedIndicator(true);
      } else if (item.type === 'voice') {
        const savedPath = await saveVoiceMemo(item, relayUrl, token);
        notify('Voice memo received', `Saved as ${path.basename(savedPath)} in Music\\Beam`);
        trayHandle.setReceivedIndicator(true);
      }
    } catch (err) {
      console.error('failed to save received item', err);
    }
  });

  ipcMain.on('resize-window', (event, state) => {
    const size = STATE_SIZES[state] || STATE_SIZES.start;
    animateResize(mainWindow, size.width, size.height);
    // Reuses this exact same signal (web-client's showOnly() already sends
    // it on every state transition) as the tray's live pairing-status
    // indicator, rather than adding a second IPC channel for what's really
    // the same event.
    trayHandle.setStatus(state);
  });

  ipcMain.on('quit', () => {
    app.isQuitting = true;
    app.quit();
  });

  ipcMain.handle('get-auto-launch', () => (app.isPackaged ? app.getLoginItemSettings().openAtLogin : false));
  ipcMain.on('set-auto-launch', (event, enabled) => setAutoLaunch(enabled));
});

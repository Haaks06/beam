const path = require('node:path');
const { Tray, Menu, nativeImage } = require('electron');

// Human-readable label for each of web-client's showOnly() section names
// (see preload.js's resizeWindow bridge, which already sends this exact
// string on every state transition — reused here rather than adding a
// second IPC channel just for status).
const STATUS_LABELS = {
  start: 'Not paired',
  invite: 'Waiting to pair…',
  scan: 'Scanning for a code…',
  active: 'Paired',
  ended: 'Session ended',
};

// Three distinct icon states rather than one static icon with a badge --
// see desktop-app's visual pass for the actual artwork. Filenames are
// resolved relative to iconPath's own directory so callers keep passing
// just one path, same as before this existed.
const ICON_FILENAMES = {
  idle: 'icon.png',
  clipboardReady: 'icon-clipboard-ready.png',
  received: 'icon-received.png',
};

function loadTrayIcon(assetsDir, filename) {
  const image = nativeImage.createFromPath(path.join(assetsDir, filename));
  return image.isEmpty() ? image : image.resize({ width: 16, height: 16 });
}

// Left-click toggles the main window (the same live web-client page a
// phone gets — see main.js's toggleMainWindow); right-click opens this
// native menu as a fallback/quick-actions surface, since not everyone
// expects a left-click app on Windows and reopening the full window just
// to copy a link or check a folder is more friction than a tray app should
// need.
function createTray({
  iconPath,
  onLeftClick,
  onQuit,
  onCopyLastLink,
  onOpenLinksFolder,
  onOpenPhotosFolder,
  onSendClipboard,
  onToggleAutoLaunch,
  autoLaunchEnabled,
}) {
  const assetsDir = path.dirname(iconPath);
  const icons = {
    idle: loadTrayIcon(assetsDir, ICON_FILENAMES.idle),
    clipboardReady: loadTrayIcon(assetsDir, ICON_FILENAMES.clipboardReady),
    received: loadTrayIcon(assetsDir, ICON_FILENAMES.received),
  };
  // Falls back to whichever named icon actually loaded if a state-specific
  // one is missing (e.g. a dev checkout without every asset file) rather
  // than showing a blank tray icon.
  const fallbackIcon = icons.idle.isEmpty() ? icons.clipboardReady : icons.idle;
  for (const key of Object.keys(icons)) {
    if (icons[key].isEmpty()) icons[key] = fallbackIcon;
  }

  const tray = new Tray(icons.idle);

  let status = 'start';
  let lastLinkAvailable = false;
  let clipboardReady = false;
  let receivedIndicator = false;
  let autoLaunch = autoLaunchEnabled;

  function currentIconKey() {
    if (receivedIndicator) return 'received';
    if (clipboardReady) return 'clipboardReady';
    return 'idle';
  }

  function rebuildMenu() {
    tray.setImage(icons[currentIconKey()]);
    const menu = Menu.buildFromTemplate([
      { label: `Beam — ${STATUS_LABELS[status] || STATUS_LABELS.start}`, enabled: false },
      { type: 'separator' },
      { label: 'Open Beam', click: onLeftClick },
      { label: 'Copy last received link', enabled: lastLinkAvailable, click: onCopyLastLink },
      {
        label: clipboardReady ? 'Send clipboard now' : 'Send clipboard now (nothing new copied)',
        enabled: clipboardReady,
        click: onSendClipboard,
      },
      { type: 'separator' },
      { label: 'Open Links folder', click: onOpenLinksFolder },
      { label: 'Open Photos folder', click: onOpenPhotosFolder },
      { type: 'separator' },
      {
        label: 'Start Beam at login',
        type: 'checkbox',
        checked: autoLaunch,
        click: (menuItem) => {
          autoLaunch = menuItem.checked;
          onToggleAutoLaunch(autoLaunch);
        },
      },
      { type: 'separator' },
      { label: 'Quit', click: onQuit },
    ]);
    tray.setContextMenu(menu);
    tray.setToolTip(`Beam — ${STATUS_LABELS[status] || STATUS_LABELS.start}`);
  }

  rebuildMenu();
  tray.on('click', onLeftClick);

  return {
    tray,
    setStatus(nextStatus) {
      if (!(nextStatus in STATUS_LABELS) || nextStatus === status) return;
      status = nextStatus;
      rebuildMenu();
    },
    setLastLinkAvailable(available) {
      if (available === lastLinkAvailable) return;
      lastLinkAvailable = available;
      rebuildMenu();
    },
    setClipboardReady(ready) {
      if (ready === clipboardReady) return;
      clipboardReady = ready;
      rebuildMenu();
    },
    setReceivedIndicator(active) {
      if (active === receivedIndicator) return;
      receivedIndicator = active;
      rebuildMenu();
    },
    // Keeps this checkbox in sync when auto-launch is toggled from the
    // in-app Settings tab instead of this menu (see main.js's
    // 'set-auto-launch' IPC handler) -- without this, toggling it in one
    // place would leave the other surface showing a stale checked state.
    setAutoLaunch(enabled) {
      if (enabled === autoLaunch) return;
      autoLaunch = enabled;
      rebuildMenu();
    },
  };
}

module.exports = { createTray };

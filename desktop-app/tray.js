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

// Left-click toggles the main window (the same live web-client page a
// phone gets — see main.js's toggleMainWindow); right-click opens this
// native menu as a fallback/quick-actions surface, since not everyone
// expects a left-click app on Windows and reopening the full window just
// to copy a link or check a folder is more friction than a tray app should
// need.
function createTray({ iconPath, onLeftClick, onQuit, onCopyLastLink, onOpenLinksFolder, onOpenPhotosFolder }) {
  const image = nativeImage.createFromPath(iconPath);
  const tray = new Tray(image.isEmpty() ? image : image.resize({ width: 16, height: 16 }));

  let status = 'start';
  let lastLinkAvailable = false;

  function rebuildMenu() {
    const menu = Menu.buildFromTemplate([
      { label: `Beam — ${STATUS_LABELS[status] || STATUS_LABELS.start}`, enabled: false },
      { type: 'separator' },
      { label: 'Open Beam', click: onLeftClick },
      { label: 'Copy last received link', enabled: lastLinkAvailable, click: onCopyLastLink },
      { type: 'separator' },
      { label: 'Open Links folder', click: onOpenLinksFolder },
      { label: 'Open Photos folder', click: onOpenPhotosFolder },
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
  };
}

module.exports = { createTray };

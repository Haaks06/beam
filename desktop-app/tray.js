const { Tray, Menu, nativeImage } = require('electron');

// Left-click opens the Hub popup (recent items, pairing, folders, quit —
// see main.js's toggleHubWindow); right-click keeps a minimal native menu
// as a fallback since not everyone expects a left-click app on Windows.
function createTray({ iconPath, onLeftClick, onQuit }) {
  const image = nativeImage.createFromPath(iconPath);
  const tray = new Tray(image.isEmpty() ? image : image.resize({ width: 16, height: 16 }));
  tray.setToolTip('Beam');

  tray.on('click', onLeftClick);

  const menu = Menu.buildFromTemplate([
    { label: 'Open Beam', click: onLeftClick },
    { type: 'separator' },
    { label: 'Quit', click: onQuit },
  ]);
  tray.setContextMenu(menu);

  return { tray };
}

module.exports = { createTray };

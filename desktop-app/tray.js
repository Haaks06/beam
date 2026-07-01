const path = require('node:path');
const { Tray, Menu, shell, nativeImage } = require('electron');

function createTray({ iconPath, onShowPairing, getStatus, onQuit }) {
  const image = nativeImage.createFromPath(iconPath);
  const tray = new Tray(image.isEmpty() ? image : image.resize({ width: 16, height: 16 }));
  tray.setToolTip('Beam');

  const rebuildMenu = (linksDir, photosDir) => {
    const menu = Menu.buildFromTemplate([
      { label: `Status: ${getStatus()}`, enabled: false },
      { type: 'separator' },
      { label: 'Show pairing QR (add a device)', click: onShowPairing },
      { label: 'Open photos folder', click: () => shell.openPath(photosDir) },
      { label: 'Open links folder', click: () => shell.openPath(linksDir) },
      { type: 'separator' },
      { label: 'Quit', click: onQuit },
    ]);
    tray.setContextMenu(menu);
  };

  return { tray, rebuildMenu };
}

module.exports = { createTray };

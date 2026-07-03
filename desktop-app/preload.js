const { contextBridge, ipcRenderer } = require('electron');

// The only bridge this app needs now: the renderer IS the same web-client
// page a phone gets (see main.js's loadURL), so everything else — pairing,
// sending, receiving, the countdown — is just that page's own JS. This
// bridge exists purely so a live (non-backlog) arrival can also land in the
// PC's Documents/Beam or Pictures/Beam folder and trigger a native
// notification, same as the old Electron-only Hub did.
contextBridge.exposeInMainWorld('beamNative', {
  itemReceived: (item, relayUrl, token) => ipcRenderer.send('item-received', item, relayUrl, token),
  quit: () => ipcRenderer.send('quit'),
  // Lets main.js grow/shrink the window to fit whichever section is showing
  // — the landing screen is just one button, but the connect screen needs
  // room for a QR code, a code field, and a camera-scan button. See
  // showOnly() in app.js, the single place every state transition passes
  // through.
  resizeWindow: (state) => ipcRenderer.send('resize-window', state),
  // main.js fires this when the window is shown from the tray or the
  // system wakes from sleep — either can leave a long-idle SSE connection
  // silently dead (see the watchdog in src/app.js), and this is what makes
  // that recheck happen the instant the window is actually looked at again
  // instead of waiting for the next periodic watchdog tick.
  onResumeCheck: (callback) => ipcRenderer.on('resume-check', () => callback()),
});

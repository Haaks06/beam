const { contextBridge, ipcRenderer } = require('electron');

// Lets welcome.html/pairing.html join an existing inbox by typing a code
// instead of only ever generating one — useful when a second PC has no
// camera to scan a QR with, or the two devices just aren't near each other.
contextBridge.exposeInMainWorld('beamPair', {
  claimCode: (code) => ipcRenderer.invoke('pairing:claim-code', code),
  signupAccount: (username, password) => ipcRenderer.invoke('pairing:signup-account', username, password),
  loginAccount: (username, password) => ipcRenderer.invoke('pairing:login-account', username, password),
});

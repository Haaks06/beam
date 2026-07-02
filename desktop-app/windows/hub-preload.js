const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('beam', {
  getItems: () => ipcRenderer.invoke('hub:get-items'),
  getStatus: () => ipcRenderer.invoke('hub:get-status'),
  copyText: (text) => ipcRenderer.invoke('hub:copy', text),
  openFolder: (which) => ipcRenderer.invoke('hub:open-folder', which),
  openPhoto: (filePath) => ipcRenderer.invoke('hub:open-photo', filePath),
  pairDevice: () => ipcRenderer.invoke('hub:pair'),
  quit: () => ipcRenderer.invoke('hub:quit'),
  onItemsUpdated: (cb) => ipcRenderer.on('items-updated', (_event, items) => cb(items)),
  onStatusUpdated: (cb) => ipcRenderer.on('status-updated', (_event, status) => cb(status)),
});

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widgetAPI', {
  onUsageData: (cb) => ipcRenderer.on('usage-data', (_event, data) => cb(data)),
  refreshNow: () => ipcRenderer.send('refresh-now'),
  openLogin: () => ipcRenderer.send('open-login')
});

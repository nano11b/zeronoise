const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('picker', {
  onSources: (fn) => ipcRenderer.on('picker:sources', (_event, sources) => fn(sources)),
  choose: (id) => ipcRenderer.send('picker:choose', id),
  cancel: () => ipcRenderer.send('picker:cancel'),
});

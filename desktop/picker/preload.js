const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pickerAPI', {
  onSources: (handler) => {
    ipcRenderer.on('screenshare-picker:sources', (_event, payload) => handler(payload));
  },
  selectSource: (payload) => {
    ipcRenderer.send('screenshare-picker:selected', payload);
  },
  cancel: () => {
    ipcRenderer.send('screenshare-picker:cancel');
  },
});

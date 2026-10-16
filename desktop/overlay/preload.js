const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayAPI', {
  /** The current voice state (see client/src/features/voice/voiceOverlayState.ts), or null when leaving voice. */
  onState: (handler) => {
    ipcRenderer.on('overlay:state', (_event, state) => handler(state));
  },
  /** Height of the card in CSS pixels, so the window can hug it. */
  reportSize: (height) => {
    ipcRenderer.send('overlay:size', { height });
  },
});

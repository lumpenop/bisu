'use strict';
// The only bridge between the engine's page and the desktop shell. Everything the page can do
// here is shell chrome (context chips, hide, open the full window); the chats themselves stay
// on the engine's own token-guarded HTTP API.
const {contextBridge, ipcRenderer} = require('electron');

const onContext = new Set();

ipcRenderer.on('bisu:context', (_e, ctx) => {for (const fn of onContext) try {fn(ctx)} catch {}});

contextBridge.exposeInMainWorld('bisuHost', {
  panel: true,
  platform: process.platform,
  context: () => ipcRenderer.invoke('bisu:context'),
  consume: () => ipcRenderer.invoke('bisu:consume'),
  session: (sessionId, cwd) => ipcRenderer.send('bisu:session', {sessionId, cwd}),
  hide: () => ipcRenderer.send('bisu:hide'),
  openFull: () => ipcRenderer.send('bisu:full'),
  onContext: fn => {onContext.add(fn); return () => onContext.delete(fn)},
  selectionEnabled: () => ipcRenderer.invoke('bisu:selection-enabled'),
  setSelectionEnabled: on => ipcRenderer.invoke('bisu:selection-enabled', !!on),
});

// Escape puts the panel away; it never closes a window or interrupts an answer.
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !e.isComposing && !e.defaultPrevented) {
    e.preventDefault();
    ipcRenderer.send('bisu:hide');
  }
}, true);

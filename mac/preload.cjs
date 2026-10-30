'use strict';
// The only bridge between the engine's page and the desktop shell. Everything the page can do
// here is shell chrome (context chips, hide, open the full window); the chats themselves stay
// on the engine's own token-guarded HTTP API.
const {contextBridge, ipcRenderer} = require('electron');

const onContext = new Set();
const onShown = new Set();
const onHidden = new Set();

ipcRenderer.on('dec-intern:context', (_e, ctx) => {for (const fn of onContext) try {fn(ctx)} catch {}});
ipcRenderer.on('dec-intern:shown', () => {for (const fn of onShown) try {fn()} catch {}});
ipcRenderer.on('dec-intern:hidden', () => {for (const fn of onHidden) try {fn()} catch {}});

contextBridge.exposeInMainWorld('decInternHost', {
  panel: true,
  platform: process.platform,
  context: () => ipcRenderer.invoke('dec-intern:context'),
  consume: () => ipcRenderer.invoke('dec-intern:consume'),
  session: (sessionId, cwd) => ipcRenderer.send('dec-intern:session', {sessionId, cwd}),
  hide: () => ipcRenderer.send('dec-intern:hide'),
  openFull: () => ipcRenderer.send('dec-intern:full'),
  resize: (width, height) => ipcRenderer.invoke('dec-intern:resize', {width, height}),
  cuProbe: () => ipcRenderer.invoke('dec-intern:cu-probe'),
  accessibility: () => ipcRenderer.invoke('dec-intern:accessibility'),
  grantAccessibility: () => ipcRenderer.send('dec-intern:ax-grant'),
  dismissAccessibility: () => ipcRenderer.send('dec-intern:ax-dismiss'),
  accessibilityHintShown: () => ipcRenderer.send('dec-intern:ax-shown'),
  onContext: fn => {onContext.add(fn); return () => onContext.delete(fn)},
  onShown: fn => {onShown.add(fn); return () => onShown.delete(fn)},
  onHidden: fn => {onHidden.add(fn); return () => onHidden.delete(fn)},
  selectionEnabled: () => ipcRenderer.invoke('dec-intern:selection-enabled'),
  setSelectionEnabled: on => ipcRenderer.invoke('dec-intern:selection-enabled', !!on),
});

// Escape puts the panel away; it never closes a window or interrupts an answer.
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !e.isComposing && !e.defaultPrevented) {
    e.preventDefault();
    ipcRenderer.send('dec-intern:hide');
  }
}, true);

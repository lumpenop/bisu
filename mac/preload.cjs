'use strict';
// The only bridge between the engine's page and the desktop shell. Everything the page can do
// here is shell chrome (context chips, hide, open the full window); the chats themselves stay
// on the engine's own token-guarded HTTP API.
const {contextBridge, ipcRenderer} = require('electron');

const onContext = new Set();
const onShown = new Set();
const onHidden = new Set();

ipcRenderer.on('bisu:context', (_e, ctx) => {for (const fn of onContext) try {fn(ctx)} catch {}});
ipcRenderer.on('bisu:shown', () => {for (const fn of onShown) try {fn()} catch {}});
ipcRenderer.on('bisu:hidden', () => {for (const fn of onHidden) try {fn()} catch {}});

contextBridge.exposeInMainWorld('bisuHost', {
  panel: true,
  platform: process.platform,
  context: () => ipcRenderer.invoke('bisu:context'),
  consume: () => ipcRenderer.invoke('bisu:consume'),
  session: (sessionId, cwd) => ipcRenderer.send('bisu:session', {sessionId, cwd}),
  hide: () => ipcRenderer.send('bisu:hide'),
  openFull: () => ipcRenderer.send('bisu:full'),
  resize: (width, height) => ipcRenderer.invoke('bisu:resize', {width, height}),
  cuProbe: () => ipcRenderer.invoke('bisu:cu-probe'),
  accessibility: () => ipcRenderer.invoke('bisu:accessibility'),
  grantAccessibility: () => ipcRenderer.send('bisu:ax-grant'),
  dismissAccessibility: () => ipcRenderer.send('bisu:ax-dismiss'),
  accessibilityHintShown: () => ipcRenderer.send('bisu:ax-shown'),
  onContext: fn => {onContext.add(fn); return () => onContext.delete(fn)},
  onShown: fn => {onShown.add(fn); return () => onShown.delete(fn)},
  onHidden: fn => {onHidden.add(fn); return () => onHidden.delete(fn)},
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

'use strict';
// bisu in the menu bar.
//
// One engine (ui/server.mjs, the same one `bisu ui` runs), started as a child process with the
// same key and models, and two windows onto it: a popover under the menu bar icon (⌥Space) and a
// full window for history and settings. The shell owns four things the browser page cannot:
// the frontmost app and selection as context, a tray icon, notifications when an approval is
// waiting, and staying alive with the engine between visits.
const {app, BrowserWindow, Tray, Menu, globalShortcut, screen, nativeImage, Notification, ipcMain, dialog, shell, nativeTheme} = require('electron');
const {spawn} = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const ctx = require('./context.cjs');

app.setName('bisu');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'ui', 'server.mjs');
const ICON = path.join(__dirname, 'assets', 'trayTemplate.png');
const PORT = Number(process.env.BISU_APP_PORT || 7879);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = crypto.randomBytes(24).toString('hex');
const SELF = 'bisu';
const SHORTCUT = 'Alt+Space';

let quitting = false;
let engine = null;
let engineLog = '';
let engineReady = false;
let restarting = null;
let tray = null;
let panel = null;
let full = null;
let activeChatId = null;
let pendingContext = null;
let notified = '';
let spend = null;
let hiddenAt = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const withTimeout = (p, ms, fallback) => Promise.race([p.catch(() => fallback), sleep(ms).then(() => fallback)]);

// ---- state ----
const statePath = () => path.join(app.getPath('userData'), 'desktop.json');
function readState() { try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')) || {} } catch { return {} } }
function saveState(patch) {
  try {
    fs.mkdirSync(path.dirname(statePath()), {recursive: true});
    fs.writeFileSync(statePath(), JSON.stringify({...readState(), ...patch}, null, 2));
  } catch {}
}
function defaultCwd() {
  const dir = path.join(os.homedir(), 'bisu');
  try { fs.mkdirSync(dir, {recursive: true}) } catch {}
  return dir;
}

// ---- engine ----
function run(cmd, args, timeout = 5000) {
  return new Promise(resolve => {
    const {execFile} = require('node:child_process');
    execFile(cmd, args, {timeout, maxBuffer: 1 << 20, encoding: 'utf8'}, (err, stdout) => resolve({ok: !err, out: (stdout || '').trim(), err: err ? String(err.message || err) : null}));
  });
}

let nodeBin = null;
async function resolveNode() {
  if (nodeBin) return nodeBin;
  const tries = [];
  const login = await run('/bin/zsh', ['-lc', 'command -v node'], 8000);
  if (login.ok && login.out) tries.push(login.out.split('\n').pop().trim());
  for (const d of (process.env.PATH || '').split(':')) if (d) tries.push(path.join(d, 'node'));
  tries.push('/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node');
  for (const c of tries) {
    if (!path.isAbsolute(c)) continue;
    try { fs.accessSync(c, fs.constants.X_OK) } catch { continue }
    const v = await run(c, ['-v'], 4000);
    if (v.ok && /^v\d+\./.test(v.out)) { nodeBin = c; return c }
  }
  throw Error('node was not found (bisu needs Node.js 18 or newer for its engine)');
}

function decSecret() {
  for (const c of [path.join(os.homedir(), '.local', 'bin', 'dec-secret'), '/opt/homebrew/bin/dec-secret', '/usr/local/bin/dec-secret'])
    try { fs.accessSync(c, fs.constants.X_OK); return c } catch {}
  return null;
}

async function decRef(bin) {
  const r = await run(bin, ['list'], 8000);
  if (!r.ok) return null;
  const line = r.out.split('\n').find(l => /\s+https:\/\/openrouter\.ai\s*$/.test(l));
  return line ? line.trim().split(/\s+/)[0] : null;
}

async function startEngine() {
  if (engine) { try { engine.kill('SIGTERM') } catch {} engine = null }
  engineReady = false;
  const node = await resolveNode();
  const env = {...process.env};
  // A host app's Claude/Anthropic login would win over OpenRouter, and Electron's own
  // variables must not reach the plain Node engine.
  for (const k of Object.keys(env)) if (/^(CLAUDE|ANTHROPIC|ELECTRON_)/.test(k)) delete env[k];
  Object.assign(env, {BISU_UI_NO_OPEN: '1', BISU_UI_PORT: String(PORT), BISU_UI_TOKEN: TOKEN});

  let cmd = node, args = [SERVER];
  const dec = decSecret();
  if (dec) {
    const ref = await decRef(dec);
    if (ref) { env.OPENROUTER_API_KEY = ref; cmd = dec; args = ['run', '--', node, SERVER] }
  }

  engineLog = '';
  engine = spawn(cmd, args, {cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe']});
  engine.stdout.on('data', d => { engineLog = (engineLog + d).slice(-4000) });
  engine.stderr.on('data', d => { engineLog = (engineLog + d).slice(-4000) });
  engine.on('error', e => { engineLog += '\n' + e.message });
  engine.on('exit', (code, signal) => {
    engineReady = false;
    engine = null;
    if (quitting) return;
    restartEngine(`engine exited (${signal || code})`);
  });

  const started = Date.now();
  while (Date.now() - started < 25000) {
    try {
      const r = await fetch(BASE + '/', {headers: {'X-Bisu-Token': TOKEN}});
      if (r.ok) { engineReady = true; return true }
    } catch {}
    await sleep(250);
  }
  throw Error(`the engine did not answer on ${BASE}\n${engineLog.trim()}`);
}

async function restartEngine(reason) {
  if (restarting || quitting) return restarting;
  restarting = (async () => {
    for (let i = 0; i < 3 && !quitting; i++) {
      try {
        await startEngine();
        activeChatId = null;
        await ensureChat();
        await loadPanel();
        return;
      } catch (e) {
        engineLog += `\n${String(e.message || e)}`;
        await sleep(1500);
      }
    }
  })().finally(() => { restarting = null });
  return restarting;
}

async function api(p, {method = 'GET', body} = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: {'X-Bisu-Token': TOKEN, ...(body ? {'Content-Type': 'application/json'} : {})},
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(j.error || `HTTP ${r.status}`);
  return j;
}

// The assistant is one continuing conversation: its Claude Code session id is kept on disk, so
// quitting the app and coming back tomorrow resumes the same thread.
async function ensureChat() {
  const st = readState();
  const cwd = st.cwd && fs.existsSync(st.cwd) ? st.cwd : defaultCwd();
  const make = async resume => {
    const body = {cwd};
    if (resume) body.resume = resume;
    const {chat} = await api('/api/chats', {method: 'POST', body});
    activeChatId = chat.id;
    return chat;
  };
  try { return await make(st.sessionId) }
  catch (e) {
    if (!st.sessionId) throw e;
    saveState({sessionId: null});
    return make(null);
  }
}

// ---- windows ----
const commonPrefs = {
  preload: path.join(__dirname, 'preload.cjs'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: false,
  spellcheck: true,
};

function panelURL() {
  const q = new URLSearchParams({panel: '1'});
  if (activeChatId) q.set('chat', activeChatId);
  return `${BASE}/?${q}`;
}

function createPanel() {
  panel = new BrowserWindow({
    width: 460,
    height: 640,
    minWidth: 380,
    minHeight: 320,
    show: false,
    frame: false,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    roundedCorners: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141413' : '#f7f7f5',
    webPreferences: commonPrefs,
  });
  panel.setAlwaysOnTop(true, 'pop-up-menu');
  panel.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true});
  panel.on('blur', () => {
    if (quitting || !panel || panel.webContents.isDevToolsOpened()) return;
    hiddenAt = Date.now();
    panel.hide();
  });
  panel.on('resize', savePanelBounds);
  panel.on('move', savePanelBounds);
  panel.on('closed', () => { panel = null });
  harden(panel);
}

let boundsTimer = null;
function savePanelBounds() {
  if (!panel) return;
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    if (panel && panel.isVisible()) saveState({panel: panel.getBounds()});
  }, 500);
}

function harden(win) {
  win.webContents.setWindowOpenHandler(({url}) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return {action: 'deny'};
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(BASE)) e.preventDefault() });
}

function positionPanel() {
  if (!panel || !tray) return;
  const saved = readState().panel;
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const size = panel.getBounds();
  const t = tray.getBounds();
  let x = Math.round(t.x + t.width / 2 - size.width / 2);
  let y = Math.round(t.y + t.height + 6);
  if (!t.width) { x = Math.round(area.x + area.width - size.width - 12); y = Math.round(area.y + 8) }
  x = Math.max(area.x + 8, Math.min(x, area.x + area.width - size.width - 8));
  panel.setPosition(x, y, false);
  if (saved && saved.width && saved.width !== size.width) panel.setSize(saved.width, saved.height, false);
}

async function loadPanel() {
  if (!panel) createPanel();
  await panel.loadURL(panelURL());
}

async function showPanel({capture = true} = {}) {
  if (!engineReady) { await restartEngine('not ready'); if (!engineReady) return }
  if (!panel) { createPanel(); await loadPanel() }
  else if (activeChatId && !(panel.webContents.getURL() || '').includes(activeChatId)) await loadPanel();
  if (panel.isVisible()) { panel.hide(); return }
  // Clicking the menu bar icon blurs (and hides) the panel first; that click means "hide", not "show again".
  if (Date.now() - hiddenAt < 250) return;
  pendingContext = capture
    ? await withTimeout(ctx.capture({withSelection: readState().selection !== false, selfName: SELF}), 1600, null)
    : null;
  positionPanel();
  panel.show();
  panel.focus();
  panel.webContents.focus();
  if (pendingContext) panel.webContents.send('bisu:context', pendingContext);
}

function hidePanel() { if (panel) panel.hide() }

function openFull() {
  if (full) { full.show(); full.focus(); return }
  const q = new URLSearchParams();
  if (activeChatId) q.set('chat', activeChatId);
  full = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 780,
    minHeight: 520,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: {x: 14, y: 16},
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141413' : '#f7f7f5',
    webPreferences: commonPrefs,
  });
  harden(full);
  full.loadURL(`${BASE}/?${q}`);
  full.on('closed', () => { full = null });
}

function showError(message) {
  const html = `<!doctype html><meta charset="utf-8"><body style="font:13px -apple-system;padding:18px;color:#b3261e;background:#fbf7f5">
  <b>bisu could not start</b><pre style="white-space:pre-wrap;font:12px ui-monospace;color:#333">${String(message).replace(/[<&]/g, c => c === '<' ? '&lt;' : '&amp;')}</pre>
  <p style="color:#666">Fix it, then choose “Restart engine” from the menu bar icon.</p></body>`;
  if (!panel) createPanel();
  panel.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  positionPanel();
  panel.show();
  panel.focus();
}

// ---- tray ----
function buildMenu() {
  return Menu.buildFromTemplate([
    {label: panel && panel.isVisible() ? 'Hide bisu' : `Show bisu   ${SHORTCUT}`, click: () => showPanel()},
    {label: 'Full window', click: openFull},
    {type: 'separator'},
    {label: spend == null ? 'Spend: …' : `Today: $${spend.toFixed(2)}`, enabled: false},
    {type: 'separator'},
    {
      label: 'Read selected text (Accessibility)',
      type: 'checkbox',
      checked: readState().selection !== false,
      click: item => saveState({selection: item.checked}),
    },
    {
      label: 'Working folder…',
      click: async () => {
        const st = readState();
        const r = await dialog.showOpenDialog({defaultPath: st.cwd || defaultCwd(), properties: ['openDirectory', 'createDirectory']});
        if (r.canceled || !r.filePaths[0]) return;
        saveState({cwd: r.filePaths[0], sessionId: null});
        await ensureChat();
        await loadPanel();
        showPanel({capture: false});
      },
    },
    {label: 'Restart engine', click: () => restartEngine('manual')},
    {type: 'separator'},
    {label: 'Quit bisu', accelerator: 'Command+Q', click: () => { quitting = true; app.quit() }},
  ]);
}

function createTray() {
  let img = nativeImage.createFromPath(ICON);
  if (img.isEmpty()) img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate@2x.png'));
  if (img.isEmpty()) {
    tray = new Tray(nativeImage.createEmpty());
    tray.setTitle('비');
  } else {
    img.setTemplateImage(true);
    tray = new Tray(img);
  }
  tray.setToolTip('bisu');
  tray.on('click', () => showPanel());
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
  // Proof for the log that the item really sits on screen, not just that a Tray object exists.
  setTimeout(() => {
    const b = tray.getBounds();
    console.error(`bisu: tray at ${b.x},${b.y} ${b.width}x${b.height}`);
  }, 1200);
}

// ---- watching the engine ----
let watchTimer = null;
function watch() {
  clearInterval(watchTimer);
  watchTimer = setInterval(async () => {
    if (!engineReady) { refreshTray(); return }
    try {
      const {chats} = await api('/api/chats');
      const waiting = chats.filter(c => c.pending > 0);
      const busy = chats.some(c => c.busy);
      const key = waiting.map(c => `${c.id}:${c.pending}`).join(',');
      if (key && key !== notified && !(panel && panel.isVisible())) {
        notified = key;
        notify('bisu is waiting for you', waiting.length === 1 ? 'Approve or deny what it wants to do.' : `${waiting.length} chats need an answer.`);
      } else if (!key) notified = '';
      tray?.setTitle(waiting.length ? '●' : '');
      tray?.setToolTip(waiting.length ? 'bisu · waiting for your approval' : busy ? 'bisu · working' : 'bisu');
    } catch {}
  }, 3000);
}

function notify(title, body) {
  if (!Notification.isSupported()) return;
  const n = new Notification({title, body, silent: false});
  n.on('click', () => showPanel({capture: false}));
  n.show();
}

async function readSpend() {
  try {
    const a = await api('/api/account');
    const v = a?.key?.usage_daily;
    spend = typeof v === 'number' ? v : null;
  } catch { spend = null }
}

// ---- ipc ----
ipcMain.handle('bisu:context', () => pendingContext);
ipcMain.handle('bisu:consume', () => { pendingContext = null; return true });
ipcMain.handle('bisu:selection-enabled', (_e, on) => {
  if (typeof on === 'boolean') saveState({selection: on});
  return readState().selection !== false;
});
ipcMain.on('bisu:session', (_e, {sessionId, cwd} = {}) => {
  if (sessionId && /^[0-9a-f-]{36}$/.test(sessionId)) saveState({sessionId, cwd: cwd || readState().cwd});
});
ipcMain.on('bisu:hide', () => hidePanel());
ipcMain.on('bisu:full', () => { hidePanel(); openFull() });

// ---- boot ----
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showPanel());

  app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.setActivationPolicy('accessory');
    try { app.dock?.hide() } catch {}
    createTray();
    createPanel();

    const ok = globalShortcut.register(SHORTCUT, () => showPanel());
    if (!ok) tray?.setToolTip(`bisu · ${SHORTCUT} is taken by another app`);
    console.error(`bisu: engine on ${BASE}, ${SHORTCUT} ${globalShortcut.isRegistered(SHORTCUT) ? 'ready' : 'unavailable'}`);

    try {
      await startEngine();
      const chat = await ensureChat();
      if (!chat) showError('No OpenRouter key. Save one for https://openrouter.ai in Dec, then restart.');
      await loadPanel();
    } catch (e) {
      showError(e.message || String(e));
    }

    watch();
    readSpend();
    setInterval(readSpend, 5 * 60e3);
    // Only for development: show the popover straight away instead of waiting for ⌥Space.
    if (process.env.BISU_APP_SHOW) showPanel({capture: false});
  });

  app.on('will-quit', () => {
    quitting = true;
    globalShortcut.unregisterAll();
    clearInterval(watchTimer);
    if (engine) { try { engine.kill('SIGTERM') } catch {} }
  });
}

'use strict';
// bisu in the menu bar.
//
// One engine (ui/server.mjs, the same one `bisu ui` runs), started as a child process with the
// same key and models, and two windows onto it: a popover under the menu bar icon (⌥Space) and a
// full window for history and settings. The shell owns four things the browser page cannot:
// the frontmost app and selection as context, a tray icon, notifications when an approval is
// waiting, and staying alive with the engine between visits.
const {app, BrowserWindow, Tray, Menu, globalShortcut, screen, nativeImage, Notification, ipcMain, dialog, shell, nativeTheme, systemPreferences} = require('electron');
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
// A frameless window cannot be resized by its edges — macOS only gives frameless windows a drag
// area, and dragging the border moves the window instead. The panel therefore resizes from a grip
// the page draws, and these are the bounds that grip is held to.
const MIN_W = 380;
const MIN_H = 320;

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

// Launched from Finder there is no terminal to read, so everything worth diagnosing goes here.
let logFile = null;
function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(' ')}`;
  try {
    if (!logFile) logFile = path.join(app.getPath('logs'), 'bisu.log');
    fs.mkdirSync(path.dirname(logFile), {recursive: true});
    const st = fs.statSync(logFile, {throwIfNoEntry: false});
    if (st && st.size > 512 * 1024) fs.renameSync(logFile, logFile + '.1');
    fs.appendFileSync(logFile, line + '\n');
  } catch {}
  if (!app.isPackaged || process.env.BISU_DEBUG) console.error(line);
}

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
function run(cmd, args, timeout = 5000, env = null) {
  return new Promise(resolve => {
    const {execFile} = require('node:child_process');
    // SIGKILL, because a login shell can ignore SIGTERM and leave this promise pending forever,
    // and stdin ignored, because an interactive zsh with a pipe for stdin is unpredictable.
    execFile(cmd, args, {
      timeout, killSignal: 'SIGKILL', maxBuffer: 1 << 20, encoding: 'utf8',
      env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'],
    }, (err, stdout, stderr) => resolve({
      ok: !err, out: (stdout || '').trim(),
      err: err ? String((stderr || '').trim() || err.message || err).slice(0, 300) : null,
    }));
  });
}

// Where node, claude and dec-secret usually live. Finder and Spotlight start an app with almost
// no PATH, so the engine would not find any of them; these are found by reading the filesystem
// rather than by starting a shell, which cannot hang.
function versionManagers(home) {
  const out = [];
  const scan = (base, make) => {
    let names = [];
    try { names = fs.readdirSync(base) } catch { return }
    const byTime = names.map(n => {
      const p = path.join(base, n);
      let t = 0;
      try { t = fs.statSync(p).mtimeMs } catch {}
      return {p, t};
    }).sort((a, b) => b.t - a.t);
    // Newest first, and only the few newest: fnm leaves one directory per shell ever started.
    for (const {p} of byTime.slice(0, 8)) out.push(make(p));
  };
  scan(path.join(home, '.local', 'state', 'fnm_multishells'), p => path.join(p, 'bin', 'node'));
  scan(path.join(home, '.nvm', 'versions', 'node'), p => path.join(p, 'bin', 'node'));
  scan(path.join(home, '.asdf', 'installs', 'nodejs'), p => path.join(p, 'bin', 'node'));
  scan(path.join(home, '.local', 'share', 'mise', 'installs', 'node'), p => path.join(p, 'bin', 'node'));
  out.push(path.join(home, '.volta', 'bin', 'node'));
  return out;
}

function searchPath(nodeDir) {
  const home = os.homedir();
  const dirs = [];
  const add = d => { if (d && !dirs.includes(d)) dirs.push(d) };
  if (nodeDir) add(nodeDir);
  for (const d of ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local')]) add(d);
  for (const d of (process.env.PATH || '').split(':')) add(d);
  for (const d of ['/usr/bin', '/bin', '/usr/sbin', '/sbin']) add(d);
  return dirs.join(':');
}

let nodeBin = null;
async function resolveNode() {
  if (nodeBin) return nodeBin;
  const home = os.homedir();
  const tries = [];
  for (const d of (process.env.PATH || '').split(':')) if (d) tries.push(path.join(d, 'node'));
  tries.push('/opt/homebrew/bin/node', '/usr/local/bin/node', ...versionManagers(home));
  for (const c of tries) {
    if (!path.isAbsolute(c)) continue;
    try { fs.accessSync(c, fs.constants.X_OK) } catch { continue }
    const v = await run(c, ['-v'], 4000);
    if (v.ok && /^v\d+\./.test(v.out) && Number(v.out.slice(1).split('.')[0]) >= 18) { nodeBin = c; return c }
  }
  // Last resort: ask a non-interactive login shell, which cannot sit waiting for input.
  const sh = await run('/bin/zsh', ['-lc', 'command -v node'], 3000);
  const c = sh.ok ? sh.out.split('\n').pop().trim() : '';
  if (c && path.isAbsolute(c)) {
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

// How to launch the engine through dec-secret, or null. dec-secret's files live under ~/Desktop,
// which macOS refuses to let a Finder-launched app read (Privacy & Security → Files and Folders);
// install-app.sh keeps a readable copy in the app's support folder, and that copy is preferred.
// Only a dev run (started from a terminal, which already has access) may use the original.
function decPrefix(node) {
  const bridge = path.join(app.getPath('userData'), 'dec', 'sdk', 'dec-secret.mjs');
  if (fs.existsSync(bridge)) return {cmd: node, args: [bridge, 'run', '--', node, SERVER]};
  const shim = decSecret();
  if (shim && !app.isPackaged) return {cmd: shim, args: ['run', '--', node, SERVER]};
  return null;
}

async function startEngine() {
  if (engine) { try { engine.kill('SIGTERM') } catch {} engine = null }
  engineReady = false;
  const node = await resolveNode();
  const env = {...process.env, PATH: searchPath(path.dirname(node))};
  // A host app's Claude/Anthropic login would win over OpenRouter, and Electron's own
  // variables must not reach the plain Node engine.
  for (const k of Object.keys(env)) if (/^(CLAUDE|ANTHROPIC|ELECTRON_)/.test(k)) delete env[k];
  Object.assign(env, {BISU_UI_NO_OPEN: '1', BISU_UI_PORT: String(PORT), BISU_UI_TOKEN: TOKEN});

  let cmd = node, args = [SERVER];
  // Through dec-secret when it is installed: the app only ever holds a one-time token, never the
  // key. The reference is what bisu.zsh exports too, so both paths use the same stored credential.
  const dec = decPrefix(node);
  if (dec) {
    if (!/^dec:\/\//.test(env.OPENROUTER_API_KEY || '')) env.OPENROUTER_API_KEY = 'dec://OPENROUTER_API_KEY';
    cmd = dec.cmd;
    args = dec.args;
  } else if (!env.OPENROUTER_API_KEY) {
    throw Error('bisu could not reach dec-secret: macOS blocks the copy in ~/Desktop from a Finder-launched app. Run `bisu app install` in Terminal once to give it a readable copy.');
  }

  engineLog = '';
  log(`engine start: ${cmd} ${args.slice(0, 3).join(' ')}`);
  engine = spawn(cmd, args, {cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe']});
  engine.stdout.on('data', d => { engineLog = (engineLog + d).slice(-4000) });
  engine.stderr.on('data', d => { engineLog = (engineLog + d).slice(-4000); log('engine:', String(d).trim()) });
  engine.on('error', e => { engineLog += '\n' + e.message; log('engine spawn error:', e.message) });
  engine.on('exit', (code, signal) => {
    engineReady = false;
    engine = null;
    if (quitting) return;
    log(`engine exited (${signal || code})`);
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
        log('engine failed:', String(e.message || e));
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
    minWidth: MIN_W,
    minHeight: MIN_H,
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
    log('panel blur');
    hidePanel();
  });
  panel.on('resize', savePanelBounds);
  panel.on('move', () => {
    if (positioning || !panel || !panel.isVisible()) return;
    // Dragged by hand: remember that, so the next ⌥Space reopens where it was left
    // instead of snapping back under the icon.
    saveState({panelMoved: true});
    savePanelBounds();
  });
  panel.on('closed', () => { panel = null });
  harden(panel);
}

// True while the shell itself is placing the window, so its own setBounds/setPosition does not
// read as a drag.
let positioning = false;

// A size that fits both the minimums and the screen the panel is on, anchored at the top-left so
// the header never slides out from under the pointer mid-resize.
function clampSize({width, height, x, y}) {
  const area = screen.getDisplayMatching({x, y, width: 1, height: 1}).workArea;
  const maxW = Math.max(MIN_W, area.x + area.width - x - 8);
  const maxH = Math.max(MIN_H, area.y + area.height - y - 8);
  return {
    width: Math.round(Math.min(Math.max(width, MIN_W), maxW)),
    height: Math.round(Math.min(Math.max(height, MIN_H), maxH)),
  };
}

function placeAt(bounds) {
  if (!panel) return;
  const b = panel.getBounds();
  const next = {...b, ...bounds};
  const size = clampSize({width: next.width, height: next.height, x: next.x, y: next.y});
  const area = screen.getDisplayMatching(next).workArea;
  next.width = size.width;
  next.height = size.height;
  next.x = Math.round(Math.min(Math.max(next.x, area.x), area.x + area.width - next.width));
  next.y = Math.round(Math.min(Math.max(next.y, area.y), area.y + area.height - next.height));
  positioning = true;
  panel.setBounds(next);
  setTimeout(() => { positioning = false }, 200);
  log(`panel placed at ${next.x},${next.y} ${next.width}x${next.height}`);
}

let boundsTimer = null;
function savePanelBounds() {
  if (!panel) return;
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    if (!panel || !panel.isVisible()) return;
    const b = panel.getBounds();
    log(`panel at ${b.x},${b.y} ${b.width}x${b.height}`);
    saveState({panel: b});
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
  // The size is the person's too: once they resize, the panel keeps that size even though it goes
  // back under the icon.
  const want = saved && saved.width && saved.height ? clampSize({width: saved.width, height: saved.height, x: area.x, y: area.y}) : size;
  const t = tray.getBounds();
  let x = Math.round(t.x + t.width / 2 - want.width / 2);
  let y = Math.round(t.y + t.height + 6);
  if (!t.width) { x = Math.round(area.x + area.width - want.width - 12); y = Math.round(area.y + 8) }
  x = Math.max(area.x + 8, Math.min(x, area.x + area.width - want.width - 8));
  positioning = true;
  if (want.width !== size.width || want.height !== size.height) panel.setBounds({x, y, ...want}, false);
  else panel.setPosition(x, y, false);
  setTimeout(() => { positioning = false }, 200);
  log(`panel under icon at ${x},${y} ${want.width}x${want.height}`);
}

// Where the panel goes when it opens: under the icon until the person moves it, then wherever
// they left it (clamped onto a screen that still exists).
function placePanel() {
  if (!panel) return;
  const st = readState();
  if (st.panelMoved && st.panel && Number.isFinite(st.panel.x) && Number.isFinite(st.panel.y)) placeAt(st.panel);
  else positionPanel();
}

async function loadPanel() {
  if (!panel) createPanel();
  await panel.loadURL(panelURL());
}

async function showPanel({capture = true} = {}) {
  if (!engineReady) { await restartEngine('not ready'); if (!engineReady) return }
  if (!panel) { createPanel(); await loadPanel() }
  else if (activeChatId && !(panel.webContents.getURL() || '').includes(activeChatId)) await loadPanel();
  if (panel.isVisible()) { log('panel toggled off'); hidePanel(); return }
  // Clicking the menu bar icon blurs (and hides) the panel first; that click means "hide", not "show again".
  if (Date.now() - hiddenAt < 250) return;
  pendingContext = capture
    ? await withTimeout(ctx.capture({withSelection: readState().selection !== false, selfName: SELF}), 1600, null)
    : null;
  placePanel();
  panel.setOpacity(0);
  panel.show();
  panel.focus();
  panel.webContents.focus();
  fadePanelIn();
  panel.webContents.send('bisu:shown');
  if (pendingContext) panel.webContents.send('bisu:context', pendingContext);
}

// A short fade, because the window is opaque and would otherwise appear as a finished rectangle
// while the page is still coming back from a hidden state. Opacity is animated in the shell and the
// content in the page; neither is long enough to feel like waiting.
let fadeTimer = null;
function fadePanelIn() {
  clearInterval(fadeTimer);
  if (!panel || process.env.BISU_NO_ANIM) { panel?.setOpacity(1); return }
  let step = 0;
  fadeTimer = setInterval(() => {
    step++;
    if (!panel || panel.isDestroyed()) { clearInterval(fadeTimer); return }
    if (step >= 4) { clearInterval(fadeTimer); panel.setOpacity(1); return }
    panel.setOpacity(step / 4);
  }, 20);
}

function hidePanel() {
  if (!panel) return;
  clearInterval(fadeTimer);
  panel.setOpacity(1);
  log('panel hidden');
  panel.hide();
}

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
  panel.setOpacity(1);
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
    {
      label: 'Put the panel back under the icon',
      enabled: readState().panelMoved === true,
      click: () => {
        saveState({panelMoved: false, panel: null});
        positioning = true;
        if (panel && panel.isVisible()) positionPanel();
        setTimeout(() => { positioning = false }, 200);
      },
    },
    {type: 'separator'},
    {label: spend == null ? 'Spend: …' : `Today: $${spend.toFixed(2)}`, enabled: false},
    {type: 'separator'},
    {
      label: 'Read selected text (Accessibility)',
      type: 'checkbox',
      checked: readState().selection !== false,
      click: item => saveState({selection: item.checked}),
    },
    ...(axTrusted() ? [] : [{
      // Only when macOS has not granted it: a menu item that is always there would read as a
      // setting, and this is not a setting, it is a permission the person has to give once.
      label: 'Grant Accessibility access…',
      click: () => askForAccessibility(),
    }]),
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
    log(`tray at ${b.x},${b.y} ${b.width}x${b.height}`);
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

// ---- accessibility ----
// Reading the selection needs the Accessibility toggle in System Settings. macOS shows that dialog
// only once per app version; after a rebuild the toggle can even stay on while the new binary is
// still pending, so this reports the live answer rather than what was granted before.
function axTrusted() {
  if (process.platform !== 'darwin') return true;
  try { return systemPreferences.isTrustedAccessibilityClient(false) } catch { return true }
}

function askForAccessibility() {
  if (process.platform !== 'darwin') return;
  try {
    // true here is what makes macOS put up its own "grant access" dialog.
    if (!systemPreferences.isTrustedAccessibilityClient(true)) {
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    }
  } catch {}
}

// ---- ipc ----
ipcMain.handle('bisu:context', () => pendingContext);
ipcMain.handle('bisu:consume', () => { pendingContext = null; return true });
ipcMain.handle('bisu:selection-enabled', (_e, on) => {
  if (typeof on === 'boolean') saveState({selection: on});
  return readState().selection !== false;
});
// The grip in the page sends a size, not a delta: the window's own size is the source of truth,
// and sending a size keeps the two in step even when a frame is dropped.
ipcMain.handle('bisu:resize', (_e, {width, height} = {}) => {
  if (!panel) return null;
  const b = panel.getBounds();
  const next = clampSize({width: Number(width) || b.width, height: Number(height) || b.height, x: b.x, y: b.y});
  if (next.width === b.width && next.height === b.height) return b;
  panel.setSize(next.width, next.height, false);
  return panel.getBounds();
});
ipcMain.handle('bisu:accessibility', () => ({
  trusted: axTrusted(),
  enabled: readState().selection !== false,
  dismissed: readState().axDismissed === true,
}));
ipcMain.on('bisu:ax-dismiss', () => saveState({axDismissed: true}));
ipcMain.on('bisu:ax-grant', () => askForAccessibility());
ipcMain.on('bisu:session', (_e, {sessionId, cwd} = {}) => {
  if (sessionId && /^[0-9a-f-]{36}$/.test(sessionId)) saveState({sessionId, cwd: cwd || readState().cwd});
});
ipcMain.on('bisu:hide', hidePanel);
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
    log(`engine on ${BASE}, ${SHORTCUT} ${globalShortcut.isRegistered(SHORTCUT) ? 'ready' : 'unavailable'}`);
    log(`accessibility ${axTrusted() ? 'granted' : 'not granted (selection capture will be empty)'}`);

    try {
      await startEngine();
      const chat = await ensureChat();
      if (!chat) showError('No OpenRouter key. Save one for https://openrouter.ai in Dec, then restart.');
      await loadPanel();
    } catch (e) {
      log('boot failed:', String(e?.message || e));
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

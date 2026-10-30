'use strict';
// What the person was looking at when they called dec-intern: the frontmost app, the text they had
// selected, and the clipboard. All of it is read-only — the selection is read through the
// Accessibility API, so dec-intern never presses ⌘C, never touches the pasteboard and has nothing to
// restore. Both reads are optional: an app that does not expose its selection simply reports
// nothing, and everything else still works.
const {execFile} = require('node:child_process');

const OSASCRIPT = '/usr/bin/osascript';
const PBPASTE = '/usr/bin/pbpaste';
const LSAPPINFO = '/usr/bin/lsappinfo';

function run(cmd, args, timeout = 4000) {
  return new Promise(resolve => {
    execFile(cmd, args, {timeout, maxBuffer: 4 << 20, encoding: 'utf8'}, (err, stdout) => {
      resolve({ok: !err, out: stdout || '', err: err ? String(err.message || err) : null});
    });
  });
}

// AppleScript returns one line. Only the newline osascript appends is dropped, so a selection
// that really ends with a newline keeps it.
const chomp = s => String(s).replace(/\n$/, '');

// "LSDisplayName" of the frontmost application, or null. No permission needed.
async function frontApp() {
  const f = await run(LSAPPINFO, ['front']);
  const m = /ASN:\S+:/.exec(f.out);
  if (!m) return null;
  const i = await run(LSAPPINFO, ['info', '-only', 'name', m[0]]);
  const n = /"LSDisplayName"="(.*)"/.exec(i.out);
  return n ? n[1] : null;
}

async function clipboard() {
  const r = await run(PBPASTE);
  return r.ok ? chomp(r.out) : null;
}

// The focused UI element of the frontmost process, and its AXSelectedText. Needs Accessibility
// consent for the app running dec-intern; without it System Events answers with an error and we say so.
const SELECTION_SCRIPT = [
  'tell application "System Events"',
  '  set frontProc to first application process whose frontmost is true',
  '  try',
  '    set fe to value of attribute "AXFocusedUIElement" of frontProc',
  '  on error',
  '    return ""',
  '  end try',
  '  try',
  '    return value of attribute "AXSelectedText" of fe',
  '  on error',
  '    return ""',
  '  end try',
  'end tell',
].join('\n');

async function selection() {
  const r = await run(OSASCRIPT, ['-e', SELECTION_SCRIPT], 5000);
  if (!r.ok) {
    const denied = /not allowed|assistive access|1743|1002/i.test(r.err || '');
    return {selection: null, note: denied ? 'needs Accessibility consent' : 'could not read the selection'};
  }
  const text = chomp(r.out);
  return {selection: text.trim() ? text : null, note: text.trim() ? null : 'nothing was selected'};
}

const limit = (s, n = 6000) => (s == null ? null : s.length > n ? s.slice(0, n) : s);

// {app, selection, clipboard, note, at}
async function capture({withSelection = true, selfName = null} = {}) {
  const app = await frontApp();
  const own = selfName && app && app.toLowerCase() === selfName.toLowerCase();
  const clip = limit(await clipboard());
  let sel = {selection: null, note: null};
  if (withSelection && !own) sel = await selection();
  const selectionText = limit(sel.selection);
  return {
    app: own ? null : app,
    selection: selectionText,
    clipboard: clip && clip !== selectionText && clip.trim() ? clip : null,
    note: sel.note || null,
    at: Date.now(),
  };
}

module.exports = {capture, frontApp, clipboard, selection};

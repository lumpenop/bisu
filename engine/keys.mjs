// The person's API keys live in Dec (Dec Browser → 설정 → 자격 증명), and nothing here ever holds one. A program that
// needs a key is started through `dec-secret run` with a reference in its environment (OPENAI_API_KEY=dec://OPENAI_API_KEY):
// it gets a one-time token in that variable and a local base URL in <PREFIX>_BASE_URL, and Dec's helper adds the real key
// on the way out to the key's own site. The engine's own model keys come in the same way (bisu.zsh, mac/native/bisu.swift);
// this module is for the work bisu does for the person — running their project, calling an API with their key — and for
// knowing which keys exist (`dec-secret list`: names and sites, never values).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';

const SUPPORT = path.join(os.homedir(), 'Library', 'Application Support', 'bisu');
const SHIM = path.join(os.homedir(), '.local', 'bin', 'dec-secret');
// A readable copy of dec-secret for the menu-bar app (mac/install-app.sh): the original is under ~/Desktop on the
// development Mac, where a Finder-launched app may not read.
const BRIDGE = path.join(SUPPORT, 'dec', 'sdk', 'dec-secret.mjs');
const OUR_BIN = path.join(SUPPORT, 'dec', 'bin');

const exec = p => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile() } catch { return false } };

// How to run dec-secret here: {file, pre} (file = the command, pre = arguments before dec-secret's own), or null when
// Dec never installed it on this Mac. BISU_DEC_SECRET names one explicitly (the shim, or dec-secret.mjs). Inside the app
// (BISU_UI_PARENT=stdin) the bridged copy comes first, since the shim's original may be unreadable there.
export function decSecret() {
  const explicit = process.env.BISU_DEC_SECRET;
  const inApp = process.env.BISU_UI_PARENT === 'stdin';
  const order = [explicit, ...(inApp ? [BRIDGE, SHIM] : [SHIM, BRIDGE])].filter(Boolean);
  for (const c of order) {
    if (c.endsWith('.mjs')) { if (fs.existsSync(c)) return {file: process.execPath, pre: [c], path: c} }
    else if (exec(c)) return {file: c, pre: [], path: c};
  }
  return null;
}

// `dec-secret` callable by name from a shell command (run_command, Claude Code's Bash): the shim's folder on PATH, or a
// shim of bisu's own in front of the bridged copy. Once per process; nothing happens when there is no dec-secret.
let pathDone = false;
export function ensurePath() {
  if (pathDone) return; pathDone = true;
  const d = decSecret();
  if (!d) return;
  let dir = path.dirname(d.file);
  if (d.pre.length) {
    dir = OUR_BIN;
    const shim = path.join(dir, 'dec-secret'), body = `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(d.pre[0])} "$@"\n`;
    try {
      let cur = null; try { cur = fs.readFileSync(shim, 'utf8') } catch {}
      if (cur !== body) { fs.mkdirSync(dir, {recursive: true}); fs.writeFileSync(shim, body, {mode: 0o755}) }
      fs.chmodSync(shim, 0o755);
    } catch { return }
  }
  const parts = (process.env.PATH || '').split(':').filter(Boolean);
  if (!parts.includes(dir)) process.env.PATH = [dir, ...parts].join(':');
}

// The variable a key is handed in: its 「환경 변수 이름」 from Dec when it has one, else its name as a variable
// (OpenAI → OPENAI_API_KEY, "텔레그램 봇" has none). The base-URL variable follows dec-secret's rule.
export const envNameOf = k => k.env || (/^[A-Z_][A-Z0-9_]*$/.test(k.name) ? k.name : null) || (() => { const s = k.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, ''); return s && /^[A-Z]/.test(s) ? (/_(API_KEY|KEY|TOKEN)$/.test(s) ? s : `${s}_API_KEY`) : null })();
export const baseVarOf = v => v ? v.replace(/_(API_KEY|KEY|TOKEN)$/, '') + '_BASE_URL' : null;

// What `dec-secret list` prints, one key a line: `dec://NAME   https://site   (같은 키: dec://env/VAR)`.
export function parseList(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^dec:\/\/(\S+)\s+(\S+)(?:\s+\(.*?dec:\/\/env\/([A-Za-z_][A-Za-z0-9_]*)\))?/.exec(line.trim());
    if (!m) continue;
    let name = m[1]; try { name = decodeURIComponent(name) } catch {}
    const k = {ref: `dec://${m[1]}`, name, site: m[2], env: m[3] || null};
    k.var = envNameOf(k);
    out.push(k);
  }
  return out;
}

let cache = {at: 0, keys: null};
// The keys saved in Dec with a site (the only ones a program can use): names, sites, variable names. Works while Dec is
// closed. Cached half a minute: a turn that runs three commands asks dec-secret once.
export function list({fresh = false} = {}) {
  const d = decSecret();
  if (!d) return Promise.resolve({keys: [], missing: true});
  if (!fresh && cache.keys && Date.now() - cache.at < 30_000) return Promise.resolve({keys: cache.keys, missing: false});
  return new Promise(resolve => execFile(d.file, [...d.pre, 'list'], {timeout: 15_000, encoding: 'utf8', maxBuffer: 1 << 20}, (e, out) => {
    if (e) return resolve({keys: cache.keys || [], missing: false, error: String(e.message || e).split('\n')[0].slice(0, 200)});
    cache = {at: Date.now(), keys: parseList(out)};
    resolve({keys: cache.keys, missing: false});
  }));
}

// A key by what the model called it: its name, its variable, a dec:// reference, or its site's host.
export async function find(q) {
  const s = String(q || '').trim().replace(/^dec:\/\/(env\/)?/, '');
  if (!s) return null;
  const {keys} = await list();
  const low = s.toLowerCase();
  return keys.find(k => k.name.toLowerCase() === low || k.var === s.toUpperCase() || k.env === s)
    ?? keys.find(k => { try { return new URL(k.site).hostname === low || new URL(k.site).hostname.endsWith('.' + low) } catch { return false } })
    ?? keys.find(k => k.name.toLowerCase().includes(low) || (k.var || '').toLowerCase().includes(low))
    ?? null;
}

export const SAVE_HINT = 'Dec Browser → 설정 → 자격 증명에 그 이름으로, 사이트 주소와 함께 저장하고 「앱 밖에서도 쓰기」를 켜 주세요';

// A shell command started through dec-secret with these keys in its environment: {file, args, env, lines}, or
// {error} when a key is not in Dec or dec-secret is missing. `lines` is what dec-secret was told, for the approval card.
export async function wrap(command, names = []) {
  const d = decSecret();
  if (!d) return {error: 'dec-secret is not on this Mac: it comes with Dec Browser (open Dec once and it installs the command).'};
  const env = {}, lines = [];
  for (const n of names) {
    const k = await find(n);
    if (!k) { const {keys} = await list(); return {error: `No key called "${n}" in Dec. ${keys.length ? `Saved there: ${keys.map(x => `${x.var || x.name} (${x.site})`).join(', ')}.` : 'Nothing is saved there yet.'} Ask the person to save it (${SAVE_HINT}).`} }
    const v = k.var || String(n).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    env[v] = k.ref;
    lines.push(`${v} ← ${k.ref} (${k.site}; base url in ${baseVarOf(v)})`);
  }
  return {file: d.file, args: [...d.pre, 'run', '--', '/bin/zsh', '-c', String(command)], env, lines};
}

// For the settings page and the prompt: is dec-secret here, and which keys exist.
export async function status() {
  const d = decSecret();
  const r = await list();
  return {secret: d ? {path: d.path, bridged: d.pre.length > 0} : null, keys: r.keys.map(k => ({name: k.name, site: k.site, var: k.var})), error: r.error || null};
}

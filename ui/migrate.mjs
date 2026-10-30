// bisu became dec-intern on 2026-10-30. A Mac that ran bisu has its data under the old names: this moves it over, once,
// before anything else reads a path. Imported first by every entry point (ui/server.mjs, engine/cli.mjs, the prompt
// builders, the launchd tick, the MCP server), so the order of imports is the order of safety.
//
//   ~/.config/bisu                      → ~/.config/dec-intern   (memory, bots, jobs, profile, prefs, models, chats)
//   ~/Library/Application Support/bisu  → …/dec-intern           (system prompts, sessions, web shots, helpers, dec bridge)
//   ~/Library/Logs/bisu                 → …/dec-intern
//   models config: BISU_* lines         → DEC_INTERN_*
//   bots/bisu.md, `bot: bisu` in jobs, chats.json bot ids → dec-intern (the default bot's id)
//   launchd com.bisu.jobs               → removed; local.dec.intern.jobs is installed again when it was there
//
// Nothing is deleted: a folder is renamed, or, when the new one already exists (an app that made it before this ran),
// what the new one lacks is moved in and the rest stays in the old folder for a look by hand.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const HOME = os.homedir();
const CONFIG_ROOT = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
const PAIRS = [
  [path.join(CONFIG_ROOT, 'bisu'), path.join(CONFIG_ROOT, 'dec-intern')],
  [path.join(HOME, 'Library', 'Application Support', 'bisu'), path.join(HOME, 'Library', 'Application Support', 'dec-intern')],
  [path.join(HOME, 'Library', 'Logs', 'bisu'), path.join(HOME, 'Library', 'Logs', 'dec-intern')],
];
const log = (...a) => { if (process.env.DEC_INTERN_MIGRATE_QUIET !== '1') process.stderr.write('dec-intern: ' + a.join(' ') + '\n') };

function moveDir(from, to) {
  if (!fs.existsSync(from)) return false;
  if (!fs.existsSync(to)) { fs.renameSync(from, to); log(`moved ${from} → ${to}`); return true }
  // Both exist: fill in what the new one lacks; whatever clashes stays behind.
  let left = 0;
  for (const name of fs.readdirSync(from)) {
    const a = path.join(from, name), b = path.join(to, name);
    if (fs.existsSync(b)) { left++; continue }
    try { fs.renameSync(a, b) } catch { left++ }
  }
  if (!left) { try { fs.rmdirSync(from) } catch {} }
  log(`merged ${from} into ${to}${left ? ` (${left} left behind)` : ''}`);
  return true;
}

function rewrite(file, fn) {
  let s; try { s = fs.readFileSync(file, 'utf8') } catch { return }
  const t = fn(s);
  if (t !== s) fs.writeFileSync(file, t);
}

function run() {
  const [config] = PAIRS[0];
  const had = fs.existsSync(config) || fs.existsSync(PAIRS[1][0]);
  if (!had) return;
  for (const [from, to] of PAIRS) { try { moveDir(from, to) } catch (e) { log(`could not move ${from}: ${e.message}`) } }
  const cfg = PAIRS[0][1];
  // The saved models and settings used the old variable names.
  rewrite(path.join(cfg, 'models'), s => s.replace(/^BISU_/gm, 'DEC_INTERN_'));
  // The default bot's id.
  const bots = path.join(cfg, 'bots');
  try { if (fs.existsSync(path.join(bots, 'bisu.md')) && !fs.existsSync(path.join(bots, 'dec-intern.md'))) fs.renameSync(path.join(bots, 'bisu.md'), path.join(bots, 'dec-intern.md')) } catch {}
  rewrite(path.join(bots, 'dec-intern.md'), s => s.replace(/^name:\s*bisu\s*$/m, 'name: 덱 인턴'));
  try { for (const f of fs.readdirSync(path.join(cfg, 'jobs'))) if (f.endsWith('.md')) rewrite(path.join(cfg, 'jobs', f), s => s.replace(/^bot:\s*bisu\s*$/m, 'bot: dec-intern')) } catch {}
  rewrite(path.join(cfg, 'chats.json'), s => { try { const l = JSON.parse(s); if (!Array.isArray(l)) return s; for (const c of l) if (c && c.bot === 'bisu') c.bot = 'dec-intern'; return JSON.stringify(l) } catch { return s } });
  // launchd: the old label goes; the new one is installed again where the old one was.
  const oldPlist = path.join(HOME, 'Library', 'LaunchAgents', 'com.bisu.jobs.plist');
  if (fs.existsSync(oldPlist)) {
    try { execFileSync('/bin/launchctl', ['bootout', `gui/${process.getuid()}/com.bisu.jobs`], {stdio: 'ignore'}) } catch {}
    try { fs.unlinkSync(oldPlist) } catch {}
    try { execFileSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'jobs.mjs'), 'agent', 'install'], {stdio: 'ignore', env: {...process.env, DEC_INTERN_MIGRATE_QUIET: '1'}}) ; log('launchd agent reinstalled as local.dec.intern.jobs') } catch (e) { log(`launchd agent not reinstalled: ${e.message}`) }
  }
}

try { run() } catch (e) { log(`migration failed: ${e.message}`) }

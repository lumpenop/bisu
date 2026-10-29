// What the person wrote for coding agents in a folder: CLAUDE.md (and CLAUDE.local.md) in the folder and
// in every folder above it, plus ~/.claude/CLAUDE.md — the files Claude Code reads on its own. bisu's own
// engine is given them the same way, outermost first, so a chat, a job or a worker in that folder follows
// the folder's rules whichever engine runs it. A Claude Code chat gets nothing from here: claude already
// loads these itself, and twice would be noise. @imports and .claude/rules/ are not followed.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// On every request, so capped. The nearest file matters most: when they do not all fit, the outer ones
// are cut first.
export const LIMIT = Number(process.env.BISU_RULES_CHARS) || 12000;
const NAMES = ['CLAUDE.md', 'CLAUDE.local.md'];

const read = file => { try { const t = fs.readFileSync(file, 'utf8').trim(); return t ? { file, text: t } : null } catch { return null } };

// Outermost first: the global file, then from the root down to the folder itself.
export function files(cwd = process.cwd()) {
  const out = [];
  const home = os.homedir();
  const global = read(path.join(home, '.claude', 'CLAUDE.md'));
  if (global) out.push(global);
  const dirs = [];
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) { dirs.unshift(d); if (d === path.dirname(d)) break }
  for (const d of dirs) for (const n of NAMES) { const f = read(path.join(d, n)); if (f && !out.some(x => x.file === f.file)) out.push(f) }
  return out;
}

const short = p => p.startsWith(os.homedir()) ? '~' + p.slice(os.homedir().length) : p;
const TRUNC = '\n…(cut to fit)';

export function block(cwd = process.cwd(), limit = LIMIT) {
  const all = files(cwd);
  if (!all.length) return '';
  // Spend the room from the nearest file outward, then print outermost first.
  let room = limit;
  const kept = [];
  for (const f of [...all].reverse()) {
    const head = `### ${short(f.file)}\n`;
    if (room - head.length < 200) break;
    const text = f.text.length <= room - head.length ? f.text : f.text.slice(0, room - head.length - TRUNC.length).trimEnd() + TRUNC;
    room -= head.length + text.length + 2;
    kept.unshift(head + text);
  }
  const left = all.length - kept.length;
  return `## 프로젝트 규칙 (Project rules)\n` +
    `What the person wrote for coding agents working in this folder (CLAUDE.md), outermost first; where they differ, the nearest file wins. Follow it as their own words.\n\n` +
    kept.join('\n\n') + (left ? `\n\n(${left} ${kept.length ? 'outer ' : ''}file${left > 1 ? 's' : ''} left out for room: read ${all.slice(0, left).map(f => short(f.file)).join(', ')}.)` : '') + '\n';
}

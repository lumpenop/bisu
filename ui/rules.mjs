// What the person wrote for coding agents in a folder, the way Claude Code reads it: CLAUDE.md and
// CLAUDE.local.md in the folder and in every folder above it, the .claude/rules/ folders next to them,
// the global ~/.claude/CLAUDE.md and ~/.claude/rules/, and what those files pull in with @path. bisu's
// own engine is given them the same way, outermost first, so a chat, a job or a worker in that folder
// follows the folder's rules whichever engine runs it. A Claude Code chat gets nothing from here: claude
// already loads these itself, and twice would be noise.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// On every request, so capped. The nearest file matters most: when they do not all fit, the outer ones
// are cut first.
export const LIMIT = Number(process.env.BISU_RULES_CHARS) || 12000;
const NAMES = ['CLAUDE.md', 'CLAUDE.local.md'];
const IMPORT_DEPTH = 5;

const home = () => os.homedir();
const short = p => p.startsWith(home()) ? '~' + p.slice(home().length) : p;
const read = file => { try { if (!fs.statSync(file).isFile()) return null; const t = fs.readFileSync(file, 'utf8').trim(); return t ? { file, text: t } : null } catch { return null } };

// A rules file may start with frontmatter; `paths:` scopes it to some files, which a conversation has no
// single one of, so the scope is said rather than applied.
function rule(file) {
  const f = read(file);
  if (!f) return null;
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(f.text);
  if (!m) return f;
  const paths = [];
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^paths\s*:\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const inline = kv[1].trim();
    if (inline) paths.push(...inline.replace(/^\[|\]$/g, '').split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean));
    else for (let j = i + 1; j < lines.length && /^\s*-\s+/.test(lines[j]); j++) paths.push(lines[j].replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, ''));
  }
  const body = f.text.slice(m[0].length).trim();
  return { file, text: (paths.length ? `(Applies when working on files matching: ${paths.join(', ')})\n` : '') + body };
}

// Every .md under a rules folder, in name order, subfolders included.
function rulesDir(dir) {
  const out = [];
  const walk = d => {
    let names = [];
    try { names = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of names.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) { const r = rule(p); if (r) out.push(r) }
    }
  };
  walk(dir);
  return out;
}

// `@path` in a file pulls that file in (relative to the file, or ~/ or absolute), as claude does: not
// inside code, only when the path is a file, five levels deep at most, each file once.
function imports(f, seen, depth) {
  if (depth >= IMPORT_DEPTH) return [];
  const out = [];
  const text = f.text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  for (const m of text.matchAll(/(^|[\s(])@((?:~|\.{1,2})?\/[^\s)'"`]+|[\w.-]+\/[^\s)'"`]+|[\w.-]+\.md)/gm)) {
    let p = m[2].replace(/[.,;:]+$/, '');
    p = p.startsWith('~/') ? path.join(home(), p.slice(2)) : path.resolve(path.dirname(f.file), p);
    if (seen.has(p)) continue;
    const g = read(p);
    if (!g) continue;
    seen.add(p);
    out.push({ ...g, via: f.file }, ...imports(g, seen, depth + 1));
  }
  return out;
}

// Outermost first: the global files, then from the root down to the folder itself; after each file, what
// it imports.
export function files(cwd = process.cwd()) {
  const seen = new Set();
  const out = [];
  const add = f => { if (!f || seen.has(f.file)) return; seen.add(f.file); out.push(f, ...imports(f, seen, 0)) };
  add(read(path.join(home(), '.claude', 'CLAUDE.md')));
  for (const r of rulesDir(path.join(home(), '.claude', 'rules'))) add(r);
  const dirs = [];
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) { dirs.unshift(d); if (d === path.dirname(d)) break }
  for (const d of dirs) {
    for (const n of NAMES) add(read(path.join(d, n)));
    if (d !== home()) for (const r of rulesDir(path.join(d, '.claude', 'rules'))) add(r);
  }
  return out;
}

const TRUNC = '\n…(cut to fit)';

export function block(cwd = process.cwd(), limit = LIMIT) {
  const all = files(cwd);
  if (!all.length) return '';
  // Spend the room from the nearest file outward, then print outermost first.
  let room = limit;
  const kept = [];
  for (const f of [...all].reverse()) {
    const head = `### ${short(f.file)}${f.via ? ` (imported by ${short(f.via)})` : ''}\n`;
    if (room - head.length < 200) break;
    const text = f.text.length <= room - head.length ? f.text : f.text.slice(0, room - head.length - TRUNC.length).trimEnd() + TRUNC;
    room -= head.length + text.length + 2;
    kept.unshift(head + text);
  }
  const left = all.length - kept.length;
  return `## 프로젝트 규칙 (Project rules)\n` +
    `What the person wrote for coding agents working in this folder (CLAUDE.md, .claude/rules), outermost first; where they differ, the nearest file wins. Follow it as their own words.\n\n` +
    kept.join('\n\n') + (left ? `\n\n(${left} ${kept.length ? 'outer ' : ''}file${left > 1 ? 's' : ''} left out for room: read ${all.slice(0, left).map(f => short(f.file)).join(', ')}.)` : '') + '\n';
}

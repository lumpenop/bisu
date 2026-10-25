// bisu's memory: what the person should not have to say twice.
//
// A session forgets, so the durable things — how they want answers, their name, the folder a project
// lives in, a correction they made twice — live as one markdown file per memory in
// ~/.config/bisu/memory. That shape is deliberate:
//  * the assistant reads and writes them with the tools it already has (Read, Write, Edit, Bash), so
//    keeping something needs no new tool and no new process, and in `bisu ui` the write goes through
//    the ordinary approval card — the person sees the file before it exists;
//  * the person can open the folder in Finder and edit them by hand, or do it on the Memory tab;
//  * every new run gets them as a digest appended to its system prompt (launch.zsh), which is what
//    carries them across sessions and folders. There is no database and no background process.
//
//   node memory.mjs digest [chars]      # the block on its own
//   node memory.mjs prompt <prompt.md>  # prompt.md + that block, for --append-system-prompt-file
//   node memory.mjs                     # the folder and the digest, for a look by hand
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// The digest is on every request, so it is capped: memory is a few facts, not a diary. Pinned entries
// never fall off the end; the rest are taken newest first.
export const BUDGET = Number(process.env.BISU_MEMORY_CHARS) || 3000;
export const DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'bisu', 'memory');

// One memory, from the file and its stat. The first non-empty line is the title (`# 제목` or plain),
// the rest is the fact; frontmatter only carries `pin`.
function parse(id, raw, st) {
  const text = String(raw).replace(/\r\n/g, '\n');
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  let pin = false;
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const m = /^([a-z_]+)\s*:\s*(.*)$/.exec(line.trim());
      if (m && m[1] === 'pin') pin = /^(true|yes|1)$/i.test(m[2].trim());
    }
  }
  const lines = (fm ? text.slice(fm[0].length) : text).split('\n');
  const at = lines.findIndex(l => l.trim());
  if (at < 0) return null;
  const title = lines[at].replace(/^#+\s*/, '').trim().slice(0, 100);
  const body = lines.slice(at + 1).join('\n').trim();
  return { id, title, text: body, pin, created: Math.round(st.birthtimeMs || st.mtimeMs), updated: Math.round(st.mtimeMs) };
}

// Pinned first, then whichever was touched last — the order the digest spends its budget in.
export function list() {
  let names = [];
  try { names = fs.readdirSync(DIR) } catch { return [] }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const file = path.join(DIR, name);
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) continue;
      const e = parse(name.slice(0, -3), fs.readFileSync(file, 'utf8'), st);
      if (e && (e.title || e.text)) out.push(e);
    } catch {}
  }
  return out.sort((a, b) => (b.pin - a.pin) || (b.updated - a.updated));
}

// What a new run is given. Empty when there is nothing saved, so a first install pays nothing for it.
// A memory longer than the room left is cut down rather than dropped: the one failure this must not
// have is a long pinned memory making the block vanish, which leaves the model certain there is no
// memory at all. Anything that still does not fit is named in the trailing note, so the model knows
// to read the folder instead of assuming it has seen everything.
const MIN_CUT = 120; // a cut shorter than this says nothing worth the characters
const TRUNC = '…(cut to fit)';

function compose(budget) {
  const all = list();
  const blocks = [], cut = [];
  let used = 0;
  for (const e of all) {
    const head = `### ${e.title}\n`;
    const text = e.text || '(no detail)';
    const block = head + text + '\n';
    if (used + block.length <= budget) { used += block.length; blocks.push(block); continue }
    const room = budget - used - head.length - TRUNC.length - 1;
    if (room >= MIN_CUT) {
      const part = head + text.slice(0, room).trimEnd() + TRUNC + '\n';
      if (used + part.length <= budget) { used += part.length; blocks.push(part); continue }
    }
    cut.push(e.title);
  }
  return { all, blocks, cut, used };
}

// Titles, shortened, for the trailing note. Capped by characters rather than by count so the note
// cannot grow into the thing it is describing.
function brief(titles, cap = 240) {
  let names = '', shown = 0;
  for (const t of titles) {
    const name = t.length > 30 ? t.slice(0, 30) + '…' : t;
    if (shown && names.length + name.length > cap) break;
    names += (shown++ ? ', ' : '') + name;
  }
  return names + (shown < titles.length ? ', …' : '');
}

export function digest(budget = BUDGET) {
  const { blocks, cut, used } = compose(budget);
  if (!blocks.length) {
    // Nothing fitted at all, which with a sane budget means every memory is huge; still say that memory
    // exists, because saying nothing is the one answer that is certainly wrong.
    if (!cut.length) return '';
    return `## Memory (기억)\n` +
      `Facts the person asked you to keep from earlier sessions. None fit in ${budget} characters: ` +
      `${brief(cut, used ? 240 : 240)} — read ${DIR} before answering.\n`;
  }
  const more = cut.length
    ? `\n(${cut.length} more did not fit: ${brief(cut)} — read ${DIR} when they might matter.)\n`
    : '';
  return `## Memory (기억)\n` +
    `Facts the person asked you to keep from earlier sessions, newest first. Keep to them; do not repeat them back.\n\n` +
    blocks.join('\n') + more;
}

export function snapshot() {
  const { all, cut, used } = compose(BUDGET);
  return {
    dir: DIR,
    budget: BUDGET,
    // Counted the way the budget is spent, so "3,000 of 3,000" means nothing else fits.
    used,
    cut,
    entries: all,
    digest: digest(),
  };
}

// A readable file name, in the person's own script: "답변 방식" stays "답변-방식.md". Anything that is
// awkward in a path becomes a dash; the id is never taken from a request, only from readdir.
function slug(title) {
  return String(title).normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\s/\\:*?"<>|.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'memo';
}
function uniqueId(title) {
  const base = slug(title);
  let id = base;
  let n = 2;
  while (fs.existsSync(path.join(DIR, id + '.md'))) id = `${base}-${n++}`;
  return id;
}
function write(id, title, text, pin) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const file = path.join(DIR, id + '.md');
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, `---\npin: ${pin}\n---\n# ${title}\n${text ? '\n' + text + '\n' : ''}`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Create, edit, or re-pin. Anything left out of the request keeps its saved value, which is what lets
// the page flip `pin` without sending the text back.
export function save({ id, title, body, pin } = {}) {
  const old = id ? list().find(e => e.id === id) : null;
  if (id && !old) throw Object.assign(Error('no such memory: ' + id), { status: 404 });
  let t = String(title ?? old?.title ?? '').trim().slice(0, 100);
  let text = String(body ?? old?.text ?? '').trim();
  if (!t && !text) throw Object.assign(Error('a memory needs a title or some text'), { status: 400 });
  if (!t) {
    // No title given: the first line is the title, and it is removed from the body so it is not stored twice.
    const lines = text.split('\n');
    const at = lines.findIndex(l => l.trim());
    t = lines[at].replace(/^#+\s*/, '').trim().slice(0, 100) || 'memo';
    text = lines.filter((_, i) => i !== at).join('\n').trim();
  }
  const pinned = pin === undefined ? !!old?.pin : !!pin;
  write(old ? old.id : uniqueId(t), t, text, pinned);
  return snapshot();
}

export function remove(id) {
  const e = list().find(x => x.id === id);
  if (!e) throw Object.assign(Error('no such memory'), { status: 404 });
  fs.unlinkSync(path.join(DIR, e.id + '.md'));
  return snapshot();
}

// ---- command line, for launch.zsh ----
function main(argv) {
  const mode = argv[0];
  if (mode === 'digest') return process.stdout.write(digest(Number(argv[1]) || BUDGET));
  if (mode === 'prompt') {
    const base = fs.readFileSync(argv[1], 'utf8').trimEnd();
    const more = digest(Number(argv[2]) || BUDGET);
    return process.stdout.write(base + '\n' + (more ? '\n' + more : ''));
  }
  process.stdout.write(`${DIR}\n\n${digest() || '(nothing saved yet)\n'}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
